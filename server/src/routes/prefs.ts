import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { schedulingPrefs } from '../db/schema.js';

export function prefsRouter() {
  const router = new Router();

  // GET /api/prefs
  router.get('/api/prefs', async (ctx) => {
    const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, 1));
    ctx.body = { prefs };
  });

  // PATCH /api/prefs
  router.patch('/api/prefs', async (ctx) => {
    const body = ctx.request.body as Partial<typeof schedulingPrefs.$inferInsert>;
    const [prefs] = await db
      .update(schedulingPrefs)
      .set(body)
      .where(eq(schedulingPrefs.ownerId, 1))
      .returning();
    ctx.body = { prefs };
  });

  return router;
}
