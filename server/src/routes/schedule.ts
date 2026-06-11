import Router from '@koa/router';
import { eq, and, gte, lte, notInArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { timeBlocks, tasks } from '../db/schema.js';
import { runScheduler } from '../engine/scheduler.js';
import { broadcast } from './sse.js';
import { toApi } from '../lib/serialize.js';
import { syncBlockToGoogle } from '../lib/gcal-sync.js';

export function scheduleRouter() {
  const router = new Router();

  // POST /api/schedule/run  { date?: "YYYY-MM-DD" }
  router.post('/api/schedule/run', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const date = body.date ?? new Date().toISOString().slice(0, 10);
    const result = await runScheduler(date);
    ctx.body = result;
  });

  // POST /api/schedule/clear  { date?: "YYYY-MM-DD" }
  router.post('/api/schedule/clear', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const date = body.date ?? new Date().toISOString().slice(0, 10);
    const start = `${date}T00:00:00.000Z`;
    const end = `${date}T23:59:59.000Z`;

    // Find auto blocks for the day that are not locked/completed/skipped
    const toDelete = await db
      .select()
      .from(timeBlocks)
      .where(
        and(
          gte(timeBlocks.startAt, start),
          lte(timeBlocks.endAt, end),
          eq(timeBlocks.isLocked, false),
          notInArray(timeBlocks.status, ['completed', 'skipped'])
        )
      );

    let cleared = 0;
    for (const block of toDelete) {
      await db.delete(timeBlocks).where(eq(timeBlocks.id, block.id));
      
      // If block is linked to a task, return task status to open
      if (block.taskId) {
        await db.update(tasks).set({ status: 'open' }).where(eq(tasks.id, block.taskId));
        const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, block.taskId));
        if (updatedTask) {
          broadcast('task:updated', toApi(updatedTask));
        }
      }

      await syncBlockToGoogle(block, 'delete');
      broadcast('block:deleted', { id: block.id });
      cleared++;
    }

    ctx.body = { ok: true, cleared };
  });

  return router;
}
