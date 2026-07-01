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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `s` is a real YYYY-MM-DD date — correct shape AND a valid calendar
 * day. Round-tripping through `Date(...'T00:00:00Z')` rejects impossible dates
 * like 2026-02-31 or 2026-13-01 (which the regex alone would accept). Shared by
 * the query-param validation on /api/summary/top-tasks, /api/stars, and the
 * reflections /note + /notes routes so they can't diverge.
 */
export function isValidISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
