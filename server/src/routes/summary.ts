import Router from '@koa/router';
import { summarizeDay } from '../agents/summarize.js';

export function summaryRouter() {
  const router = new Router();

  // GET /api/summary?date=YYYY-MM-DD
  router.get('/api/summary', async (ctx) => {
    const { date } = ctx.query as Record<string, string>;
    const day = date ?? new Date().toISOString().slice(0, 10);
    ctx.body = await summarizeDay(day);
  });

  return router;
}
