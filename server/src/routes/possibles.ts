import Router from '@koa/router';
import { broadcast } from './sse.js';
import { toApiList, taskToApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { listPossibles, promotePossible, dismissPossible } from '../services/possibles.js';
import { autoScheduleOnIngest } from '../engine/autoplan.js';

/**
 * Possible-task inbox (ingest-produced items awaiting promote/dismiss). Phase W (Decision
 * 3): the read + promote + dismiss logic lives in services/possibles.ts so REST + GraphQL
 * share ONE owner-scoped implementation; these handlers are thin shells over it. The
 * service scopes by `proposed_owner_id` (the table's owner key, T4) — closing the
 * pre-extraction cross-tenant read-leak/IDOR. writeAudit fires inside the service; SSE
 * broadcast + the best-effort TM-5 auto-schedule stay here (transport-side), in that
 * order — matching the pre-extraction route exactly, so `possible:promoted` keeps a
 * lower sync_events seq than any placement broadcast auto-schedule triggers.
 */

export function possiblesRouter() {
  const router = new Router();

  // GET /api/possible-tasks
  router.get('/api/possible-tasks', async (ctx) => {
    const { status = 'pending' } = ctx.query as Record<string, string>;
    const rows = await listPossibles(currentOwnerId(), status);
    ctx.body = { possibles: toApiList(rows) };
  });

  // POST /api/possible-tasks/:id/promote
  router.post('/api/possible-tasks/:id/promote', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const overrides = (ctx.request.body ?? {}) as Partial<{ title: string; due_at: string; priority: number }>;
    const res = await promotePossible(owner, id, overrides);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const out = taskToApi(res.task);
    broadcast(owner, 'possible:promoted', { id, task: out });
    // TM-5: in the Hands-off trust mode, auto-block the promoted work (estimate-bearing
    // only). Best-effort — a placement hiccup must not fail the promote. No-op in
    // Cautious/Balanced. Runs AFTER the broadcast (see module docstring).
    try { autoScheduleOnIngest(owner, { requireEstimate: true }); } catch { /* best-effort */ }
    ctx.status = 201;
    ctx.body = { task: out };
  });

  // POST /api/possible-tasks/:id/dismiss
  router.post('/api/possible-tasks/:id/dismiss', async (ctx) => {
    const owner = currentOwnerId();
    const id = ctx.params.id;
    const res = await dismissPossible(owner, id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(owner, 'possible:dismissed', { id });
    ctx.body = { ok: true };
  });

  return router;
}
