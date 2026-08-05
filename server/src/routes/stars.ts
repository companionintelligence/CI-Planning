import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { isValidISODate } from '../lib/dates.js';
import { listDayStars } from '../services/stars.js';

export function starsRouter() {
  const router = new Router();

  // GET /api/stars?from=YYYY-MM-DD&to=YYYY-MM-DD
  // For each date in range: the frozen daily_recap row if present, else live
  // computeStars. One range query backs a whole calendar month. The owner-scoped
  // read lives in services/stars.ts (shared with the GraphQL surface).
  router.get('/api/stars', async (ctx) => {
    const from = ctx.query.from as string | undefined;
    const to = ctx.query.to as string | undefined;
    if (!isValidISODate(from) || !isValidISODate(to)) {
      ctx.status = 422;
      ctx.body = { error: 'from and to are required (YYYY-MM-DD)' };
      return;
    }
    ctx.body = await listDayStars(currentOwnerId(), from, to);
  });

  return router;
}
