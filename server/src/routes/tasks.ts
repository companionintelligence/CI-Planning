import Router from '@koa/router';
import { eq, and, like, asc, lte } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { setDependencies, getDependencies, blockedTaskIds, DependencyCycleError } from '../engine/deps.js';
import { parseQuick } from '../engine/quickadd.js';
import { enrichQuick } from '../agents/quickadd.js';
import { suggestTags } from '../agents/tags.js';
import { startTimer, stopTimer, getRunning } from '../services/timer.js';
import { parseRule } from '../engine/recurrence.js';
import { generateRecurrences, ownerTimezone } from '../engine/recurrence-generate.js';
import { rescheduleTask } from '../engine/review.js';
import { skipInstance, computeStreak, resolveTemplateId, deleteFutureOpenInstances } from '../engine/recurrence-ops.js';
import { syncTaskReminders } from '../engine/reminders.js';
import { ensureHabitPattern } from '../services/patterns.js';
import { setEntityTagIds, taskTagNames, taskTagNamesByIds, normalizeTagName } from '../services/tags.js';
import { utcDayBounds } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
import { writeAudit } from '../lib/audit.js';

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
    if (include_fast !== '1') conditions.push(eq(tasks.isFastTask, false));

    const result = conditions.length
      ? await rows.where(and(...conditions)).orderBy(asc(tasks.priority), asc(tasks.dueAt))
      : await rows.orderBy(asc(tasks.priority), asc(tasks.dueAt));

    // Attach tags + dependency info, serialize to snake_case
    const blocked = blockedTaskIds();
    const tagsById = taskTagNamesByIds(result.map((t) => t.id));
    const withTags = result.map((t) => ({
      ...toApi(t),
      tags: tagsById.get(t.id) ?? [],
      depends_on: getDependencies(t.id),
      blocked: blocked.has(t.id),
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
      if (body.tags?.length) await attachTags(template.id, body.tags);
      // Bridge: a habit task is also represented as a Habit-type Pattern (G2/E′).
      if (sw?.isHabit) ensureHabitPattern(template.id, owner, template.title);
      const generated = generateRecurrences();
      const out = { ...toApi(template), tags: body.tags ?? [], depends_on: [] as string[], blocked: false };
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

    if (body.tags?.length) await attachTags(task.id, body.tags);
    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, task.id, body.depends_on)) return;
    syncTaskReminders(currentOwnerId(), task.id); // Phase H (b): derive reminders from due_at + Reminder Defaults

    const out = {
      ...toApi(task),
      tags: body.tags ?? [],
      depends_on: getDependencies(task.id),
      blocked: blockedTaskIds().has(task.id),
    };
    broadcast(currentOwnerId(), 'task:created', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `task:${task.id}` });
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

    if (enriched.tags.length) await attachTags(task.id, enriched.tags);
    syncTaskReminders(currentOwnerId(), task.id); // Phase H (b): quick-add may parse a due date

    const out = { ...toApi(task), tags: enriched.tags, depends_on: [] as number[], blocked: false, llm };
    broadcast(currentOwnerId(), 'task:created', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `task:${task.id}` });
    ctx.status = 201;
    ctx.body = { task: out, parsed: enriched, llm };
  });

  // GET /api/tasks/:id/subtasks
  router.get('/api/tasks/:id/subtasks', async (ctx) => {
    const parentId = ctx.params.id;
    const result = await db.select().from(tasks).where(eq(tasks.parentId, parentId)).orderBy(asc(tasks.priority));
    const tagsById = taskTagNamesByIds(result.map((t) => t.id));
    const withTags = result.map((t) => ({ ...toApi(t), tags: tagsById.get(t.id) ?? [] }));
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
    const out = { ...toApi(task), tags: [] as string[], depends_on: [] as number[], blocked: false };
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
      .set({ isHabit: true, isFastTask: false, subtype: 'habit' })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ensureHabitPattern(id, task.ownerId ?? owner, task.title);
    const out = { ...toApi(task), tags: taskTagNames(id), depends_on: getDependencies(id) };
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
        `INSERT INTO tasks (id, title, description, notes, estimated_minutes, priority, task_time, subtype, is_habit, is_fast_task, parent_id, owner_id, status, source_kind)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?) RETURNING id`
      ).get(s.title, s.description, s.notes, s.estimated_minutes, s.priority ?? 3, s.task_time, st, st === 'habit' ? 1 : 0, st === 'quick' ? 1 : 0, parentId, owner, s.source_kind ?? 'manual') as { id: string }).id;
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
    const out = { ...toApi(task), tags: taskTagNames(newId), depends_on: [] as string[], blocked: false };
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
    const out = { ...toApi(task), tags: taskTagNames(id), depends_on: getDependencies(id) };
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
    // CON-2c: keep subtype ⇄ is_habit/is_fast_task in sync (engine still reads is_habit).
    const sw = subtypeWrite(body);
    if (sw) {
      // subtype is canonical; write both aliases from it so the trio never drifts.
      update.subtype = sw.subtype;
      update.isHabit = sw.isHabit;
      update.isFastTask = sw.isFastTask;
    }
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

    if (Array.isArray(body.tags)) {
      await attachTags(targetId, body.tags); // setEntityTagIds replaces the set (delete + reinsert)
    }

    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, targetId, body.depends_on)) return;
    syncTaskReminders(currentOwnerId(), targetId); // Phase H (b): re-derive if due_at changed

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

    const currentTags = taskTagNames(targetId);
    const out = {
      ...toApi(task),
      tags: currentTags,
      depends_on: getDependencies(targetId),
      blocked: blockedTaskIds().has(targetId),
    };
    broadcast(currentOwnerId(), 'task:updated', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `task:${targetId}` });
    if (generated) broadcast(currentOwnerId(), 'recurrence:generated', generated);
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
    const out = { ...toApi(task), tags: [] as string[] };
    broadcast(currentOwnerId(), 'task:updated', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `task:${id}` });
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
    if (stopped) broadcast(owner, 'timer:stopped', stopped.entry); // the superseded one
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
 * CON-2c: `subtype` is the canonical Task subtype; `is_habit`/`is_fast_task` are
 * kept as in-sync runtime aliases (the recurrence/streak engine reads `is_habit`).
 * Both code paths derive the canonical `subtype` and then BOTH booleans from it, so
 * the trio can never drift. Previously the legacy `is_habit` path left `is_fast_task`
 * untouched, so toggling a quick task to a habit (via the legacy field) left a stale
 * `is_fast_task=1` — a habit that was also a fast task. Returns the drizzle columns
 * to write, or null when neither field was supplied.
 */
