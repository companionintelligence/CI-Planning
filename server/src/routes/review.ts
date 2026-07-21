import Router from '@koa/router';
import { weeklyReview, globalCalibrationReadout } from '../services/weekly-review.js';
import { reviewAndReschedule } from '../engine/review.js';
import { localISODate } from '../lib/dates.js';
import { currentOwnerId } from '../lib/context.js';

export function reviewRouter() {
  const router = new Router();

  // POST /api/review/sweep — the top-bar refresh button: run the review sweep NOW
  // for the current owner (same engine as the nightly review_day cron, owner-scoped).
  // Past-due planned tasks auto-defer with backoff, stuck 'missed' one-offs revive
  // to open, and hands_off owners get everything reopened placed into its new day.
  // Idempotent — a second click with nothing stale is a no-op returning zeros.
  router.post('/api/review/sweep', (ctx) => {
    ctx.body = { result: reviewAndReschedule({ owner: currentOwnerId() }) };
  });

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
  // The readout itself now lives in services/weekly-review.ts so T5's weekly aggregation
  // reads the same source of truth. This handler's response is unchanged.
  router.get('/api/calibration', (ctx) => {
    ctx.body = globalCalibrationReadout(currentOwnerId());
  });

  return router;
}
