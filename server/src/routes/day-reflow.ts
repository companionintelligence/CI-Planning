import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { detectDayConflicts } from '../engine/day-conflicts.js';
import { proposeDayReflow, applyDayReflow } from '../engine/day-reflow.js';
import { broadcast } from './sse.js';

const isISODate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Day-type conflicts and the confirmed reflow (Phase 7).
 *
 * Three endpoints, and the split between them is the feature's whole contract:
 * conflicts and preview are READS (nothing moves by looking), and only the explicit
 * POST mutates. The owner is approving an outcome, so apply recomputes the proposal
 * rather than trusting a payload — see `applyDayReflow`.
 */
export function dayReflowRouter() {
  const router = new Router();

  // GET /api/days/:date/conflicts — tasks now outside their direction's windows.
  router.get('/api/days/:date/conflicts', async (ctx) => {
    const { date } = ctx.params;
    if (!isISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    ctx.body = await detectDayConflicts(currentOwnerId(), date);
  });

  // GET /api/days/:date/reflow/preview — exactly what a reflow would do. Writes nothing.
  router.get('/api/days/:date/reflow/preview', async (ctx) => {
    const { date } = ctx.params;
    if (!isISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    ctx.body = await proposeDayReflow(currentOwnerId(), date);
  });

  // POST /api/days/:date/reflow/apply — the confirmation. The ONLY mutating path.
  router.post('/api/days/:date/reflow/apply', async (ctx) => {
    const owner = currentOwnerId();
    const { date } = ctx.params;
    if (!isISODate(date)) { ctx.status = 422; ctx.body = { error: 'date must be YYYY-MM-DD' }; return; }
    const result = await applyDayReflow(owner, date);
    if (result.moved || result.unscheduled) {
      broadcast(owner, 'block:updated', { reflowed: date, ...result });
    }
    ctx.body = result;
  });

  return router;
}
