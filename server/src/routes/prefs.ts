import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { schedulingPrefs } from '../db/schema.js';
import { toApi, fromApi } from '../lib/serialize.js';

export function prefsRouter() {
  const router = new Router();

  // GET /api/prefs
  router.get('/api/prefs', async (ctx) => {
    const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, 1));
    ctx.body = { prefs: prefs ? toApi(prefs) : null };
  });

  // PATCH /api/prefs  — accepts snake_case body, returns snake_case
  router.patch('/api/prefs', async (ctx) => {
    const body = ctx.request.body as Record<string, unknown>;
    // Convert incoming snake_case keys to camelCase for Drizzle
    const update = fromApi<Partial<typeof schedulingPrefs.$inferInsert>>(body);
    const [prefs] = await db
      .update(schedulingPrefs)
      .set(update)
      .where(eq(schedulingPrefs.ownerId, 1))
      .returning();
    ctx.body = { prefs: prefs ? toApi(prefs) : null };
  });

  return router;
}
