/**
 * YYYY-MM-DD in the user's local timezone.
 * `new Date().toISOString()` is UTC — in the evening west of UTC (or early
 * morning east of it) that's the wrong calendar day, so "Today" views would
 * fetch tomorrow's/yesterday's data.
 */
export function localISODate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * UTC instants bounding the *local* calendar day `dateStr` (YYYY-MM-DD).
 * Building the bounds from local Date parts (not a hardcoded `T00:00:00Z`)
 * means a Pacific user's "today" fetches their day, not the UTC day.
 */
export function dayRangeUTC(dateStr: string): { from: string; to: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    from: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    to: new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(),
  };
}

/**
 * UTC instants bounding the *local* calendar window `[fromDate .. toDate]`
 * (both YYYY-MM-DD, inclusive). Generalizes `dayRangeUTC` to multi-day ranges for
 * week/month fetches; builds bounds from local Date parts so the window is tz-correct.
 */
export function rangeUTC(fromDate: string, toDate: string): { from: string; to: string } {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  return {
    from: new Date(fy, fm - 1, fd, 0, 0, 0, 0).toISOString(),
    to: new Date(ty, tm - 1, td, 23, 59, 59, 999).toISOString(),
  };
}

/**
 * YYYY-MM-DD `n` days after `dateStr`. Pivots on noon UTC, which is tz-safe for
 * pure date arithmetic (it never crosses a day boundary under any zone/DST offset).
 */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True for Saturday (6) and Sunday (0). Anchored at noon UTC — DST-safe. */
export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return d === 0 || d === 6;
}

/** Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD string, computed at noon UTC. */
function dowOf(dateStr: string): number {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

/**
 * The 7 days of the Monday-based week containing `anchor` (YYYY-MM-DD).
 * Returns [Mon .. Sun].
 */
export function weekDaysOf(anchor: string): string[] {
  const dow = dowOf(anchor);                       // 0=Sun
  const monday = addDays(anchor, -(dow === 0 ? 6 : dow - 1));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * ISO-8601 week key — `YYYY-Www` — for a local calendar date (YYYY-MM-DD).
 * Monday-start; Thursday rule: a week belongs to the year that contains its Thursday.
 * Uses the noon-UTC pivot so arithmetic is DST-safe and aligns with weekDaysOf().
 * Example: 2021-01-01 (Friday) → '2020-W53' (Thursday of its week is 2020-12-31).
 */
export function isoWeekKey(dateStr: string): string {
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun
  // Thursday of this Monday-start week (Sun → -3, Mon → +3, …, Fri → -1, Sat → -2).
  const thursday = addDays(dateStr, dow === 0 ? -3 : 4 - dow);
  const year = Number(thursday.slice(0, 4));
  // W01's Monday is the Monday on or before Jan 4 (Jan 4 is always in W01).
  const jan4 = `${year}-01-04`;
  const jan4Dow = new Date(jan4 + 'T12:00:00Z').getUTCDay();
  const w1Monday = addDays(jan4, -(jan4Dow === 0 ? 6 : jan4Dow - 1));
  // Monday of the input date (same formula as weekDaysOf).
  const monday = addDays(dateStr, -(dow === 0 ? 6 : dow - 1));
  const days = Math.round(
    (new Date(monday + 'T12:00:00Z').getTime() - new Date(w1Monday + 'T12:00:00Z').getTime()) / 86_400_000,
  );
  return `${year}-W${String(Math.floor(days / 7) + 1).padStart(2, '0')}`;
}

/**
 * A 6×7 = 42-day month grid (YYYY-MM-DD) for the month containing `anchor`,
 * including leading days from the previous month and trailing days from the next
 * so the grid starts on a Monday and fills six full weeks.
 */
export function monthGridOf(anchor: string): string[] {
  const [y, m] = anchor.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const dow = dowOf(first);                         // 0=Sun
  const start = addDays(first, -(dow === 0 ? 6 : dow - 1)); // back up to Monday
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
