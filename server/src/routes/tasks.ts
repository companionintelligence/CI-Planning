import Router from '@koa/router';
import { eq, and, like, asc, lte } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, taskTags } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { setDependencies, getDependencies, blockedTaskIds, DependencyCycleError } from '../engine/deps.js';
import { parseQuick } from '../engine/quickadd.js';
import { enrichQuick } from '../agents/quickadd.js';
import { parseRule, generateRecurrences, habitStreak, instanceStartUTC } from '../engine/recurrence.js';
import { serverTimezone } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';

export function tasksRouter() {
  const router = new Router();

  // GET /api/tasks
  router.get('/api/tasks', async (ctx) => {
    const { status, owner_id, tag, q, due_before, priority } = ctx.query as Record<string, string>;

    let rows = db.select().from(tasks);

    // Build WHERE conditions
    const conditions = [];
    if (status)    conditions.push(eq(tasks.status, status));
    if (owner_id)  conditions.push(eq(tasks.ownerId, Number(owner_id)));
    if (priority)  conditions.push(eq(tasks.priority, Number(priority)));
    if (due_before) conditions.push(lte(tasks.dueAt, due_before));
    if (q)         conditions.push(like(tasks.title, `%${q}%`));

    const result = conditions.length
      ? await rows.where(and(...conditions)).orderBy(asc(tasks.priority), asc(tasks.dueAt))
      : await rows.orderBy(asc(tasks.priority), asc(tasks.dueAt));

    // Attach tags + dependency info, serialize to snake_case
    const blocked = blockedTaskIds();
    const withTags = result.map((t) => {
      const tagRows = sqlite
        .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
        .all({ task_id: t.id }) as { name: string }[];
      return {
        ...toApi(t),
        tags: tagRows.map((r) => r.name),
        depends_on: getDependencies(t.id),
        blocked: blocked.has(t.id),
      };
    });

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
      owner_id?: number;
      parent_id?: number;
      tags?: string[];
      depends_on?: number[];
      recurrence_rule?: string | null;
      is_habit?: boolean;
    };

    if (!body.title?.trim()) {
      ctx.status = 400;
      ctx.body = { error: 'title is required' };
      return;
    }

    // A recurrence_rule turns this into a *template*: non-schedulable status so
    // the scheduler's open-only filter skips it; instances are generated below.
    let recurrence: { rule: string; dtstart: string } | null = null;
    if (body.recurrence_rule) {
      const parsed = parseRule(body.recurrence_rule);
      if (!parsed.ok) { ctx.status = 422; ctx.body = { error: parsed.error }; return; }
      const tz = ownerTimezone();
      // Anchor the series at the chosen due-date (or today), at task_time / midnight.
      const anchorDay = body.due_at ? body.due_at.slice(0, 10) : (body.scheduled_for ?? localISODate());
      recurrence = { rule: parsed.rule, dtstart: instanceStartUTC(anchorDay, body.task_time ?? null, tz) };
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
        status: recurrence ? 'recurring' : 'open',
        recurrenceRule: recurrence?.rule ?? null,
        recurrenceDtstart: recurrence?.dtstart ?? null,
        isHabit: body.is_habit ?? false,
      })
      .returning();

    if (body.tags?.length) await attachTags(task.id, body.tags);
    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, task.id, body.depends_on)) return;

    // Materialize the first window immediately so a new series appears at once.
    if (recurrence) generateRecurrences();

    const out = {
      ...toApi(task),
      tags: body.tags ?? [],
      depends_on: getDependencies(task.id),
      blocked: blockedTaskIds().has(task.id),
    };
    broadcast(currentOwnerId(), 'task:created', out);
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

    const out = { ...toApi(task), tags: enriched.tags, depends_on: [] as number[], blocked: false, llm };
    broadcast(currentOwnerId(), 'task:created', out);
    ctx.status = 201;
    ctx.body = { task: out, parsed: enriched, llm };
  });

  // GET /api/tasks/:id/subtasks
  router.get('/api/tasks/:id/subtasks', async (ctx) => {
    const parentId = Number(ctx.params.id);
    const result = await db.select().from(tasks).where(eq(tasks.parentId, parentId)).orderBy(asc(tasks.priority));
    const withTags = result.map((t) => {
      const tagRows = sqlite
        .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
        .all({ task_id: t.id }) as { name: string }[];
      return { ...toApi(t), tags: tagRows.map((r) => r.name) };
    });
    ctx.body = { subtasks: withTags };
  });

  // PATCH /api/tasks/:id?scope=instance|series  (default: instance)
  //
  // scope=instance — edits only this row (one day of a series, or a one-off).
  // scope=series   — edits the TEMPLATE: applies the change, and on a rule/timing
  //                  change deletes future un-actioned instances + regenerates the
  //                  window. Past/completed/skipped/missed instances are preserved.
  router.patch('/api/tasks/:id', async (ctx) => {
    const rowId = Number(ctx.params.id);
    const scope = (ctx.query.scope as string) === 'series' ? 'series' : 'instance';
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
      parent_id?: number | null;
      tags?: string[];
      depends_on?: number[];
      recurrence_rule?: string | null;
      is_habit?: boolean;
    };

    // Resolve the edit target. series → the template (this row if it is one, else
    // its parent template); instance → this row.
    const targetId = scope === 'series' ? resolveTemplateId(rowId) : rowId;
    if (targetId == null) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const id = targetId;

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
    if (body.completed_at !== undefined)      update.completedAt = body.completed_at;
    if (body.parent_id !== undefined)         update.parentId = body.parent_id;
    if (body.completed)                       { update.status = 'done'; update.completedAt = new Date().toISOString(); }
    if (body.is_habit !== undefined)          update.isHabit = body.is_habit;

    // A status change is honored, except: a template must stay non-schedulable —
    // never let an edit flip it to 'open' and leak it into the today-set.
    let regenerate = false;
    if (scope === 'series') {
      // Validate + apply a rule change on the template.
      if (body.recurrence_rule !== undefined) {
        if (body.recurrence_rule === null || body.recurrence_rule === '') {
          ctx.status = 422; ctx.body = { error: 'series edit cannot clear the recurrence rule' }; return;
        }
        const parsed = parseRule(body.recurrence_rule);
        if (!parsed.ok) { ctx.status = 422; ctx.body = { error: parsed.error }; return; }
        update.recurrenceRule = parsed.rule;
        regenerate = true;
      }
      // A timing change (task_time / due anchor) also requires regeneration.
      if (body.task_time !== undefined || body.due_at !== undefined || body.dueAt !== undefined) {
        regenerate = true;
      }
      update.status = 'recurring'; // template stays out of the today-set
    } else if (body.status !== undefined) {
      update.status = body.status;
    }

    // Only issue an UPDATE when there are column changes; a tags/depends-only
    // PATCH still resolves the task (drizzle rejects an empty .set()).
    const [task] = Object.keys(update).length
      ? await db.update(tasks).set(update).where(eq(tasks.id, id)).returning()
      : await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // Series rule/timing change: drop future un-actioned instances, then re-
    // materialize under the new rule. Past/completed/skipped/missed are kept; an
    // edited-but-open future instance is preserved by the unique index on re-run.
    if (scope === 'series' && regenerate) {
      // Refresh dtstart anchor when timing moved so the pattern re-anchors cleanly.
      if (body.task_time !== undefined || body.due_at !== undefined || body.dueAt !== undefined) {
        const tz = ownerTimezone();
        const anchorDay = (task.dueAt ?? task.scheduledFor ?? localISODate()).slice(0, 10);
        await db.update(tasks)
          .set({ recurrenceDtstart: instanceStartUTC(anchorDay, task.taskTime ?? null, tz) })
          .where(eq(tasks.id, id));
      }
      sqlite
        .prepare(
          `DELETE FROM tasks
             WHERE recurrence_parent_id = ? AND status = 'open' AND occurrence_date >= ?`
        )
        .run(id, localISODate());
      generateRecurrences();
    }

    if (Array.isArray(body.tags)) {
      sqlite.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
      await attachTags(id, body.tags);
    }

    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, id, body.depends_on)) return;

    const currentTags = (sqlite
      .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
      .all({ task_id: id }) as { name: string }[]).map((r) => r.name);
    const out = {
      ...toApi(task),
      tags: currentTags,
      depends_on: getDependencies(id),
      blocked: blockedTaskIds().has(id),
    };
    broadcast(currentOwnerId(), 'task:updated', out);
    ctx.body = { task: out };
  });

  // POST /api/tasks/:id/skip — skip a single recurring instance.
  // Sets the instance status='skipped' AND appends its occurrence_date to the
  // TEMPLATE's recurrence_exdates so a regenerate won't resurrect it (durable).
  router.post('/api/tasks/:id/skip', async (ctx) => {
    const id = Number(ctx.params.id);
    const [inst] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!inst) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    if (!inst.recurrenceParentId || !inst.occurrenceDate) {
      ctx.status = 400; ctx.body = { error: 'not a recurring instance' }; return;
    }

    const [updated] = await db.update(tasks).set({ status: 'skipped' }).where(eq(tasks.id, id)).returning();

    // Append the occurrence date to the template's EXDATE set (de-duped).
    const [tmpl] = await db.select().from(tasks).where(eq(tasks.id, inst.recurrenceParentId));
    if (tmpl) {
      const ex = new Set([...(tmpl.recurrenceExdates ?? []), inst.occurrenceDate]);
      await db.update(tasks).set({ recurrenceExdates: [...ex].sort() }).where(eq(tasks.id, tmpl.id));
    }

    const out = { ...toApi(updated), tags: [] as string[], depends_on: getDependencies(id), blocked: false };
    broadcast(currentOwnerId(), 'task:updated', out);
    ctx.body = { task: out };
  });

  // GET /api/tasks/:id/streak — consecutive done habit instances back from today,
  // plus the last-7 occurrence states for the streak strip. Accepts a template id
  // or an instance id (resolves to the template).
  router.get('/api/tasks/:id/streak', async (ctx) => {
    const templateId = resolveTemplateId(Number(ctx.params.id));
    if (templateId == null) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = habitStreak(templateId);
  });

  // DELETE /api/tasks/:id  (soft delete)
  router.delete('/api/tasks/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const [task] = await db
      .update(tasks)
      .set({ status: 'cancelled' })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const out = { ...toApi(task), tags: [] as string[] };
    broadcast(currentOwnerId(), 'task:updated', out);
    ctx.body = { task: out };
  });

  return router;
}

