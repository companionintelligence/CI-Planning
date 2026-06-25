import Router from '@koa/router';
import { reflow } from '../engine/auto-defense.js';
import { localISODate } from '../lib/dates.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

export function scheduleRouter() {
  const router = new Router();

  // POST /api/schedule/run  { date?: "YYYY-MM-DD" }
  // B1: drives deterministic reflow (re-places movable blocks from daily_plan order).
  router.post('/api/schedule/run', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const date = body.date ?? localISODate();
    const owner = currentOwnerId();
    const diff = reflow(owner, date, 'manual');
    writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: `schedule:${date}` });
    ctx.body = diff;
  });

  return router;
}
