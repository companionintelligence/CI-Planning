import Router from '@koa/router';
import { eq, and, like, asc, lte, ne } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { taskToApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { setDependencies, getDependencies, blockedTaskIds, DependencyCycleError } from '../engine/deps.js';
import { parseQuick } from '../engine/quickadd.js';
import { enrichQuick } from '../agents/quickadd.js';
import { suggestTags } from '../agents/tags.js';
import { startTimer, stopTimer, getRunning } from '../services/timer.js';
import { parseRule } from '../engine/recurrence.js';
import { generateRecurrences, ownerTimezone } from '../engine/recurrence-generate.js';
import { rescheduleTask } from '../engine/review.js';
import { requestReplan } from '../engine/auto-defense.js';
import { skipInstance, computeStreak, resolveTemplateId, deleteFutureOpenInstances } from '../engine/recurrence-ops.js';
import { syncTaskReminders } from '../engine/reminders.js';
import { syncBlockFromTask } from '../services/block-task-sync.js';
import { ensureTaskPromoted, firstObjectiveByTaskIds, unpromoteIfEmpty, dropSourceObjective, recomputeObjectivesForTask } from '../services/task-promotion.js';
import { ensureHabitPattern } from '../services/patterns.js';
import { taskTagNames, taskTagNamesByIds, taskSecondaryTagNamesByIds, entityTagLevels, syncLeveledEntityTags } from '../services/tags.js';
import { utcDayBounds } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';

export function tasksRouter() {
  const router = new Router();

  // GET /api/tasks
  router.get('/api/tasks', async (ctx) => {
    const { status, owner_id, tag, q, due_before, priority, include_fast } = ctx.query as Record<string, string>;

    let rows = db.select().from(tasks);

    // Build WHERE conditions
    const conditions = [];
    if (status)    conditions.push(eq(tasks.status, status));
    if (owner_id)  conditions.push(eq(tasks.ownerId, owner_id));
    if (priority)  conditions.push(eq(tasks.priority, Number(priority)));
    if (due_before) conditions.push(lte(tasks.dueAt, due_before));
    if (q)         conditions.push(like(tasks.title, `%${q}%`));
    // Fast tasks are ritual-local — hidden from the list unless explicitly requested.
    // Filter on the canonical subtype (W1-A); equivalent to the is_fast_task alias.
    if (include_fast !== '1') conditions.push(ne(tasks.subtype, 'quick'));

    const result = conditions.length
      ? await rows.where(and(...conditions)).orderBy(asc(tasks.priority), asc(tasks.dueAt))
      : await rows.orderBy(asc(tasks.priority), asc(tasks.dueAt));

    // Attach tags + dependency info, serialize to snake_case
    const blocked = blockedTaskIds();
    const ids = result.map((t) => t.id);
    const tagsById = taskTagNamesByIds(ids);
    const secondaryById = taskSecondaryTagNamesByIds(ids);
    const objectiveById = firstObjectiveByTaskIds(ids); // §I: drives the 8-pointed star + its link target
    const withTags = result.map((t) => ({
      ...taskToApi(t),
      tags: tagsById.get(t.id) ?? [],
      secondary_tags: secondaryById.get(t.id) ?? [],
      depends_on: getDependencies(t.id),
      blocked: blocked.has(t.id),
      objective_id: objectiveById.get(t.id) ?? null,
    }));

    // Filter by tag after attachment (simple approach for v1)
    const filtered = tag
      ? withTags.filter((t) => (t.tags as string[]).includes(tag))
      : withTags;

    ctx.body = { tasks: filtered };
  });

  // POST /api/tasks
  router.post('/api/tasks', async (ctx) => {
    const body = ctx.request.body as {
      title: string;
      description?: string;
      notes?: string;
      due_at?: string;
      scheduled_for?: string;
      defer_until?: string;
      task_time?: string;
      estimated_minutes?: number;
      priority?: number;
      owner_id?: string;
      parent_id?: string;
      tags?: string[];
      secondary_tags?: string[];
      depends_on?: string[];
      recurrence_rule?: string;
      recurrence_dtstart?: string;
      is_habit?: boolean;
      subtype?: Subtype;
    };

    if (!body.title?.trim()) {
      ctx.status = 400;
      ctx.body = { error: 'title is required' };
      return;
    }

    // CON-2c: resolve subtype ⇄ is_habit/is_fast_task once for both create paths.
    const sw = subtypeWrite(body);

    // Recurring task → create a TEMPLATE (status 'recurring', never scheduled
    // directly) and materialize its instances now so the series appears immediately.
    if (body.recurrence_rule) {
      const parsed = parseRule(body.recurrence_rule);
      if (!parsed.ok) {
        ctx.status = 422;
        ctx.body = { error: parsed.error };
        return;
      }
      const owner = body.owner_id ?? currentOwnerId();
      const tz = ownerTimezone(owner);
      const [template] = await db
        .insert(tasks)
        .values({
          title: body.title.trim(),
          notes: body.notes,
          taskTime: body.task_time,
          estimatedMinutes: body.estimated_minutes,
          priority: body.priority ?? 3,
          status: 'recurring',
          recurrenceRule: parsed.rule,
          recurrenceDtstart: body.recurrence_dtstart ?? utcDayBounds(localISODate(), tz).start,
          ownerId: owner,
          ...(sw ?? {}),
        })
        .returning();
      if (body.tags !== undefined || body.secondary_tags !== undefined)
        applyTaskTagLevels(template.id, { tags: body.tags, secondary: body.secondary_tags });
      // Bridge: a habit task is also represented as a Habit-type Pattern (G2/E′).
      if (sw?.subtype === 'habit') ensureHabitPattern(template.id, owner, template.title);
      const generated = generateRecurrences();
      const out = { ...taskToApi(template), tags: body.tags ?? [], secondary_tags: taskSecondaryTags(template.id), depends_on: [] as string[], blocked: false };
      broadcast(currentOwnerId(), 'task:created', out);
      writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `task:${template.id}` });
      broadcast(currentOwnerId(), 'recurrence:generated', generated);
      ctx.status = 201;
      ctx.body = { task: out, generated };
      return;
    }

    const [task] = await db
      .insert(tasks)
      .values({
        title: body.title.trim(),
        description: body.description,
        notes: body.notes,
        dueAt: body.due_at,
        scheduledFor: body.scheduled_for,
        deferUntil: body.defer_until,
        taskTime: body.task_time,
        estimatedMinutes: body.estimated_minutes,
        priority: body.priority ?? 3,
        parentId: body.parent_id,
        ownerId: body.owner_id ?? currentOwnerId(),
        ...(sw ?? {}),
      })
      .returning();

    if (body.tags !== undefined || body.secondary_tags !== undefined)
      applyTaskTagLevels(task.id, { tags: body.tags, secondary: body.secondary_tags });
    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, task.id, body.depends_on)) return;
    syncTaskReminders(currentOwnerId(), task.id); // Phase H (b): derive reminders from due_at + Reminder Defaults
    // §H: creating a subtask promotes its parent to an objective (task list star).
    if (body.parent_id) ensureTaskPromoted(body.parent_id, body.owner_id ?? currentOwnerId());

    const out = {
      ...taskToApi(task),
      tags: body.tags ?? [],
      secondary_tags: taskSecondaryTags(task.id),
      depends_on: getDependencies(task.id),
      blocked: blockedTaskIds().has(task.id),
    };
    broadcast(currentOwnerId(), 'task:created', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `task:${task.id}` });
    requestReplan('task:created'); // B2: a new task can shift today's plan (debounced + toggle-gated)
    ctx.status = 201;
    ctx.body = { task: out };
  });

  // POST /api/tasks/quick — natural-language quick add (deterministic + optional AI)
  router.post('/api/tasks/quick', async (ctx) => {
    const text = (ctx.request.body as { text?: string })?.text?.trim();
    if (!text) {
      ctx.status = 400;
      ctx.body = { error: 'text is required' };
      return;
    }

    const parsed = parseQuick(text); // deterministic, always succeeds
    let enriched = parsed;
    let llm = false;
    try {
      enriched = await enrichQuick(text, parsed); // Ollama overlay; never overrides parsed fields
      llm = true;
    } catch {
      /* OllamaUnavailable / bad JSON → keep the deterministic parse */
    }

    const [task] = await db
      .insert(tasks)
      .values({
        title: enriched.title,
        dueAt: enriched.dueAt,
        scheduledFor: enriched.scheduledFor,
        taskTime: enriched.taskTime,
        estimatedMinutes: enriched.estimatedMinutes,
        priority: enriched.priority ?? 3,
        ownerId: currentOwnerId(),
      })
      .returning();

    if (enriched.tags.length) applyTaskTagLevels(task.id, { tags: enriched.tags });
    syncTaskReminders(currentOwnerId(), task.id); // Phase H (b): quick-add may parse a due date

    const out = { ...taskToApi(task), tags: enriched.tags, secondary_tags: taskSecondaryTags(task.id), depends_on: [] as number[], blocked: false, llm };
    broadcast(currentOwnerId(), 'task:created', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `task:${task.id}` });
    ctx.status = 201;
    ctx.body = { task: out, parsed: enriched, llm };
  });

  // GET /api/tasks/:id/subtasks
  router.get('/api/tasks/:id/subtasks', async (ctx) => {
    const parentId = ctx.params.id;
    const result = await db.select().from(tasks).where(eq(tasks.parentId, parentId)).orderBy(asc(tasks.priority));
    const ids = result.map((t) => t.id);
    const tagsById = taskTagNamesByIds(ids);
    const secondaryById = taskSecondaryTagNamesByIds(ids);
    const objectiveById = firstObjectiveByTaskIds(ids); // §I: subtasks of a promoted parent are linked too — show their star
    const withTags = result.map((t) => ({
      ...taskToApi(t),
      tags: tagsById.get(t.id) ?? [],
      secondary_tags: secondaryById.get(t.id) ?? [],
      objective_id: objectiveById.get(t.id) ?? null,
    }));
    ctx.body = { subtasks: withTags };
  });

  // POST /api/tasks/:id/skip — skip a recurring instance: mark it `skipped` and
  // add its day to the template's EXDATE so a regenerate won't resurrect it.
  router.post('/api/tasks/:id/skip', async (ctx) => {
    const id = ctx.params.id;
    const res = skipInstance(id);
    if (!res.ok) {
      ctx.status = res.reason === 'not_found' ? 404 : 400;
      ctx.body = { error: res.reason === 'not_found' ? 'not found' : 'not a recurring instance' };
      return;
    }
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    const out = { ...taskToApi(task), tags: [] as string[], depends_on: [] as number[], blocked: false };
    broadcast(currentOwnerId(), 'task:updated', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'skip', entity: `task:${id}` });
    ctx.body = { task: out, skipped: res.date };
  });

  // GET /api/tasks/:id/streak — habit streak + last-7 occurrence strip for a
  // recurring task (pass a template or any instance id). 404 if not recurring.
  router.get('/api/tasks/:id/streak', async (ctx) => {
    const res = computeStreak(ctx.params.id);
    if (!res) { ctx.status = 404; ctx.body = { error: 'not a recurring task' }; return; }
    ctx.body = res;
  });

  // PATCH /api/tasks/:id
  // POST /api/tasks/:id/promote-habit — make a (possibly fast/ritual-local) task a
  // habit: flag it, drop fast-task hiding, and ensure its Habit-type pattern (G2).
  router.post('/api/tasks/:id/promote-habit', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const [task] = await db
      .update(tasks)
      .set({ subtype: 'habit' })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ensureHabitPattern(id, task.ownerId ?? owner, task.title);
    const out = { ...taskToApi(task), tags: taskTagNames(id), depends_on: getDependencies(id) };
    broadcast(owner, 'task:updated', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'promote', entity: `task:${id}` });
    broadcast(owner, 'pattern:updated', { id });
    ctx.body = { task: out };
  });

  // POST /api/tasks/suggest-tags { title } → { tags } — best-effort LLM auto-tag for
  // the New Task wizard, constrained to existing tags. Returns [] when Ollama is down
  // (the client still has its offline heuristic). Literal path; no clash with /:id/*.
  router.post('/api/tasks/suggest-tags', async (ctx) => {
    const { title } = (ctx.request.body ?? {}) as { title?: string };
    const vocab = (sqlite.prepare('SELECT name FROM tags ORDER BY name').all() as { name: string }[]).map((r) => r.name);
    const tags = await suggestTags(title ?? '', vocab);
    ctx.body = { tags };
  });

  // POST /api/tasks/:id/recall — clone a (usually shelved/Past) task to a brand-new
  // task (new id): carries title/tags/estimate/notes/subtype + subtasks (recursively,
  // reset to open); Routine membership only when prefs.recall_keeps_pattern. Fresh
  // dates/status; no recurrence or history. cockpit-v2 Phase 6.
  router.post('/api/tasks/:id/recall', async (ctx) => {
    const owner = currentOwnerId();
    if (!sqlite.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(ctx.params.id, owner)) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    const keepPattern = !!(sqlite.prepare('SELECT recall_keeps_pattern AS v FROM scheduling_prefs WHERE owner_id = ?').get(owner) as { v: number } | undefined)?.v;

    // Recursively clone a task + its subtree (better-sqlite3 is synchronous). The top
    // clone is a fresh independent task (parent_id null); uuid7() mints each new id.
    const cloneTree = (srcId: string, parentId: string | null): string => {
      const s = sqlite.prepare(
        'SELECT title, description, notes, estimated_minutes, priority, task_time, subtype, source_kind FROM tasks WHERE id = ?'
      ).get(srcId) as {
        title: string; description: string | null; notes: string | null;
        estimated_minutes: number | null; priority: number | null; task_time: string | null;
        subtype: string | null; source_kind: string | null;
      };
      const st = s.subtype ?? 'standard';
      const newId = (sqlite.prepare(
        `INSERT INTO tasks (id, title, description, notes, estimated_minutes, priority, task_time, subtype, parent_id, owner_id, status, source_kind)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?) RETURNING id`
      ).get(s.title, s.description, s.notes, s.estimated_minutes, s.priority ?? 3, s.task_time, st, parentId, owner, s.source_kind ?? 'manual') as { id: string }).id;
      // Carry tags (entity_tags, all levels); Routine membership only when the pref is on.
      sqlite.prepare("INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) SELECT 'task', ?, tag_id, level FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ?").run(newId, srcId);
      if (keepPattern) {
        sqlite.prepare('INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) SELECT pattern_id, ?, position FROM pattern_tasks WHERE task_id = ?').run(newId, srcId);
      }
      for (const k of sqlite.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(srcId) as { id: string }[]) {
        cloneTree(k.id, newId);
      }
      return newId;
    };

    // Atomic: a partway failure must not leave a half-built clone subtree.
    const newId = sqlite.transaction(() => cloneTree(ctx.params.id, null))();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, newId));
    const out = { ...taskToApi(task), tags: taskTagNames(newId), secondary_tags: taskSecondaryTags(newId), depends_on: [] as string[], blocked: false };
    broadcast(owner, 'task:created', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'recall', entity: `task:${newId}` });
    ctx.status = 201;
    ctx.body = { task: out };
  });

  // POST /api/tasks/:id/reschedule { days } — bump a missed/planned task `days`
  // out from today (the +1/+3/+7 buttons on the Missed review surface). Clears
  // 'missed', increments defer_count, drops stale blocks so it re-places cleanly.
  router.post('/api/tasks/:id/reschedule', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { days?: number };
    if (typeof body.days !== 'number') { ctx.status = 422; ctx.body = { error: 'days is required' }; return; }
    if (!sqlite.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, owner)) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    const { scheduled_for } = rescheduleTask(id, body.days);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    const out = { ...taskToApi(task), tags: taskTagNames(id), depends_on: getDependencies(id) };
    broadcast(owner, 'task:updated', out);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reschedule', entity: `task:${id}` });
    broadcast(owner, 'block:updated', { rescheduled: id });
    ctx.body = { task: out, scheduled_for };
  });

  router.patch('/api/tasks/:id', async (ctx) => {
    const id = ctx.params.id;
    // Accept both snake_case (client/API convention) and camelCase (drizzle) field names.
    const body = (ctx.request.body ?? {}) as {
      title?: string;
      description?: string | null;
      notes?: string | null;
      due_at?: string | null;
      dueAt?: string | null;
      scheduled_for?: string | null;
      defer_until?: string | null;
      task_time?: string | null;
      estimated_minutes?: number | null;
      estimatedMinutes?: number | null;
      priority?: number;
      status?: string;
      completed?: boolean;
      completed_at?: string | null;
      parent_id?: string | null;
      tags?: string[];
      secondary_tags?: string[];
      depends_on?: string[];
      recurrence_rule?: string | null;
      recurrence_dtstart?: string | null;
      is_habit?: boolean;
      subtype?: Subtype;
    };

    // scope=series edits the whole recurring series (the template); scope=instance
    // (default) edits just this row. For a non-recurring task the two coincide.
    const scope = (ctx.query.scope as string) === 'series' ? 'series' : 'instance';
    const targetId = scope === 'series' ? (resolveTemplateId(id) ?? id) : id;

    // Capture the pre-edit parent so a re-parent can GC the OLD parent's auto-objective
    // if this was its last subtask.
    const prevParentId = body.parent_id !== undefined
      ? (sqlite.prepare(`SELECT parent_id FROM tasks WHERE id = ?`).get(targetId) as { parent_id: string | null } | undefined)?.parent_id ?? null
      : null;

    const update: Partial<typeof tasks.$inferInsert> = {};
    if (body.title !== undefined)             update.title = body.title;
    if (body.description !== undefined)       update.description = body.description;
    if (body.notes !== undefined)             update.notes = body.notes;
    if (body.due_at !== undefined)            update.dueAt = body.due_at;
    if (body.dueAt !== undefined)             update.dueAt = body.dueAt;
    if (body.scheduled_for !== undefined)     update.scheduledFor = body.scheduled_for;
    if (body.defer_until !== undefined)       update.deferUntil = body.defer_until;
    if (body.task_time !== undefined)         update.taskTime = body.task_time;
    if (body.estimated_minutes !== undefined) update.estimatedMinutes = body.estimated_minutes;
    if (body.estimatedMinutes !== undefined)  update.estimatedMinutes = body.estimatedMinutes;
    if (body.priority !== undefined)          update.priority = body.priority;
    if (body.status !== undefined)            update.status = body.status;
    if (body.completed_at !== undefined)      update.completedAt = body.completed_at;
    if (body.parent_id !== undefined)         update.parentId = body.parent_id;
    const sw = subtypeWrite(body);
    if (sw) update.subtype = sw.subtype;
    if (body.recurrence_dtstart !== undefined) update.recurrenceDtstart = body.recurrence_dtstart;
    if (body.completed)                       { update.status = 'done'; update.completedAt = new Date().toISOString(); }

    // A recurrence-rule change is validated; an invalid rule is a 422, never a 500.
    if (body.recurrence_rule !== undefined) {
      if (body.recurrence_rule === null) {
        update.recurrenceRule = null;
      } else {
        const parsed = parseRule(body.recurrence_rule);
        if (!parsed.ok) { ctx.status = 422; ctx.body = { error: parsed.error }; return; }
        update.recurrenceRule = parsed.rule;
      }
    }

    // Only issue an UPDATE when there are column changes; a tags/depends-only
    // PATCH still resolves the task (drizzle rejects an empty .set()).
    const [task] = Object.keys(update).length
      ? await db.update(tasks).set(update).where(eq(tasks.id, targetId)).returning()
      : await db.select().from(tasks).where(eq(tasks.id, targetId));
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // Phase L: stamp version/field_ts so concurrent sync ops from other devices
    // compare correctly against this online edit using field-level LWW.
    if (Object.keys(update).length > 0) {
      stampRow(sqlite, 'task', targetId, Object.keys(update));
    }

    if (Array.isArray(body.tags) || Array.isArray(body.secondary_tags)) {
      // Partial: an omitted level is preserved (mirrors the block PATCH semantics).
      applyTaskTagLevels(targetId, { tags: body.tags, secondary: body.secondary_tags });
    }

    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, targetId, body.depends_on)) return;
    syncTaskReminders(currentOwnerId(), targetId); // Phase H (b): re-derive if due_at changed
    // §H: re-parenting a task UNDER another promotes that parent to an objective; moving
    // it AWAY may leave the old parent empty → GC that parent's pristine auto-objective.
    if (body.parent_id) ensureTaskPromoted(body.parent_id, currentOwnerId());
    if (body.parent_id !== undefined && prevParentId && prevParentId !== body.parent_id) {
      unpromoteIfEmpty(prevParentId, currentOwnerId());
    }

    // REQ2 (reverse sync): editing a task's time/day/estimate moves its placed block in
    // lockstep. Instance scope only — a series edit re-materializes instances below.
    const estimateChanged = body.estimated_minutes !== undefined || body.estimatedMinutes !== undefined;
    if (
      scope === 'instance' &&
      (body.scheduled_for !== undefined || body.task_time !== undefined || estimateChanged)
    ) {
      const movedBlock = syncBlockFromTask(targetId, currentOwnerId(), { resizeToEstimate: estimateChanged });
      if (movedBlock) broadcast(currentOwnerId(), 'block:updated', { id: movedBlock });
    }

    // A series edit that changes the recurrence pattern or per-instance time drops
    // future un-actioned instances and re-materializes them under the new rule;
    // past / completed / skipped / missed instances are preserved.
    let generated: ReturnType<typeof generateRecurrences> | undefined;
    if (
      scope === 'series' &&
      resolveTemplateId(targetId) != null &&
      (body.recurrence_rule !== undefined || body.recurrence_dtstart !== undefined || body.task_time !== undefined)
    ) {
      deleteFutureOpenInstances(targetId);
      generated = generateRecurrences();
    }

    // Phase O · O0 — two-way completion: when a task a today-intention links to is
    // completed, auto-stamp that reflection's done_at so S1 (the Intention star)
    // lights up without a second click. A task is at most one focus, so matching by
    // (source_kind='task', source_ref) is exact — no need to reconstruct the day
    // from a completion timestamp. COALESCE preserves an already-set done_at.
    if (task.status === 'done') {
      const now = new Date().toISOString();
      const completedAt = typeof body.completed_at === 'string' && body.completed_at ? body.completed_at : now;
      const periodKey = completedAt.slice(0, 10);
      sqlite
        .prepare(
          `UPDATE reflections SET done_at = COALESCE(done_at, ?), updated_at = ?
             WHERE owner_id = ? AND kind = 'today_goal' AND period_key = ? AND position = 0
               AND source_kind = 'task' AND source_ref = ?`,
        )
        .run(now, now, currentOwnerId(), periodKey, targetId);
    }

    const currentTags = taskTagNames(targetId);
    const out = {
      ...taskToApi(task),
      tags: currentTags,
      secondary_tags: taskSecondaryTags(targetId),
      depends_on: getDependencies(targetId),
      blocked: blockedTaskIds().has(targetId),
    };
    broadcast(currentOwnerId(), 'task:updated', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `task:${targetId}` });
    if (generated) broadcast(currentOwnerId(), 'recurrence:generated', generated);
    requestReplan('task:updated'); // B2: edits to priority/due/estimate can re-order the day
    ctx.body = { task: out, ...(generated ? { generated } : {}) };
  });

  // DELETE /api/tasks/:id  (soft delete)
  router.delete('/api/tasks/:id', async (ctx) => {
    const id = ctx.params.id;
    const [task] = await db
      .update(tasks)
      .set({ status: 'cancelled' })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    syncTaskReminders(currentOwnerId(), id); // Phase H (b): a cancelled task drops its auto reminders
    // Objectives upkeep: drop the objective this task spawned (if pristine); if it was a
    // subtask, GC its parent's objective when now empty; and reflect the cancel in any
    // objective still linking it so progress doesn't count the abandoned task.
    dropSourceObjective(id, currentOwnerId());
    if (task.parentId) unpromoteIfEmpty(task.parentId, currentOwnerId());
    recomputeObjectivesForTask(id);
    const out = { ...taskToApi(task), tags: [] as string[] };
    broadcast(currentOwnerId(), 'task:updated', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `task:${id}` });
    requestReplan('task:deleted'); // B2: a cancelled task frees its slot — re-pack the day
    ctx.body = { task: out };
  });

  // POST /api/tasks/:id/timer/start — start a timer (optionally linked to a block).
  // Stops any running timer first (one per owner); broadcasts the superseded
  // entry's stop, then the new start. 201 with the new entry.
  router.post('/api/tasks/:id/timer/start', async (ctx) => {
    const taskId = ctx.params.id;
    const blockId = (ctx.request.body as { block_id?: number } | undefined)?.block_id;
    const { entry, stopped } = startTimer(taskId, blockId);
    const owner = currentOwnerId();
    if (stopped) {
      broadcast(owner, 'timer:stopped', stopped.entry); // the superseded one
      if (stopped.overran) broadcast(owner, 'block:updated', { id: stopped.entry.block_id });
    }
    broadcast(owner, 'timer:started', entry);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'timer:start', entity: `task:${taskId}` });
    ctx.status = 201;
    ctx.body = { entry };
  });

  // POST /api/tasks/:id/timer/stop — stop the (single) running timer. 409 when
  // none is running (deterministic, safe for a double-click). :id is ignored —
  // there is only ever one running entry per owner.
  router.post('/api/tasks/:id/timer/stop', async (ctx) => {
    const res = stopTimer();
    if (!res) {
      ctx.status = 409;
      ctx.body = { error: 'no running timer' };
      return;
    }
    const owner = currentOwnerId();
    broadcast(owner, 'timer:stopped', res.entry);
    broadcast(owner, 'task:updated', { id: res.taskId, actual_minutes: res.actualMinutes });
    if (res.overran) {
      broadcast(owner, 'block:updated', { id: res.entry.block_id });
      // §C1 (docs/M-ai-scheduler.md:322): an overrun shifts the day's obstacles — request a
      // reactive reflow so the remaining blocks re-pack around the long-running one
      // (debounced + toggle-gated; never throws into this handler).
      requestReplan('overrun', owner);
    }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'timer:stop', entity: `task:${res.taskId}` });
    ctx.body = { entry: res.entry, actual_minutes: res.actualMinutes };
  });

  // GET /api/timer — the current running entry (for reload/restart recovery), or null.
  router.get('/api/timer', async (ctx) => {
    ctx.body = { entry: getRunning(currentOwnerId()) ?? null };
  });

  return router;
}

