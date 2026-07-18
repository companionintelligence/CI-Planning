import { currentOwnerId } from '../lib/context.js';
import { localISODate } from '../lib/dates.js';
import {
  weeklyReview, globalCalibrationReadout,
  type WeekReview, type CalibrationReadout,
} from './weekly-review.js';
import { listDayStars, type DayStarsRow } from './stars.js';
import { noteDates } from './reflections.js';
import { listSessions, type PlanningSession } from './planning-sessions.js';

/**
 * services/plan-week-review.ts (FTUE · T5, #341) — the deterministic weekly recap behind
 * the assistant's "Review past data" branch.
 *
 * This composes ONLY existing, already-tested surfaces — `weeklyReview`,
 * `globalCalibrationReadout`, `listDayStars`, `noteDates`, and T1's `listSessions` — into
 * one payload. It deliberately contains NO new stats SQL: if a number here is wrong, it is
 * wrong in its owning service, which is where the fix belongs.
 *
 * Strictly read-only, and no LLM: the branch must render with Ollama offline. Turning this
 * into prose is T10's job, not this one's.
 *
 * Why one endpoint instead of composing in the client: the alternative is 4–5 round-trips,
 * as many loading/error states, and re-deriving the Mon→Sun ISO-week range in the browser
 * purely to build the stars query. Collapsing it here keeps the composition server-side
 * where it is vitest-testable and gives the branch a single `createResource`.
 */

export interface PlanWeekReview {
  /** The anchor actually used — echoed so the client never has to recompute it. */
  anchor: string;
  week: WeekReview;
  calibration: CalibrationReadout;
  /** Five-star rows for the week's Mon→Sun days (frozen where the night job has run). */
  stars: DayStarsRow[];
  /** Dates in the week that carry a day note. */
  note_dates: string[];
  /** T1 planning sessions started within the week, newest first. */
  sessions: PlanningSession[];
}

/**
 * The default anchor: a day inside the week that just ended (today − 7).
 *
 * Reviewing "past data" from today's anchor would show the in-progress week, which is not
 * what the branch is for. Pivots at noon UTC like `weekDays`/`addDays` in weekly-review.ts,
 * so a DST shift can't roll the date across a boundary.
 */
export function priorWeekAnchor(today: string = localISODate()): string {
  const dt = new Date(`${today}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 7);
  return dt.toISOString().slice(0, 10);
}

/**
 * Compose the recap for the ISO week containing `anchor`.
 *
 * `weeklyReview` self-scopes to the current owner; `listDayStars`/`noteDates` take an
 * explicit owner, so the two conventions are bridged here rather than in the route.
 */
export function planWeekReview(anchor: string): PlanWeekReview {
  const owner = currentOwnerId();
  const week = weeklyReview(anchor);
  const from = week.days[0];
  const to = week.days[week.days.length - 1];

  // T1's listSessions() is owner-self-scoping and returns every session; the week filter
  // is applied here so the aggregation owns its own range semantics.
  const sessions = listSessions().filter((s) => {
    const day = s.started_at.slice(0, 10);
    return day >= from && day <= to;
  });

  return {
    anchor,
    week,
    calibration: globalCalibrationReadout(owner),
    stars: listDayStars(owner, from, to),
    note_dates: noteDates(owner, from, to),
    sessions,
  };
}
