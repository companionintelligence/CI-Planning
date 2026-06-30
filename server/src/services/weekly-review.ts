import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { isoWeekKey } from '../lib/tz.js';

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
       WHERE start_at >= ? AND start_at <= ?`,
    )
    .get(rangeStart, rangeEnd) as { blocks_count: number };

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
