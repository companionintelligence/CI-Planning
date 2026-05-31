import Router from '@koa/router';
import { eq, and, like, sql, asc, desc, lte } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, tags, taskTags } from '../db/schema.js';
import { broadcast } from './sse.js';

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

    // Attach tags
    const withTags = result.map((t) => {
      const tagRows = sqlite
        .prepare<{ name: string }, { task_id: number }>(
          'SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id'
        )
        .all({ task_id: t.id });
      return { ...t, tags: tagRows.map((r) => r.name) };
    });

    // Filter by tag after attachment (simple approach for v1)
    const filtered = tag
      ? withTags.filter((t) => t.tags.includes(tag))
      : withTags;

    ctx.body = { tasks: filtered };
  });

  // POST /api/tasks
  router.post('/api/tasks', async (ctx) => {
    const body = ctx.request.body as {
      title: string;
      description?: string;
      due_at?: string;
      estimated_minutes?: number;
      priority?: number;
      owner_id?: number;
      tags?: string[];
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
        dueAt: body.due_at,
        estimatedMinutes: body.estimated_minutes,
        priority: body.priority ?? 3,
        ownerId: body.owner_id ?? 1,
      })
      .returning();

    if (body.tags?.length) await attachTags(task.id, body.tags);

    broadcast('task:created', task);
    ctx.status = 201;
    ctx.body = { task };
  });

  // PATCH /api/tasks/:id
  router.patch('/api/tasks/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const body = ctx.request.body as Partial<typeof tasks.$inferInsert & { tags: string[]; completed: boolean }>;

    const update: Partial<typeof tasks.$inferInsert> = {};
    if (body.title !== undefined)              update.title = body.title;
    if (body.description !== undefined)        update.description = body.description;
    if (body.due_at !== undefined)             update.dueAt = (body as any).due_at;
    if (body.dueAt !== undefined)              update.dueAt = body.dueAt;
    if (body.estimated_minutes !== undefined)  update.estimatedMinutes = (body as any).estimated_minutes;
    if (body.estimatedMinutes !== undefined)   update.estimatedMinutes = body.estimatedMinutes;
    if (body.priority !== undefined)           update.priority = body.priority;
    if (body.status !== undefined)             update.status = body.status;
    if (body.completed)                        { update.status = 'done'; update.completedAt = new Date().toISOString(); }

    const [task] = await db.update(tasks).set(update).where(eq(tasks.id, id)).returning();
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    if (Array.isArray((body as any).tags)) {
      sqlite.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
      await attachTags(id, (body as any).tags);
    }

    broadcast('task:updated', task);
    ctx.body = { task };
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
    broadcast('task:updated', task);
    ctx.body = { task };
  });

  return router;
}

async function attachTags(taskId: number, names: string[]) {
  for (const rawName of names) {
    const name = rawName.toLowerCase().replace(/\s+/g, '-').slice(0, 32);
    const existing = sqlite.prepare<{ id: number }, { name: string }>('SELECT id FROM tags WHERE name = @name').get({ name });
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