function subtypeWrite(body: { subtype?: Subtype; is_habit?: boolean }):
  { subtype: Subtype; isHabit: boolean; isFastTask: boolean } | null {
  const subtype: Subtype | undefined =
    body.subtype !== undefined ? body.subtype : body.is_habit !== undefined ? (body.is_habit ? 'habit' : 'standard') : undefined;
  if (subtype === undefined) return null;
  return { subtype, isHabit: subtype === 'habit', isFastTask: subtype === 'quick' };
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

async function attachTags(taskId: string, names: string[]) {
  const tagIds: string[] = [];
  for (const rawName of names) {
    const name = normalizeTagName(rawName); // canonical: trim + strip leading '#' + lowercase + dashes + cap32 (matches blocks/routines/0033)
    const existing = sqlite.prepare('SELECT id FROM tags WHERE name = @name').get({ name }) as { id: string } | undefined;
    const tagId = existing
      ? existing.id
      : (sqlite.prepare('INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id').get(name) as { id: string }).id;
    tagIds.push(tagId);
  }
  // entity_tags is the sole task-tag store (CON-3 / migration 0041). Replace semantics:
  // every caller passes the task's full tag set, so setEntityTagIds (delete + reinsert)
  // is correct — including clearing to empty.
  setEntityTagIds('task', taskId, tagIds);
}