type Subtype = 'standard' | 'habit' | 'quick';

/**
 * Resolve the canonical `subtype` from a PATCH/POST body. Accepts the legacy
 * `is_habit` field for backward compat (clients can still send it; the column
 * was dropped in 0048). Returns null when neither field was supplied.
 */
function subtypeWrite(body: { subtype?: Subtype; is_habit?: boolean }): { subtype: Subtype } | null {
  const subtype: Subtype | undefined =
    body.subtype !== undefined ? body.subtype : body.is_habit !== undefined ? (body.is_habit ? 'habit' : 'standard') : undefined;
  if (subtype === undefined) return null;
  return { subtype };
}

/** Replace a task's blockers; on a cycle, respond 409 and return false. */
function applyDependencies(ctx: { status: number; body: unknown }, taskId: string, dependsOn: string[]): boolean {
  try {
    setDependencies(taskId, dependsOn);
    return true;
  } catch (err) {
    if (err instanceof DependencyCycleError) {
      ctx.status = 409;
      ctx.body = { error: 'dependency cycle', detail: err.message };
      return false;
    }
    throw err;
  }
}

/**
 * Sync a task's leveled tags (Phase 5): primary tags (the home/work/community
 * direction + any intention tags) at level 1, secondary tags at level 2. A field
 * left `undefined` (a partial PATCH) preserves that level's existing tags. Names
 * are resolve-or-created + normalized by syncLeveledEntityTags. Mirrors
 * applyBlockTagLevels in routes/blocks.ts so tasks + blocks behave identically.
 */
function applyTaskTagLevels(taskId: string, opts: { tags?: string[]; secondary?: string[] }): void {
  const existing = entityTagLevels('task', taskId);
  const top = opts.tags !== undefined ? opts.tags : existing.filter((t) => t.level === 1).map((t) => t.name);
  const secondary = opts.secondary !== undefined ? opts.secondary : existing.filter((t) => t.level > 1).map((t) => t.name);
  syncLeveledEntityTags('task', taskId, [
    { level: 1, names: top },
    { level: 2, names: secondary },
  ]);
}

/** A task's secondary (level>1) tag names — the read surface (mirrors blocks). */
function taskSecondaryTags(taskId: string): string[] {
  return entityTagLevels('task', taskId).filter((t) => t.level > 1).map((t) => t.name);
}
