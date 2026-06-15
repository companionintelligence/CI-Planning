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
    };

    if (!body.title?.trim()) {
      ctx.status = 400;
      ctx.body = { error: 'title is required' };
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
      })
      .returning();

    if (body.tags?.length) await attachTags(task.id, body.tags);
    if (Array.isArray(body.depends_on) && !applyDependencies(ctx, task.id, body.depends_on)) return;

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

  // PATCH /api/tasks/:id
  router.patch('/api/tasks/:id', async (ctx) => {
    const id = Number(ctx.params.id);
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
    };

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
    if (body.completed)                       { update.status = 'done'; update.completedAt = new Date().toISOString(); }

    // Only issue an UPDATE when there are column changes; a tags/depends-only
    // PATCH still resolves the task (drizzle rejects an empty .set()).
    const [task] = Object.keys(update).length
      ? await db.update(tasks).set(update).where(eq(tasks.id, id)).returning()
      : await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

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
