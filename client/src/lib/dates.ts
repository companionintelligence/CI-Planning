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
