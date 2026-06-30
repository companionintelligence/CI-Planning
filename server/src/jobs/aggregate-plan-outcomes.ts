import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';

export interface OutcomeResult {
  date: string;
  planned: number;
  completed: number;
}

/**
 * Phase N4 — daily plan outcome aggregation.
 *
 * For a given calendar date (defaults to yesterday relative to `today`), counts:
 *   planned   = task-bearing non-meeting blocks whose start falls on that date
 *   completed = of those, how many tasks have status='done' with completed_at on
 *               that same date
 *
 * Uses the owner's timezone for the day boundary so the counts match what the
 * user actually saw. Persists to plan_outcomes (upsert).
 */
export function aggregatePlanOutcomes(
  forDate?: string,
  today?: string,
): OutcomeResult {
  const owner = currentOwnerId();

  const tzRow = sqlite
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();

  const todayStr = today ?? localISODate();
  const date = forDate ?? (() => {
    // yesterday in local time
    const d = new Date(todayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const row = sqlite
    .prepare(
      `SELECT
         COUNT(b.id)    AS planned,
         SUM(CASE
           WHEN t.status = 'done'
            AND t.completed_at >= ? AND t.completed_at < ?
           THEN 1 ELSE 0 END) AS completed
       FROM time_blocks b
       JOIN tasks t ON t.id = b.task_id
       WHERE b.task_id IS NOT NULL
         AND b.block_kind != 'meeting'
         AND b.start_at >= ?
         AND b.start_at < ?`,
    )
    .get(dayStart, dayEnd, dayStart, dayEnd) as { planned: number; completed: number };

  const planned = row.planned ?? 0;
  const completed = row.completed ?? 0;

  sqlite
    .prepare(
      `INSERT INTO plan_outcomes (owner_id, date, planned, completed)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id, date) DO UPDATE SET
         planned   = excluded.planned,
         completed = excluded.completed`,
    )
    .run(owner, date, planned, completed);

  return { date, planned, completed };
}
