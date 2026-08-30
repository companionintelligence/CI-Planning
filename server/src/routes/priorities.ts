import Router from '@koa/router';
import { listPriorities, upsertPriorities } from '../services/priorities.js';
import { balanceHistory } from '../services/balance-snapshot.js';
import { currentOwnerId } from '../lib/context.js';

/**
 * Thin transport over services/priorities.ts. Owner-scoping + validation + clamping
 * live in the service (the same code path any future GraphQL resolver would call);
 * the route only shapes requests/responses. Auto-gated by the central requireAuth
 * (`/api/priorities` is not in PUBLIC_PREFIXES): GET needs read, POST needs write.
 */
export function prioritiesRouter() {
  const router = new Router();

  // GET /api/priorities — the current owner's life-priority audit.
  router.get('/api/priorities', async (ctx) => {
    ctx.body = { priorities: await listPriorities() };
  });

  // POST /api/priorities — upsert a batch (keyed by category). Body: { priorities: [...] }.
  router.post('/api/priorities', async (ctx) => {
    const body = ctx.request.body as { priorities?: unknown };
    if (!body || !Array.isArray(body.priorities)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid payload: priorities array is required' };
      return;
    }
    ctx.body = { priorities: await upsertPriorities(body.priorities) };
  });

  // GET /api/priorities/history — bal-7's met/counted readout over the frozen
  // balance_week_log history (services/balance-snapshot.ts). Pure read, no pref
  // gate — same reasoning as ticket 5.
  router.get('/api/priorities/history', async (ctx) => {
    ctx.body = await balanceHistory(currentOwnerId());
  });

  return router;
}
