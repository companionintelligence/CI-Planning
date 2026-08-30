import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { planLoopTrend } from '../services/plan-loop-learning.js';

/**
 * Plan-loop-learning REST surface — the revision-loop wave's terminus (ticket 4).
 * A thin, ungated, owner-scoped adapter over `services/plan-loop-learning.ts`; zero
 * business logic lives here.
 *
 * This is deliberately the END of the wave: a trend a human reads before editing
 * the §A0 authoring prompt or its pass threshold. There is no apply stage — nothing
 * here adjusts what the loop does next — and, unlike `DELETE
 * /api/classification/exemplars`, there is no reset endpoint either: exemplars
 * *influence behaviour*, so resetting them means something; nothing in this wave
 * does, so there is nothing to reset (see docs/factory/revision-loop-wave/README.md,
 * "Decisions of record").
 *
 * No feature-flag gate, unlike routes/calibration.ts: this learning has no flag to
 * be off. An owner with no smart-mode runs yet simply has an empty trend, which is
 * the same thing this endpoint reports on a fresh install.
 */
export function planLoopRouter() {
  const router = new Router({ prefix: '/api/plan-loop' });

  // GET /api/plan-loop/trend — the measured `plan_loop_stats` rows, newest run
  // first. This follows accuracyTrend / GET /api/classification/accuracy's
  // convention (computed_date DESC, then the tie-break column) — NOT
  // metrics.ts's GET /api/metrics/calibration, which reverses to chronological
  // ascending order. classification/accuracy is the closer peer (both are a
  // per-stage/per-field learning trend read straight off a stats table with no
  // apply stage), so this route matches it; a client that wants chronological
  // order can reverse the array itself.
  //
  // `avg_iterations` / `pass_rate` serialise as `null` when the stored value is
  // NULL — never coerced to 0 — so a chart draws a gap, not a false floor.
  router.get('/trend', async (ctx) => {
    const limit = Math.min(Math.max(Number((ctx.query as Record<string, string>).limit) || 26, 1), 365);
    ctx.body = { runs: await planLoopTrend(currentOwnerId(), limit) };
  });

  return router;
}
