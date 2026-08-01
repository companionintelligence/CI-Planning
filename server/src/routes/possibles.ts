import Router from '@koa/router';
import { broadcast } from './sse.js';
import { logger } from '../lib/logger.js';
import { toApiList, taskToApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { listPossibles, promotePossible, dismissPossible } from '../services/possibles.js';
import { requiresReview } from '../services/review-gate.js';
import { autoScheduleOnIngest, placeStartAnchoredTask } from '../engine/autoplan.js';

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

  // GET /api/possible-tasks[?review=1]
  // `review=1` narrows to the review-gated sources (email) — the queue the client's
  // suggestions surface renders. Without it the response is unchanged, so every
  // existing consumer (and the characterization snapshot) sees exactly what it did.
  router.get('/api/possible-tasks', async (ctx) => {
    const { status = 'pending', review } = ctx.query as Record<string, string>;
    const rows = await listPossibles(currentOwnerId(), status);
    const filtered = review ? rows.filter((r) => requiresReview(r.sourceKind)) : rows;
    ctx.body = { possibles: toApiList(filtered) };
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
    // Best-effort placement — a hiccup must not fail the promote. Runs AFTER the
    // broadcast (see module docstring). AB1: a task with a START intent is placed at
    // it in ANY trust mode (the user/suggestion stated the day — honoring it is not
    // engine autonomy); a start-less task keeps the TM-5 trust-gated hands-off
    // auto-block (estimate-bearing only; no-op in Cautious/Balanced).
    try {
      if (res.task.scheduledFor) placeStartAnchoredTask(owner, res.taskId);
      else autoScheduleOnIngest(owner, { requireEstimate: true });
    } catch (err) {
      // Best-effort — promote already succeeded; surface the reason so a placement
      // regression is diagnosable rather than silently invisible.
      logger.warn('promote: post-promote placement failed', { owner, taskId: res.taskId, err: (err as Error).message });
    }
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
