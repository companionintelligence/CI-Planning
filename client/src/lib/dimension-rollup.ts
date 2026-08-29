/**
 * Rollups for the details drawer's Life-dimension panel.
 *
 * Pure and side-effect free so the arithmetic that drives "how much of this week is
 * still unallocated?" can be tested without standing up the drawer, its stores and
 * its router.
 */
import { localISODate, addDays } from './dates.js';

export type RollupPeriod = 'week' | 'month';

export interface DateWindow {
  /** inclusive YYYY-MM-DD */
  from: string;
  /** inclusive YYYY-MM-DD */
  to: string;
  /** how many days the window spans — drives the pro-rated target */
  days: number;
}

/**
 * The window the Scheduled/Completed lists are filtered to.
 *
 * `week` is the Monday–Sunday week containing `anchor` (matching weekDaysOf's ISO
 * convention elsewhere in the app), NOT a rolling 7 days back — "this week" has to
 * mean the same span as the planner's week or the two views disagree about what is
 * scheduled.
 */
export function windowFor(period: RollupPeriod, anchor: string = localISODate()): DateWindow {
  const d = new Date(`${anchor}T12:00:00`);
  if (period === 'week') {
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const from = addDays(anchor, -dow);
    return { from, to: addDays(from, 6), days: 7 };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0); // day 0 of next month = last of this
  const iso = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last), days: last.getDate() };
}

/** Is an ISO timestamp (or plain YYYY-MM-DD) inside the window? Compared on the date part. */
export function inWindow(ts: string | null | undefined, w: DateWindow): boolean {
  if (!ts) return false;
  const day = ts.slice(0, 10);
  return day >= w.from && day <= w.to;
}

/**
 * A weekly target pro-rated to the window: a 14h/week target is 14h over a week and
 * 14 × 31/7 ≈ 62h over a 31-day month. Rounded to one decimal — the inputs are
 * whole-hour estimates, so more precision would be false confidence.
 */
export function targetForWindow(weeklyHours: number, w: DateWindow): number {
  return Math.round(weeklyHours * (w.days / 7) * 10) / 10;
}

export interface TitleGroup<T> {
  title: string;
  /** how many rows collapsed into this one; 1 unless the title repeats */
  count: number;
  /** the first row, so the caller can still link somewhere sensible */
  first: T;
  /** total minutes across every row in the group */
  minutes: number;
}

/**
 * Collapse rows that share a title into ONE entry carrying a repeat count.
 *
 * A recurring task materialises one row per occurrence, so an unfiltered list showed
 * "Morning walk" seven times and buried everything else. Grouping is by trimmed,
 * case-folded title — instances of a recurrence carry the template's title verbatim,
 * and two genuinely different tasks that happen to share a title are indistinguishable
 * to a reader of this list anyway.
 *
 * Insertion order is preserved: callers sort before grouping, and a group takes the
 * position of its first member.
 */
export function groupByTitle<T>(
  rows: T[],
  titleOf: (r: T) => string,
  minutesOf: (r: T) => number = () => 0,
): TitleGroup<T>[] {
  const out: TitleGroup<T>[] = [];
  const index = new Map<string, TitleGroup<T>>();
  for (const r of rows) {
    const title = (titleOf(r) ?? '').trim();
    const key = title.toLowerCase();
    const hit = index.get(key);
    if (hit) {
      hit.count += 1;
      hit.minutes += minutesOf(r);
      continue;
    }
    const g: TitleGroup<T> = { title, count: 1, first: r, minutes: minutesOf(r) };
    index.set(key, g);
    out.push(g);
  }
  return out;
}

/** Minutes between two ISO timestamps; 0 when either is unparseable. */
export function minutesBetween(startIso: string, endIso: string): number {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 60000);
}

/** `90` → `1.5h`, `45` → `45m`, `0` → `0h`. */
export function hoursLabel(minutes: number): string {
  if (minutes <= 0) return '0h';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h}h`;
}
