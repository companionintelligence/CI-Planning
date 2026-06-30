import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';

export interface CalibrationResult {
  sample_count: number;
  bias_ratio: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

/**
 * Phase N4 — estimate calibration.
 *
 * For each completed task that has both estimated_minutes and actual_minutes > 0,
 * computes the ratio actual/estimated. The median (p50) is the bias_ratio: a value
 * of 1.3 means "on average you take 30% longer than you estimate."
 *
 * Persists the result in estimate_calibration (upsert) and returns the stats.
 */
export function calibrateEstimates(): CalibrationResult {
  const owner = currentOwnerId();

  // Fetch all qualifying ratios. SQLite has no built-in PERCENTILE, so we sort in JS.
  const rows = sqlite
    .prepare(
      `SELECT CAST(actual_minutes AS REAL) / estimated_minutes AS ratio
       FROM tasks
       WHERE owner_id = ?
         AND status = 'done'
         AND estimated_minutes > 0
         AND actual_minutes > 0
       ORDER BY ratio ASC`,
    )
    .all(owner) as { ratio: number }[];

  const now = new Date().toISOString();

  if (rows.length === 0) {
    sqlite
      .prepare(
        `INSERT INTO estimate_calibration (owner_id, computed_at, sample_count, bias_ratio, p25, p50, p75)
         VALUES (?, ?, 0, NULL, NULL, NULL, NULL)
         ON CONFLICT(owner_id) DO UPDATE SET
           computed_at  = excluded.computed_at,
           sample_count = 0,
           bias_ratio   = NULL,
           p25          = NULL,
           p50          = NULL,
           p75          = NULL`,
      )
      .run(owner, now);
    return { sample_count: 0, bias_ratio: null, p25: null, p50: null, p75: null };
  }

  const n = rows.length;
  const at = (frac: number) => {
    const idx = Math.min(Math.max(0, Math.round(frac * (n - 1))), n - 1);
    return rows[idx].ratio;
  };
  const p25 = at(0.25);
  const p50 = at(0.5);
  const p75 = at(0.75);

  sqlite
    .prepare(
      `INSERT INTO estimate_calibration (owner_id, computed_at, sample_count, bias_ratio, p25, p50, p75)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         computed_at  = excluded.computed_at,
         sample_count = excluded.sample_count,
         bias_ratio   = excluded.bias_ratio,
         p25          = excluded.p25,
         p50          = excluded.p50,
         p75          = excluded.p75`,
    )
    .run(owner, now, n, p50, p25, p50, p75);

  return { sample_count: n, bias_ratio: p50, p25, p50, p75 };
}
