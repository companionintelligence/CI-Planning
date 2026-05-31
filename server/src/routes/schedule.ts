import Router from '@koa/router';
import { runScheduler } from '../engine/scheduler.js';

export function scheduleRouter() {
  const router = new Router();

  // POST /api/schedule/run  { date?: "YYYY-MM-DD" }
  router.post('/api/schedule/run', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const date = body.date ?? new Date().toISOString().slice(0, 10);
    const result = await runScheduler(date);
    ctx.body = result;
  });

  return router;
}
