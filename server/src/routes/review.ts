import Router from '@koa/router';
import { weeklyReview, globalCalibrationReadout } from '../services/weekly-review.js';
import { localISODate } from '../lib/dates.js';
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
  // The readout itself now lives in services/weekly-review.ts so T5's weekly aggregation
  // reads the same source of truth. This handler's response is unchanged.
  router.get('/api/calibration', (ctx) => {
    ctx.body = globalCalibrationReadout(currentOwnerId());
  });

  return router;
}
