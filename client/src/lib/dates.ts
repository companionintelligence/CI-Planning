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
