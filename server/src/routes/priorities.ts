import Router from '@koa/router';
import { listPriorities, upsertPriorities } from '../services/priorities.js';

/**
 * Thin transport over services/priorities.ts. Owner-scoping + validation + clamping
 * live in the service (the same code path any future GraphQL resolver would call);
 * the route only shapes requests/responses. Auto-gated by the central requireAuth
 * (`/api/priorities` is not in PUBLIC_PREFIXES): GET needs read, POST needs write.
 */
export function prioritiesRouter() {
  const router = new Router();

  // GET /api/priorities — the current owner's life-priority audit.
  router.get('/api/priorities', (ctx) => {
    ctx.body = { priorities: listPriorities() };
  });

  // POST /api/priorities — upsert a batch (keyed by category). Body: { priorities: [...] }.
  router.post('/api/priorities', (ctx) => {
    const body = ctx.request.body as { priorities?: unknown };
    if (!body || !Array.isArray(body.priorities)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid payload: priorities array is required' };
      return;
    }
    ctx.body = { priorities: upsertPriorities(body.priorities) };
  });

  return router;
}
