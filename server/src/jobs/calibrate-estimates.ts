import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { computeScopedCalibration } from '../services/calibration.js';

export interface CalibrationResult {
  sample_count: number;
  bias_ratio: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  /** Number of scoped rows written (only when the Time-Sense flag is on). */
  scopes?: number;
}

/**
 * Phase N4 — estimate calibration; Phase Z · Z0 widens it to scopes.
 *
 * For each completed task that has both estimated_minutes and actual_minutes > 0,
 * computes the ratio actual/estimated. The median (p50) is the bias_ratio: a value
 * of 1.3 means "on average you take 30% longer than you estimate."
 *
 * Time-Sense flag OFF (default): the exact Phase-N behavior — one global row,
 * plain quartiles, no outlier handling — so pre-Z owners see zero change.
 *
 * Time-Sense flag ON: full per-scope recompute (services/calibration.ts) —
 * global/subtype/tag/category/objective plus user-pinned tag combos, robust
 * math (capped ratios, median ± 3·MAD outlier drop). The owner's rows are
 * replaced wholesale each run: the table is a regenerable rollup, and a
 * delete-then-insert is what makes scopes whose samples vanished (tag deleted,
 * tasks purged) disappear instead of serving stale bias forever.
 *
 * Suggest-only invariant (design constraint 4): this job writes ONLY
 * estimate_calibration — never tasks.estimated_minutes, never tag defaults.
 */
export function calibrateEstimates(): CalibrationResult {
  const owner = currentOwnerId();

  if (timeSenseEnabled(owner)) {
    const rows = computeScopedCalibration(owner);
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      `INSERT INTO estimate_calibration (owner_id, scope_kind, scope_ref, computed_at, sample_count, bias_ratio, p25, p50, p75)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    sqlite.transaction(() => {
      sqlite.prepare(`DELETE FROM estimate_calibration WHERE owner_id = ?`).run(owner);
      for (const r of rows) {
        insert.run(owner, r.scope_kind, r.scope_ref, now, r.sample_count, r.bias_ratio, r.p25, r.p50, r.p75);
      }
    })();
    const global = rows.find((r) => r.scope_kind === 'global')!;
    return {
      sample_count: global.sample_count,
      bias_ratio: global.bias_ratio,
      p25: global.p25,
      p50: global.p50,
      p75: global.p75,
      scopes: rows.length,
    };
  }

  // ── Legacy (flag off) — Phase N math, byte-for-byte ─────────────────────────
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
        `INSERT INTO estimate_calibration (owner_id, scope_kind, scope_ref, computed_at, sample_count, bias_ratio, p25, p50, p75)
         VALUES (?, 'global', '', ?, 0, NULL, NULL, NULL, NULL)
         ON CONFLICT(owner_id, scope_kind, scope_ref) DO UPDATE SET
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
      `INSERT INTO estimate_calibration (owner_id, scope_kind, scope_ref, computed_at, sample_count, bias_ratio, p25, p50, p75)
       VALUES (?, 'global', '', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, scope_kind, scope_ref) DO UPDATE SET
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
