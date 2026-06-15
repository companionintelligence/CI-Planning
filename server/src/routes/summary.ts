import Router from '@koa/router';
import { summarizeDay } from '../agents/summarize.js';
import { localISODate } from '../lib/dates.js';

export function summaryRouter() {
  const router = new Router();

  // GET /api/summary?date=YYYY-MM-DD&refresh=1
  router.get('/api/summary', async (ctx) => {
    const { date, refresh } = ctx.query as Record<string, string>;
    const day = date ?? localISODate();
    ctx.body = await summarizeDay(day, { refresh: refresh === '1' || refresh === 'true' });
  });

  return router;
}
