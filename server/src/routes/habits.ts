import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { habits } from '../db/schema.js';
import { toApi, toApiList } from '../lib/serialize.js';

export function habitsRouter() {
  const router = new Router();

  // GET /api/habits
  router.get('/api/habits', async (ctx) => {
    const rows = await db.select().from(habits).where(eq(habits.ownerId, 1));
    ctx.body = { habits: toApiList(rows) };
  });

  // POST /api/habits
  router.post('/api/habits', async (ctx) => {
    const body = ctx.request.body as {
      title: string;
      duration_minutes: number;
      start_time_earliest: string;
      start_time_latest: string;
      days_of_week?: string;
      enabled?: boolean;
    };

    if (!body.title || !body.duration_minutes || !body.start_time_earliest || !body.start_time_latest) {
      ctx.status = 400;
      ctx.body = { error: 'title, duration_minutes, start_time_earliest, and start_time_latest are required' };
      return;
    }

    const [row] = await db.insert(habits).values({
      ownerId: 1,
      title: body.title,
      durationMinutes: body.duration_minutes,
      startTimeEarliest: body.start_time_earliest,
      startTimeLatest: body.start_time_latest,
      daysOfWeek: body.days_of_week ?? '1,2,3,4,5',
      enabled: body.enabled ?? true,
    }).returning();

    ctx.status = 201;
    ctx.body = { habit: toApi(row) };
  });

  // PATCH /api/habits/:id
  router.patch('/api/habits/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const body = ctx.request.body as {
      title?: string;
      duration_minutes?: number;
      durationMinutes?: number;
      start_time_earliest?: string;
      startTimeEarliest?: string;
      start_time_latest?: string;
      startTimeLatest?: string;
      days_of_week?: string;
      daysOfWeek?: string;
      enabled?: boolean;
    };

    const update: Partial<typeof habits.$inferInsert> = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.duration_minutes !== undefined) update.durationMinutes = body.duration_minutes;
    if (body.durationMinutes !== undefined)  update.durationMinutes = body.durationMinutes;
    if (body.start_time_earliest !== undefined) update.startTimeEarliest = body.start_time_earliest;
    if (body.startTimeEarliest !== undefined)   update.startTimeEarliest = body.startTimeEarliest;
    if (body.start_time_latest !== undefined)   update.startTimeLatest = body.start_time_latest;
    if (body.startTimeLatest !== undefined)     update.startTimeLatest = body.startTimeLatest;
    if (body.days_of_week !== undefined) update.daysOfWeek = body.days_of_week;
    if (body.daysOfWeek !== undefined)  update.daysOfWeek = body.daysOfWeek;
    if (body.enabled !== undefined)      update.enabled = body.enabled;

    const [row] = await db.update(habits).set(update).where(eq(habits.id, id)).returning();
    if (!row) {
      ctx.status = 404;
      ctx.body = { error: 'not found' };
      return;
    }

    ctx.body = { habit: toApi(row) };
  });

  // DELETE /api/habits/:id
  router.delete('/api/habits/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const [row] = await db.delete(habits).where(eq(habits.id, id)).returning();
    if (!row) {
      ctx.status = 404;
      ctx.body = { error: 'not found' };
      return;
    }
    ctx.body = { ok: true };
  });

  return router;
}
