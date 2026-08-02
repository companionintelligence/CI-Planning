import Router from '@koa/router';
import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { trialityEnabled } from '../lib/flags.js';
import { taskMetrics } from '../services/task-metrics.js';
import { trialityMetrics } from '../services/triality-metrics.js';

/**
 * Read-only metrics surface behind the Balance view's Metrics tab: task counts, timed
 * effort, estimate bias, and close-ritual mood across the two axes the user thinks in —
 * DIRECTION (Work/Home/Community) and CATEGORY (the six life priorities) — plus the
 * calibration trend that answers "am I getting better at estimating?".
 *
 * Pure reads; no writes anywhere in this router.
 */
export function metricsRouter() {
  const router = new Router();

  // GET /api/metrics/tasks?days=30 — the two-axis rollup. `days` is clamped inside the
  // service (1..365), so a hostile or fat-fingered value can't turn this into a full scan.
  router.get('/api/metrics/tasks', (ctx) => {
    const days = Number((ctx.query.days as string) ?? '30');
    ctx.body = taskMetrics(currentOwnerId(), days);
  });

  // GET /api/metrics/calibration?scope_kind=global&scope_ref=&limit=90 — the dated
  // readings from calibration_history (0138), oldest→newest so the client can plot
  // straight through without reversing.
  //
  // This is the ONLY place the trend can come from: estimate_calibration is a regenerable
  // rollup whose rows are replaced wholesale by the nightly job, so it holds exactly one
  // reading — today's. The history table exists precisely because that made improvement
  // over time unmeasurable.
  router.get('/api/metrics/calibration', async (ctx) => {
    const owner = currentOwnerId();
    const scopeKind = (ctx.query.scope_kind as string) || 'global';
    const scopeRef = (ctx.query.scope_ref as string) ?? '';
    const limit = Math.max(1, Math.min(365, Number(ctx.query.limit ?? 90) || 90));
    // Newest `limit` rows, then flipped to chronological — a plain ASC + LIMIT would
    // return the OLDEST readings and silently stop updating once history exceeded it.
    const rows = await store()
      .prepare(
        `SELECT computed_date, sample_count, bias_ratio, p25, p50, p75
           FROM calibration_history
          WHERE owner_id = ? AND scope_kind = ? AND scope_ref = ?
          ORDER BY computed_date DESC LIMIT ?`,
      )
      .all<Record<string, unknown>>(owner, scopeKind, scopeRef, limit);
    ctx.body = { scope_kind: scopeKind, scope_ref: scopeRef, readings: rows.reverse() };
  });

  // GET /api/metrics/triality?days=30 — what the suggestions DID (design §9.2):
  // acceptance per slot (pending <24h rows excluded from denominators), the Novel
  // uptake trend, deficit response ("moved with", never "because"), and learned
  // weights (null until the learning wave writes them). 404 while the flag is
  // off — same posture as every other Triality surface.
  router.get('/api/metrics/triality', (ctx) => {
    const owner = currentOwnerId();
    if (!trialityEnabled(owner)) {
      ctx.status = 404;
      ctx.body = { error: 'Not found' };
      return;
    }
    const days = Number((ctx.query.days as string) ?? '30');
    ctx.body = trialityMetrics(owner, new Date(), days);
  });

  return router;
}
