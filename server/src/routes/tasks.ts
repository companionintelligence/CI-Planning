import Router from '@koa/router';
import { eq, and, like, asc, lte } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, taskTags, timeBlocks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi } from '../lib/serialize.js';
import { syncBlockToGoogle } from '../lib/gcal-sync.js';

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

    // Attach tags and serialize to snake_case
    const withTags = result.map((t) => {
      const tagRows = sqlite
        .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
        .all({ task_id: t.id }) as { name: string }[];
      return { ...toApi(t), tags: tagRows.map((r) => r.name) };
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
      task_time?: string;
      estimated_minutes?: number;
      priority?: number;
      owner_id?: number;
      parent_id?: number;
      tags?: string[];
      category?: string;
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
        taskTime: body.task_time,
        estimatedMinutes: body.estimated_minutes,
        priority: body.priority ?? 3,
        parentId: body.parent_id,
        ownerId: body.owner_id ?? 1,
        category: body.category,
      })
      .returning();

    if (body.tags?.length) await attachTags(task.id, body.tags);

    const out = { ...toApi(task), tags: body.tags ?? [] };
    broadcast('task:created', out);
    ctx.status = 201;
    ctx.body = { task: out };
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
      task_time?: string | null;
      estimated_minutes?: number | null;
      estimatedMinutes?: number | null;
      actual_minutes?: number | null;
      actualMinutes?: number | null;
      priority?: number;
      status?: string;
      completed?: boolean;
      completed_at?: string | null;
      parent_id?: number | null;
      tags?: string[];
      category?: string | null;
    };

    const update: Partial<typeof tasks.$inferInsert> = {};
    if (body.title !== undefined)             update.title = body.title;
    if (body.description !== undefined)       update.description = body.description;
    if (body.notes !== undefined)             update.notes = body.notes;
    if (body.due_at !== undefined)            update.dueAt = body.due_at;
    if (body.dueAt !== undefined)             update.dueAt = body.dueAt;
    if (body.task_time !== undefined)         update.taskTime = body.task_time;
    if (body.estimated_minutes !== undefined) update.estimatedMinutes = body.estimated_minutes;
    if (body.estimatedMinutes !== undefined)  update.estimatedMinutes = body.estimatedMinutes;
    if (body.actual_minutes !== undefined)    update.actualMinutes = body.actual_minutes;
    if (body.actualMinutes !== undefined)     update.actualMinutes = body.actualMinutes;
    if (body.priority !== undefined)          update.priority = body.priority;
    if (body.status !== undefined)            update.status = body.status;
    if (body.completed_at !== undefined)      update.completedAt = body.completed_at;
    if (body.parent_id !== undefined)         update.parentId = body.parent_id;
    if (body.category !== undefined)          update.category = body.category;
    if (body.completed)                       { update.status = 'done'; update.completedAt = new Date().toISOString(); }

    const [task] = await db.update(tasks).set(update).where(eq(tasks.id, id)).returning();
    if (!task) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // Synchronize updates to the corresponding time block if it exists
    const [block] = await db.select().from(timeBlocks).where(eq(timeBlocks.taskId, id));
    if (block) {
      const blockUpdate: Partial<typeof timeBlocks.$inferInsert> = {};
      if (update.title !== undefined) blockUpdate.title = update.title;
      
      // If task status was marked done, mark the block completed
      if (update.status === 'done' || body.completed) {
        blockUpdate.status = 'completed';
      }

      // If dueAt, taskTime, or estimatedMinutes changed, recalculate block boundaries
      if (update.dueAt !== undefined || update.taskTime !== undefined || update.estimatedMinutes !== undefined) {
        const datePart = task.dueAt ? task.dueAt.slice(0, 10) : new Date(block.startAt).toISOString().slice(0, 10);
        let timePart = task.taskTime ?? '';
        if (!timePart || timePart.length !== 5) {
          const d = new Date(block.startAt);
          timePart = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        }
        
        const estMins = task.estimatedMinutes ?? 30;
        const startIso = `${datePart}T${timePart}:00.000Z`;
        const startDate = new Date(startIso);
        const endDate = new Date(startDate.getTime() + estMins * 60 * 1000);
        
        blockUpdate.startAt = startIso;
        blockUpdate.endAt = endDate.toISOString();
      }

      if (Object.keys(blockUpdate).length > 0) {
        const [updatedBlock] = await db.update(timeBlocks).set(blockUpdate).where(eq(timeBlocks.id, block.id)).returning();
        if (updatedBlock) {
          await syncBlockToGoogle(updatedBlock, 'update');
          broadcast('block:updated', toApi(updatedBlock));
        }
      }
    }

    if (Array.isArray(body.tags)) {
      sqlite.prepare('DELETE FROM task_tags WHERE task_id = ?').run(id);
      await attachTags(id, body.tags);
    }

    const currentTags = (sqlite
      .prepare('SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = @task_id')
      .all({ task_id: id }) as { name: string }[]).map((r) => r.name);
    const out = { ...toApi(task), tags: currentTags };
    broadcast('task:updated', out);
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

    // Also delete any associated block!
    const [block] = await db.select().from(timeBlocks).where(eq(timeBlocks.taskId, id));
    if (block) {
      await db.delete(timeBlocks).where(eq(timeBlocks.id, block.id));
      await syncBlockToGoogle(block, 'delete');
      broadcast('block:deleted', { id: block.id });
    }

    const out = { ...toApi(task), tags: [] as string[] };
    broadcast('task:updated', out);
    ctx.body = { task: out };
  });

  return router;
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
