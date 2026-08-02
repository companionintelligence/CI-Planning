import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { localISODate } from '../lib/dates.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { computeScopedCalibration } from '../services/calibration.js';

/** One dated reading per scope, appended to the history table (0138). */
interface HistoryRow {
  scope_kind: string;
  scope_ref: string;
  sample_count: number;
  bias_ratio: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

// SQL at module level, prepared inside recordHistory — a module-level store()
// call would throw when this module loads before db/index installs the backend.
const INSERT_HISTORY_SQL =
  `INSERT INTO calibration_history (owner_id, scope_kind, scope_ref, computed_date, sample_count, bias_ratio, p25, p50, p75)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(owner_id, scope_kind, scope_ref, computed_date) DO UPDATE SET
     sample_count = excluded.sample_count,
     bias_ratio   = excluded.bias_ratio,
     p25          = excluded.p25,
     p50          = excluded.p50,
     p75          = excluded.p75`;

/**
 * Append today's readings to `calibration_history` (owner ruling 2026-07-28: the history
 * must NOT be recomputed away).
 *
 * The rollup table above is regenerable by design — its delete-then-insert is what lets a
 * vanished scope disappear — so trend data cannot live there. This is the durable twin:
 * keyed by DAY, so a manual re-run or a cron retry overwrites today's reading instead of
 * stacking duplicates that would over-weight one day in a trend line. Never deletes.
 */
async function recordHistory(owner: string, rows: HistoryRow[], date: string): Promise<void> {
  const insertHistory = store().prepare(INSERT_HISTORY_SQL);
  for (const r of rows) {
    await insertHistory.run(owner, r.scope_kind, r.scope_ref, date, r.sample_count, r.bias_ratio, r.p25, r.p50, r.p75);
  }
}

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
export async function calibrateEstimates(): Promise<CalibrationResult> {
  const owner = currentOwnerId();

  if (await timeSenseEnabled(owner)) {
    const rows = await computeScopedCalibration(owner);
    const now = new Date().toISOString();
    const insert = store().prepare(
      `INSERT INTO estimate_calibration (owner_id, scope_kind, scope_ref, computed_at, sample_count, bias_ratio, p25, p50, p75)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const today = localISODate();
    await store().transaction(async () => {
      await store().prepare(`DELETE FROM estimate_calibration WHERE owner_id = ?`).run(owner);
      for (const r of rows) {
        await insert.run(owner, r.scope_kind, r.scope_ref, now, r.sample_count, r.bias_ratio, r.p25, r.p50, r.p75);
      }
      // Same transaction: the rollup and its dated snapshot must never disagree.
      await recordHistory(owner, rows, today);
    });
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
  // Purge any scoped rows left behind from a prior flag-ON run, so flag-off is a
  // true single-global-row state: otherwise a stale tag/category/objective row
  // could still bias a suggestion if the flag is flipped back on before the next
  // nightly recompute (the flag-ON branch's wholesale delete would fix it, but
  // only once it runs).
  await store()
    .prepare(`DELETE FROM estimate_calibration WHERE owner_id = ? AND NOT (scope_kind = 'global' AND scope_ref = '')`)
    .run(owner);

  // Fetch all qualifying ratios. SQLite has no built-in PERCENTILE, so we sort in JS.
  const rows = await store()
    .prepare(
      `SELECT CAST(actual_minutes AS REAL) / estimated_minutes AS ratio
       FROM tasks
       WHERE owner_id = ?
         AND status = 'done'
         AND estimated_minutes > 0
         AND actual_minutes > 0
       ORDER BY ratio ASC`,
    )
    .all<{ ratio: number }>(owner);

  const now = new Date().toISOString();

  if (rows.length === 0) {
    await store()
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
    // A zero-sample day is still a reading: it records that the owner had nothing to
    // calibrate on, which is what makes a later trend line start where the data does.
    await recordHistory(owner, [{ scope_kind: 'global', scope_ref: '', sample_count: 0, bias_ratio: null, p25: null, p50: null, p75: null }], localISODate());
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

  await store()
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

  await recordHistory(owner, [{ scope_kind: 'global', scope_ref: '', sample_count: n, bias_ratio: p50, p25, p50, p75 }], localISODate());

  return { sample_count: n, bias_ratio: p50, p25, p50, p75 };
}
