import Router from '@koa/router';
import { weeklyReview } from '../services/weekly-review.js';
import { localISODate } from '../lib/dates.js';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';

export function reviewRouter() {
  const router = new Router();

  // GET /api/review/week?anchor=YYYY-MM-DD
  // Returns the weekly review stats for the ISO week containing `anchor`.
  // Defaults to today's week when anchor is omitted.
  router.get('/api/review/week', (ctx) => {
    const anchor = (ctx.query.anchor as string | undefined) ?? localISODate();
    ctx.body = weeklyReview(anchor);
  });

  // GET /api/calibration
  // Returns the latest estimate calibration for the owner.
  // `calibrated: false` when no timed tasks have been measured yet.
  router.get('/api/calibration', (ctx) => {
    const owner = currentOwnerId();
    const row = sqlite
      .prepare(
        // Z0 (0106) scope-keyed this table; this legacy surface reads the global
        // row explicitly — without the filter it would grab an arbitrary scope.
        `SELECT computed_at, sample_count, bias_ratio, p25, p50, p75
         FROM estimate_calibration WHERE owner_id = ? AND scope_kind = 'global' AND scope_ref = ''`,
      )
      .get(owner) as {
        computed_at: string;
        sample_count: number;
        bias_ratio: number | null;
        p25: number | null;
        p50: number | null;
        p75: number | null;
      } | undefined;

    if (!row || row.bias_ratio == null) {
      ctx.body = { calibrated: false, sample_count: row?.sample_count ?? 0 };
      return;
    }

    const pct = Math.round(Math.abs(row.bias_ratio - 1) * 100);
    const direction = row.bias_ratio > 1 ? 'longer' : 'shorter';
    const label = row.bias_ratio === 1
      ? 'Your estimates are accurate'
      : `You tend to take ${pct}% ${direction} than estimated`;

    ctx.body = {
      calibrated: true,
      sample_count: row.sample_count,
      bias_ratio: row.bias_ratio,
      p25: row.p25,
      p50: row.p50,
      p75: row.p75,
      computed_at: row.computed_at,
      label,
    };
  });

  return router;
}
