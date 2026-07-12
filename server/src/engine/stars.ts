import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';

/**
 * Phase O · O2 — the five-star day score.
 *
 * Five independent, DERIVED stars per (owner, date). No star is a manual toggle:
 * each reads existing completion signal so the game rewards real work.
 *
 *   S1 objective  — the day's `today_goal` reflection has done_at set.
 *   S2 habits     — >=1 habit instance that day AND all of them are done.
 *   S3 tasks      — >=1 non-habit/non-routine task PLANNED for that day AND all such
 *                   planned tasks are done. "Planned" = in that day's `daily_plan`
 *                   (the authored plan) OR `scheduled_for` = that day (the user's own
 *                   start intent — quick-add, New Task, wizard, and drag placements
 *                   all stamp it via block-task-sync). HOW a task was scheduled must
 *                   not change its star: self-placed work is planned work.
 *   S4 bonus      — >=1 non-habit/non-routine task completed that day that was NOT
 *                   planned for it (neither daily_plan nor scheduled_for) — a genuinely
 *                   unplanned win.
 *   S5 note       — >=1 task done that day AND a non-empty day_note exists.
 *
 * Habit/routine exclusion (S3/S4): mirrors the Today's Brief top-tasks rule —
 * subtype != 'habit', recurrence_parent_id IS NULL, and not a pattern member.
 *
 * Empty-set rule (default): S2 and S3 require AT LEAST ONE of their kind to
 * exist. A day with no habits can't earn the habits star; a day with no plan
 * can't earn the tasks star. (Vacuous-true is a one-line flip below.)
 *
 * Pure read — never writes. Pinned-clock `now` mirrors advanceObjectives (unused
 * today: every read is date-scoped, but kept for parity + future need).
 */
export interface DayStars {
  objective: boolean;
  habits: boolean;
  tasks: boolean;
  bonus: boolean;
  note: boolean;
  total: number;
}

export function computeStars(
  owner: string = currentOwnerId(),
  date: string = '',
  _opts: { now?: string } = {},
): DayStars {
  const tzRow = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get(owner) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  // ── S1 — intention ──────────────────────────────────────────────────────────
  const goal = sqlite
    .prepare(
      `SELECT done_at FROM reflections
        WHERE owner_id = ? AND kind = 'today_goal' AND period_key = ? AND position = 0`,
    )
    .get(owner, date) as { done_at: string | null } | undefined;
  const objective = !!goal?.done_at;

  // ── S2 — habits (>=1 habit instance today, all done) ─────────────────────────
  const habitStats = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks
        WHERE owner_id = ?
          AND COALESCE(subtype, 'standard') = 'habit'
          AND occurrence_date = ?`,
    )
    .get(owner, date) as { total: number; done: number | null };
  const habits = habitStats.total > 0 && (habitStats.done ?? 0) === habitStats.total;

  // ── S3 — tasks (>=1 non-habit/non-routine planned task, all done) ────────────
  // "Planned for the day" = the authored daily_plan ∪ tasks the user scheduled
  // there themselves (scheduled_for = date, local YYYY-MM-DD like dp.date). Only
  // the AI authoring path ever writes daily_plan, so without the union a self-
  // scheduled task would score as an "unplanned bonus" — inconsistent scoring by
  // scheduling path. (Membership deliberately differs from topTasksForDay
  // (summary.ts), which keys on daily_plan OR a block placed today; what IS shared
  // are its status/exclusion rules:) a planned task the owner cancels (soft-delete
  // leaves the daily_plan row), or a skipped recurring instance, drops out of the
  // "for the day" set entirely — so it can't pin total>done forever and lock the
  // star dark. A `missed`/still-open planned task is a genuine incompletion and
  // correctly keeps the star unlit.
  const planStats = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks t
        WHERE t.owner_id = ?
          AND (t.scheduled_for = ?
               OR t.id IN (SELECT task_id FROM daily_plan WHERE owner_id = ? AND date = ?))
          AND t.status NOT IN ('cancelled', 'recurring', 'skipped')
          AND COALESCE(t.subtype, 'standard') != 'habit'
          AND t.recurrence_parent_id IS NULL
          AND t.id NOT IN (SELECT task_id FROM pattern_tasks)`,
    )
    .get(owner, date, owner, date) as { total: number; done: number | null };
  const tasks = planStats.total > 0 && (planStats.done ?? 0) === planStats.total;

  // ── S4 — bonus (an unplanned non-habit/non-routine completion today) ─────────
  // The exclusion mirrors S3's planned set exactly (daily_plan ∪ scheduled_for=date),
  // so one completion can never count as both planned work and an unplanned win.
  const bonusRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS n
         FROM tasks t
        WHERE t.owner_id = ?
          AND t.status = 'done'
          AND t.completed_at >= ? AND t.completed_at < ?
          AND COALESCE(t.subtype, 'standard') != 'habit'
          AND t.recurrence_parent_id IS NULL
          AND t.id NOT IN (SELECT task_id FROM pattern_tasks)
          AND (t.scheduled_for IS NULL OR t.scheduled_for <> ?)
          AND t.id NOT IN (SELECT task_id FROM daily_plan WHERE owner_id = ? AND date = ?)`,
    )
    .get(owner, dayStart, dayEnd, date, owner, date) as { n: number };
  const bonus = bonusRow.n > 0;

  // ── S5 — reflection (>=1 task done today AND a non-empty day note) ───────────
  const doneToday = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE owner_id = ? AND status = 'done'
          AND completed_at >= ? AND completed_at < ?`,
    )
    .get(owner, dayStart, dayEnd) as { n: number };
  const noteRow = sqlite
    .prepare(
      `SELECT body FROM reflections
        WHERE owner_id = ? AND kind = 'day_note' AND period_key = ? AND position = 0`,
    )
    .get(owner, date) as { body: string } | undefined;
  const note = doneToday.n > 0 && !!noteRow && noteRow.body.trim().length > 0;

  const total = [objective, habits, tasks, bonus, note].filter(Boolean).length;
  return { objective, habits, tasks, bonus, note, total };
}
