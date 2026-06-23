import Router from '@koa/router';
import { runScheduler } from '../engine/scheduler.js';
import { localISODate } from '../lib/dates.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

export function scheduleRouter() {
  const router = new Router();

  // POST /api/schedule/run  { date?: "YYYY-MM-DD" }
  router.post('/api/schedule/run', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { date?: string };
    const date = body.date ?? localISODate();
    const result = await runScheduler(date);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'run', entity: `schedule:${date}` });
    ctx.body = result;
  });

  return router;
}
