import Router from '@koa/router';
import { eq, and, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { timeBlocks, tasks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi, toApiList } from '../lib/serialize.js';
import { syncBlockToGoogle } from '../lib/gcal-sync.js';

export function blocksRouter() {
  const router = new Router();

  // GET /api/blocks?from=ISO&to=ISO
  router.get('/api/blocks', async (ctx) => {
    const { from, to } = ctx.query as Record<string, string>;

    const conditions = [];
    if (from) conditions.push(gte(timeBlocks.startAt, from));
    if (to)   conditions.push(lte(timeBlocks.endAt, to));

    const rows = conditions.length
      ? await db.select().from(timeBlocks).where(and(...conditions))
      : await db.select().from(timeBlocks);

    ctx.body = { blocks: toApiList(rows) };
  });

  // POST /api/blocks
  router.post('/api/blocks', async (ctx) => {
    const body = ctx.request.body as {
      task_id?: number;
      title: string;
      block_kind?: string;
      start_at: string;
      end_at: string;
      is_locked?: boolean;
    };

    if (!body.title || !body.start_at || !body.end_at) {
      ctx.status = 400;
      ctx.body = { error: 'title, start_at, and end_at are required' };
      return;
    }

    const [block] = await db
      .insert(timeBlocks)
      .values({
        taskId: body.task_id,
        title: body.title,
        blockKind: body.block_kind ?? 'task',
        startAt: body.start_at,
        endAt: body.end_at,
        isLocked: body.is_locked ?? false,
        isAuto: false,
        sourceKind: 'manual',
      })
      .returning();

    await syncBlockToGoogle(block, 'create');
    const [syncedBlock] = await db.select().from(timeBlocks).where(eq(timeBlocks.id, block.id));

    const out = toApi(syncedBlock || block);
    broadcast('block:created', out);
    ctx.status = 201;
    ctx.body = { block: out };
  });

  // PATCH /api/blocks/:id
  router.patch('/api/blocks/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const body = ctx.request.body as Partial<{
      title: string;
      start_at: string;
      end_at: string;
      is_locked: boolean;
      status: string;
      block_kind: string;
    }>;

    const update: Partial<typeof timeBlocks.$inferInsert> = {};
    if (body.title      !== undefined) update.title      = body.title;
    if (body.start_at   !== undefined) update.startAt    = body.start_at;
    if (body.end_at     !== undefined) update.endAt      = body.end_at;
    if (body.is_locked  !== undefined) update.isLocked   = body.is_locked;
    if (body.status     !== undefined) update.status     = body.status;
    if (body.block_kind !== undefined) update.blockKind  = body.block_kind;

    const [block] = await db.update(timeBlocks).set(update).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // If block is linked to a task, update the task representation
    if (block.taskId) {
      const taskUpdate: Partial<typeof tasks.$inferInsert> = {};
      if (update.title !== undefined) taskUpdate.title = update.title;
      
      // Update dueAt and taskTime from block startAt
      if (block.startAt) {
        taskUpdate.dueAt = block.startAt.slice(0, 10);
        const d = new Date(block.startAt);
        taskUpdate.taskTime = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      }
      
      // Update estimatedMinutes from startAt and endAt duration
      if (block.startAt && block.endAt) {
        const diffMs = new Date(block.endAt).getTime() - new Date(block.startAt).getTime();
        taskUpdate.estimatedMinutes = Math.max(5, Math.round(diffMs / 60_000));
      }

      // Sync status from block.status
      if (update.status === 'completed') {
        taskUpdate.status = 'done';
        taskUpdate.completedAt = new Date().toISOString();
      } else if (update.status === 'skipped') {
        taskUpdate.status = 'open'; // return task back to backlog
      }

      if (Object.keys(taskUpdate).length > 0) {
        await db.update(tasks).set(taskUpdate).where(eq(tasks.id, block.taskId));
        const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, block.taskId));
        if (updatedTask) {
          broadcast('task:updated', toApi(updatedTask));
        }
      }
    }

    await syncBlockToGoogle(block, 'update');
    const [syncedBlock] = await db.select().from(timeBlocks).where(eq(timeBlocks.id, id));

    const out = toApi(syncedBlock || block);
    broadcast('block:updated', out);
    ctx.body = { block: out };
  });

  // DELETE /api/blocks/:id
  router.delete('/api/blocks/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const [block] = await db.delete(timeBlocks).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    
    // If block is linked to a task, return the task status to open
    if (block.taskId) {
      await db.update(tasks).set({ status: 'open' }).where(eq(tasks.id, block.taskId));
      const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, block.taskId));
      if (updatedTask) {
        broadcast('task:updated', toApi(updatedTask));
      }
    }

    await syncBlockToGoogle(block, 'delete');
    broadcast('block:deleted', { id });
    ctx.body = { ok: true };
  });

  return router;
}
