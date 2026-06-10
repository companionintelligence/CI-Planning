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
