import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { possibleTasks, tasks } from '../db/schema.js';
import { broadcast } from './sse.js';

export function possiblesRouter() {
  const router = new Router();

  // GET /api/possible-tasks
  router.get('/api/possible-tasks', async (ctx) => {
    const { status = 'pending' } = ctx.query as Record<string, string>;
    const rows = await db
      .select()
      .from(possibleTasks)
      .where(eq(possibleTasks.status, status));
    ctx.body = { possibles: rows };
  });

  // POST /api/possible-tasks/:id/promote
  router.post('/api/possible-tasks/:id/promote', async (ctx) => {
    const id = Number(ctx.params.id);
    const [possible] = await db.select().from(possibleTasks).where(eq(possibleTasks.id, id));
    if (!possible) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const overrides = (ctx.request.body ?? {}) as Partial<{
      title: string;
      due_at: string;
      priority: number;
    }>;

    const [task] = await db
      .insert(tasks)
      .values({
        title: overrides.title ?? possible.rawTitle,
        description: possible.rawSummary ?? undefined,
        dueAt: overrides.due_at ?? possible.proposedDueAt ?? undefined,
        priority: overrides.priority ?? possible.proposedPriority ?? 3,
        ownerId: possible.proposedOwnerId ?? 1,
        sourceKind: possible.sourceKind ?? 'agent',
        sourceRef: possible.sourceRef ?? undefined,
      })
      .returning();

    await db
      .update(possibleTasks)
      .set({ status: 'promoted', promotedTaskId: task.id })
      .where(eq(possibleTasks.id, id));

    broadcast('possible:promoted', { id, task });
    ctx.status = 201;
    ctx.body = { task };
  });

  // POST /api/possible-tasks/:id/dismiss
  router.post('/api/possible-tasks/:id/dismiss', async (ctx) => {
    const id = Number(ctx.params.id);
    const [possible] = await db
      .update(possibleTasks)
      .set({ status: 'dismissed' })
      .where(eq(possibleTasks.id, id))
      .returning();
    if (!possible) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast('possible:dismissed', { id });
    ctx.body = { ok: true };
  });

  return router;
}