/**
 * The template id for a series edit: the row itself if it's a template
 * (recurrence_parent_id null), its parent template if it's an instance, or null
 * if the row doesn't exist. A plain one-off resolves to itself (series == itself).
 */
function resolveTemplateId(rowId: number): number | null {
  const row = sqlite
    .prepare('SELECT id, recurrence_parent_id FROM tasks WHERE id = ?')
    .get(rowId) as { id: number; recurrence_parent_id: number | null } | undefined;
  if (!row) return null;
  return row.recurrence_parent_id ?? row.id;
}

/** The current owner's scheduling timezone, falling back to the server zone. */
function ownerTimezone(): string {
  const row = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get(currentOwnerId()) as { timezone: string | null } | undefined;
  return row?.timezone || serverTimezone();
}

/** Replace a task's blockers; on a cycle, respond 409 and return false. */
function applyDependencies(ctx: { status: number; body: unknown }, taskId: number, dependsOn: number[]): boolean {
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

async function attachTags(taskId: number, names: string[]) {
  for (const rawName of names) {
    const name = rawName.toLowerCase().replace(/\s+/g, '-').slice(0, 32);
    const existing = sqlite.prepare('SELECT id FROM tags WHERE name = @name').get({ name }) as { id: number } | undefined;
    let tagId: number;
    if (existing) {
      tagId = existing.id;
    } else {
      const r = sqlite.prepare('INSERT INTO tags (name) VALUES (?) RETURNING id').get(name) as { id: number };
      tagId = r.id;
    }
    sqlite.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId);
  }
}
