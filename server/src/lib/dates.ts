/**
 * YYYY-MM-DD in the server's local timezone (respects the TZ env var).
 * `new Date().toISOString()` is always UTC, which makes "today" wrong for any
 * deployment west/east of UTC — e.g. a 7pm PDT request would summarize tomorrow.
 */
export function localISODate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Add `n` calendar days to a YYYY-MM-DD string, returning YYYY-MM-DD. Pure
 * calendar arithmetic (UTC math on the date parts) — no wall-clock / DST concern,
 * since this only counts days, never instants. `n` may be negative.
 */
export function addLocalDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
