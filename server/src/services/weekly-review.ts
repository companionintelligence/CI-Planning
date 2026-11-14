import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { addDays, isoWeekKey, weekDays } from '../lib/tz.js';

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
export async function globalCalibrationReadout(owner: string): Promise<CalibrationReadout> {
  const row = await store()
    .prepare(
      // Z0 (0107) scope-keyed this table; this legacy surface reads the global
      // row explicitly — without the filter it would grab an arbitrary scope.
      `SELECT computed_at, sample_count, bias_ratio, p25, p50, p75
       FROM estimate_calibration WHERE owner_id = ? AND scope_kind = 'global' AND scope_ref = ''`,
    )
    .get<{
      computed_at: string;
      sample_count: number;
      bias_ratio: number | null;
      p25: number | null;
      p50: number | null;
      p75: number | null;
    }>(owner);

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
  /** Open tasks with due dates in this review range, for direct attention links. */
  open_due_tasks: Array<{ id: string; title: string; due_at: string }>;
  blocks_count: number;
  weekly_goals: Array<{ position: number; body: string; done_at: string | null }>;
  /** Active objectives with progress_cache IS NULL. */
  objectives_rotting: number;
  /** Active objectives with no computed progress, for direct attention links. */
  objectives_need_attention: Array<{ id: string; title: string }>;
}

export interface MonthReview {
  /** Inclusive trailing 30-day range, ending on the requested local date. */
  range_start: string;
  range_end: string;
  tasks_completed: number;
  /** Tasks whose due_at falls in the range but are still open. */
  tasks_overdue: number;
  /** Open tasks with due dates in this review range, for direct attention links. */
  open_due_tasks: Array<{ id: string; title: string; due_at: string }>;
  blocks_count: number;
  /** Active objectives with progress_cache IS NULL. */
  objectives_rotting: number;
  /** Active objectives with no computed progress, for direct attention links. */
  objectives_need_attention: Array<{ id: string; title: string }>;
}

// Code-review fix: `addDays`/`weekDays` used to be private copies here, byte-identical
// to `services/balance-budget.ts`'s (and to a third private copy inlined in
// `lib/tz.ts`'s `isoWeekKey`) — now shared from `lib/tz.ts`.

export async function weeklyReview(anchor: string): Promise<WeekReview> {
  const owner = currentOwnerId();
  const days = weekDays(anchor);
  const week_key = isoWeekKey(anchor);

  // UTC range: start of Mon 00:00 → end of Sun 23:59:59.999
  const rangeStart = days[0] + 'T00:00:00.000Z';
  const rangeEnd = days[6] + 'T23:59:59.999Z';

  const { tasks_completed } = (await store()
    .prepare(
      `SELECT COUNT(*) AS tasks_completed FROM tasks
       WHERE owner_id = ? AND status = 'done'
         AND completed_at >= ? AND completed_at <= ?`,
    )
    .get<{ tasks_completed: number }>(owner, rangeStart, rangeEnd))!;

  const open_due_tasks = await store()
    .prepare(
      `SELECT id, title, due_at FROM tasks
       WHERE owner_id = ? AND status NOT IN ('done','dropped','cancelled','archived')
         AND due_at >= ? AND due_at <= ?
       ORDER BY due_at ASC, priority ASC, title COLLATE NOCASE ASC`,
    )
    .all<{ id: string; title: string; due_at: string }>(owner, rangeStart, rangeEnd);
  const tasks_overdue = open_due_tasks.length;

  const { blocks_count } = (await store()
    .prepare(
      `SELECT COUNT(*) AS blocks_count FROM time_blocks
       WHERE owner_id = ? AND start_at >= ? AND start_at <= ?`,
    )
    .get<{ blocks_count: number }>(owner, rangeStart, rangeEnd))!;

  const weekly_goals = await store()
    .prepare(
      `SELECT position, body, done_at FROM reflections
       WHERE owner_id = ? AND kind = 'weekly_goal' AND period_key = ?
       ORDER BY position`,
    )
    .all<{ position: number; body: string; done_at: string | null }>(owner, week_key);

  const objectives_need_attention = await store()
    .prepare(
      `SELECT id, title FROM objectives
       WHERE owner_id = ? AND status = 'active' AND progress_cache IS NULL AND archived_at IS NULL
       ORDER BY updated_at DESC, title COLLATE NOCASE ASC`,
    )
    .all<{ id: string; title: string }>(owner);
  const objectives_rotting = objectives_need_attention.length;

  return {
    week_key, days, tasks_completed, tasks_overdue, open_due_tasks, blocks_count,
    weekly_goals, objectives_rotting, objectives_need_attention,
  };
}

/** Recap activity across the 30 calendar days ending on `endDate` (inclusive). */
export async function monthlyReview(endDate: string): Promise<MonthReview> {
  const owner = currentOwnerId();
  const range_start = addDays(endDate, -29);
  const range_end = endDate;
  const rangeStart = range_start + 'T00:00:00.000Z';
  const rangeEnd = range_end + 'T23:59:59.999Z';

  const { tasks_completed } = (await store()
    .prepare(
      `SELECT COUNT(*) AS tasks_completed FROM tasks
       WHERE owner_id = ? AND status = 'done'
         AND completed_at >= ? AND completed_at <= ?`,
    )
    .get<{ tasks_completed: number }>(owner, rangeStart, rangeEnd))!;

  const open_due_tasks = await store()
    .prepare(
      `SELECT id, title, due_at FROM tasks
       WHERE owner_id = ? AND status NOT IN ('done','dropped','cancelled','archived')
         AND due_at >= ? AND due_at <= ?
       ORDER BY due_at ASC, priority ASC, title COLLATE NOCASE ASC`,
    )
    .all<{ id: string; title: string; due_at: string }>(owner, rangeStart, rangeEnd);
  const tasks_overdue = open_due_tasks.length;

  const { blocks_count } = (await store()
    .prepare(
      `SELECT COUNT(*) AS blocks_count FROM time_blocks
       WHERE owner_id = ? AND start_at >= ? AND start_at <= ?`,
    )
    .get<{ blocks_count: number }>(owner, rangeStart, rangeEnd))!;

  const objectives_need_attention = await store()
    .prepare(
      `SELECT id, title FROM objectives
       WHERE owner_id = ? AND status = 'active' AND progress_cache IS NULL AND archived_at IS NULL
       ORDER BY updated_at DESC, title COLLATE NOCASE ASC`,
    )
    .all<{ id: string; title: string }>(owner);
  const objectives_rotting = objectives_need_attention.length;

  return {
    range_start, range_end, tasks_completed, tasks_overdue, open_due_tasks,
    blocks_count, objectives_rotting, objectives_need_attention,
  };
}
