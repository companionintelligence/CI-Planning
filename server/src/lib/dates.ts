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
