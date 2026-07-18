import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { isoWeekKey } from '../lib/tz.js';

/** The discriminated shape `GET /api/calibration` has always returned. */
export type CalibrationReadout =
  | { calibrated: false; sample_count: number }
  | {
      calibrated: true; sample_count: number; bias_ratio: number;
      p25: number | null; p50: number | null; p75: number | null;
      computed_at: string; label: string;
    };

/**
 * The owner's global estimate-calibration readout.
 *
 * Lifted VERBATIM out of the `GET /api/calibration` handler (routes/review.ts) so the
 * legacy endpoint and T5's weekly-review aggregation cannot drift apart. This is a
 * source-of-truth dedup, not a behavior change: the endpoint's response must stay
 * byte-identical, and a test pins that.
 */
export function globalCalibrationReadout(owner: string): CalibrationReadout {
  const row = sqlite
    .prepare(
      // Z0 (0107) scope-keyed this table; this legacy surface reads the global
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
    return { calibrated: false, sample_count: row?.sample_count ?? 0 };
  }

  const pct = Math.round(Math.abs(row.bias_ratio - 1) * 100);
  const direction = row.bias_ratio > 1 ? 'longer' : 'shorter';
  const label = row.bias_ratio === 1
    ? 'Your estimates are accurate'
    : `You tend to take ${pct}% ${direction} than estimated`;

  return {
    calibrated: true,
    sample_count: row.sample_count,
    bias_ratio: row.bias_ratio,
    p25: row.p25,
    p50: row.p50,
    p75: row.p75,
    computed_at: row.computed_at,
    label,
  };
}

export interface WeekReview {
  week_key: string;
  /** Mon→Sun (7 YYYY-MM-DD strings). */
  days: string[];
  tasks_completed: number;
  /** Tasks whose due_at falls in this week but are still open. */
  tasks_overdue: number;
  blocks_count: number;
  weekly_goals: Array<{ position: number; body: string; done_at: string | null }>;
  /** Active objectives with progress_cache IS NULL. */
  objectives_rotting: number;
}

function addDays(dateStr: string, n: number): string {
  const dt = new Date(dateStr + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function weekDays(anchor: string): string[] {
  const dow = new Date(anchor + 'T12:00:00Z').getUTCDay(); // 0=Sun
  const monday = addDays(anchor, -(dow === 0 ? 6 : dow - 1));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function weeklyReview(anchor: string): WeekReview {
  const owner = currentOwnerId();
  const days = weekDays(anchor);
  const week_key = isoWeekKey(anchor);

  // UTC range: start of Mon 00:00 → end of Sun 23:59:59.999
  const rangeStart = days[0] + 'T00:00:00.000Z';
  const rangeEnd = days[6] + 'T23:59:59.999Z';

  const { tasks_completed } = sqlite
    .prepare(
      `SELECT COUNT(*) AS tasks_completed FROM tasks
       WHERE owner_id = ? AND status = 'done'
         AND completed_at >= ? AND completed_at <= ?`,
    )
    .get(owner, rangeStart, rangeEnd) as { tasks_completed: number };

  const { tasks_overdue } = sqlite
    .prepare(
      `SELECT COUNT(*) AS tasks_overdue FROM tasks
       WHERE owner_id = ? AND status NOT IN ('done','dropped','archived')
         AND due_at >= ? AND due_at <= ?`,
    )
    .get(owner, rangeStart, rangeEnd) as { tasks_overdue: number };

  const { blocks_count } = sqlite
    .prepare(
      `SELECT COUNT(*) AS blocks_count FROM time_blocks
       WHERE owner_id = ? AND start_at >= ? AND start_at <= ?`,
    )
    .get(owner, rangeStart, rangeEnd) as { blocks_count: number };

  const weekly_goals = sqlite
    .prepare(
      `SELECT position, body, done_at FROM reflections
       WHERE owner_id = ? AND kind = 'weekly_goal' AND period_key = ?
       ORDER BY position`,
    )
    .all(owner, week_key) as Array<{ position: number; body: string; done_at: string | null }>;

  const { objectives_rotting } = sqlite
    .prepare(
      `SELECT COUNT(*) AS objectives_rotting FROM objectives
       WHERE owner_id = ? AND status = 'active' AND progress_cache IS NULL`,
    )
    .get(owner) as { objectives_rotting: number };

  return { week_key, days, tasks_completed, tasks_overdue, blocks_count, weekly_goals, objectives_rotting };
}
