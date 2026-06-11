import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { lifePriorities } from '../db/schema.js';
import { toApiList, fromApi } from '../lib/serialize.js';

export function prioritiesRouter() {
  const router = new Router();

  // GET /api/priorities
  router.get('/api/priorities', async (ctx) => {
    const list = await db.select().from(lifePriorities);
    ctx.body = { priorities: toApiList(list) };
  });

  // POST /api/priorities
  router.post('/api/priorities', async (ctx) => {
    const body = ctx.request.body as { priorities?: Record<string, unknown>[] };
    if (!body || !Array.isArray(body.priorities)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid payload: priorities list is required' };
      return;
    }

    const updated = [];
    for (const p of body.priorities) {
      const parsed = fromApi<typeof lifePriorities.$inferInsert>(p);
      if (!parsed.category) continue;

      // Check if exists
      const [existing] = await db
        .select()
        .from(lifePriorities)
        .where(eq(lifePriorities.category, parsed.category));

      if (existing) {
        // Update
        const [updatedRow] = await db
          .update(lifePriorities)
          .set({
            satisfaction: parsed.satisfaction ?? existing.satisfaction,
            importance: parsed.importance ?? existing.importance,
            targetHoursPerWeek: parsed.targetHoursPerWeek ?? existing.targetHoursPerWeek,
          })
          .where(eq(lifePriorities.category, parsed.category))
          .returning();
        updated.push(updatedRow);
      } else {
        // Insert
        const [insertedRow] = await db
          .insert(lifePriorities)
          .values({
            category: parsed.category,
            satisfaction: parsed.satisfaction ?? 5,
            importance: parsed.importance ?? 5,
            targetHoursPerWeek: parsed.targetHoursPerWeek ?? 0,
          })
          .returning();
        updated.push(insertedRow);
      }
    }

    ctx.body = { priorities: toApiList(updated) };
  });

  return router;
}
