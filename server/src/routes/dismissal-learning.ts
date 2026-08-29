import Router from '@koa/router';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Close-loop wave, ticket 6 — the readout for `calibrate_dismissals` (ticket 3). Same
 * shape as `routes/calibration.ts`, the closest peer: a read surface over a learning
 * table plus a small mutation. Two endpoints:
 *
 *  - `GET /trend` — the owner's `possible_dismissal_rate` rows, oldest → newest,
 *    capped by `limit` (default 90). Mirrors `GET /api/metrics/calibration`'s dated-
 *    trend shape: newest `limit` rows read off DESC + LIMIT, then flipped to
 *    chronological, so the client can plot straight through without reversing.
 *  - `DELETE /exemplars` — clears this owner's rollup (`possible_dismissal_exemplars`)
 *    only. `possible_outcome_log`, the durable evidence, is never touched here — the
 *    reset re-earns the adaptation from evidence the owner already generated, and the
 *    next `calibrate_dismissals` run rebuilds the rollup wholesale from it.
 *
 * No feature flag: unlike calibration.ts's Time-Sense gate, this loop has none to
 * inherit — both routes sit behind the standard `/api/*` auth gate only, with the
 * owner coming from `currentOwnerId()`, same as every other owner-scoped surface.
 *
 * This is intentionally the ONLY reader: ticket 3 computes `rate`, this reads it back
 * unchanged. `rate` is `NULL` for a period with `decided = 0` in the table itself, and
 * that is preserved verbatim here — never coerced to `0` — so a consumer can draw a
 * gap in the trend rather than a line through the floor.
 */
export function dismissalLearningRouter() {
  const router = new Router({ prefix: '/api/dismissal-learning' });

  // GET /api/dismissal-learning/trend?limit=90 — this owner's noise-rate readings,
  // oldest → newest.
  router.get('/trend', async (ctx) => {
    const owner = currentOwnerId();
    const limit = Math.max(1, Math.min(365, Number(ctx.query.limit ?? 90) || 90));
    // Newest `limit` rows, then flipped to chronological — a plain ASC + LIMIT would
    // return the OLDEST readings and silently stop updating once history exceeded it.
    const rows = await store()
      .prepare(
        `SELECT computed_date, period_days, created, decided, dismissed, rate, exemplars, hinted
           FROM possible_dismissal_rate
          WHERE owner_id = ?
          ORDER BY computed_date DESC LIMIT ?`,
      )
      .all<Record<string, unknown>>(owner, limit);
    ctx.body = { trend: rows.reverse() };
  });

  // DELETE /api/dismissal-learning/exemplars — clear this owner's rollup only. The
  // evidence log is untouched: the next calibrate_dismissals run rebuilds the rollup
  // wholesale from the surviving possible_outcome_log rows.
  router.delete('/exemplars', async (ctx) => {
    const owner = currentOwnerId();
    const res = await store()
      .prepare(`DELETE FROM possible_dismissal_exemplars WHERE owner_id = ?`)
      .run(owner);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reset', entity: 'dismissal_learning:exemplars' });
    ctx.body = { ok: true, cleared: res.changes };
  });

  return router;
}
