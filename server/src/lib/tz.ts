/**
 * Timezone helpers that map wall-clock times in an IANA zone to UTC instants,
 * using the platform Intl database (no external dependency, no Temporal).
 *
 * The app stores every timestamp as a UTC ISO string. Scheduling preferences
 * ("work 09:00–18:00") are *local wall-clock* times, so turning a preference
 * into a concrete instant needs the user's zone. Doing it with a naive
 * `${date}T${time}Z` pins the workday to UTC — wrong everywhere but London in
 * winter (a 09:00 start lands at 02:00 for a US/Pacific user).
 */

const _fmt = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    _fmt.set(tz, f);
  }
  return f;
}

/** Milliseconds the zone is ahead of UTC at a given instant (local = utc + offset). */
function offsetMsAt(utcMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = Number(part.value);
  if (p.hour === 24) p.hour = 0; // some engines render local midnight as "24"
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - utcMs;
}

/** The server process's IANA zone (honours the TZ env var), falling back to UTC. */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * UTC ISO instant for a wall-clock `HH:MM` on calendar `date` (YYYY-MM-DD) in `tz`.
 * Two-pass so it stays correct across DST transitions.
 */
export function zonedWallTimeToUTC(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0); // wall clock treated as if it were UTC
  const firstGuess = naive - offsetMsAt(naive, tz);
  const utc = naive - offsetMsAt(firstGuess, tz); // settle DST boundary
  return new Date(utc).toISOString();
}

/**
 * The wall-clock `HH:MM` of a UTC instant in `tz` (CON-4). Used to read a recurring
 * Time-Block template's time-of-day so each materialized instance lands at the same
 * local wall time on its day (re-applied via `zonedWallTimeToUTC`, DST-correct).
 */
export function utcToZonedWallTime(utcISO: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(utcISO));
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  const hh = p.hour === '24' ? '00' : p.hour; // some engines render midnight as 24
  return `${hh}:${p.minute}`;
}

/**
 * The local calendar date (YYYY-MM-DD) of a UTC instant in `tz`. The owner-tz
 * counterpart of `localISODate` (which uses the *server* zone) — required so a
 * block's `start_at` maps to the right `scheduled_for` for an owner whose zone
 * differs from the server's, including near local midnight and across DST.
 */
export function localDateInTZ(utcISO: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(utcISO));
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * ISO-8601 week key — `YYYY-Www` — for a local calendar date (YYYY-MM-DD).
 * Monday-start; Thursday rule: a week belongs to the year that contains its Thursday.
 * Uses the noon-UTC pivot so arithmetic is DST-safe. Mirror of the client's isoWeekKey.
 */
export function isoWeekKey(dateStr: string): string {
  const addD = (d: string, n: number): string => {
    const dt = new Date(d + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  const thursday = addD(dateStr, dow === 0 ? -3 : 4 - dow);
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`;
  const jan4Dow = new Date(jan4 + 'T12:00:00Z').getUTCDay();
  const w1Monday = addD(jan4, -(jan4Dow === 0 ? 6 : jan4Dow - 1));
  const monday = addD(dateStr, -(dow === 0 ? 6 : dow - 1));
  const days = Math.round(
    (new Date(monday + 'T12:00:00Z').getTime() - new Date(w1Monday + 'T12:00:00Z').getTime()) / 86_400_000,
  );
  return `${year}-W${String(Math.floor(days / 7) + 1).padStart(2, '0')}`;
}

/** [start, end) UTC ISO bounds of the local calendar day `date` in `tz`. */
export function utcDayBounds(date: string, tz: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return {
    start: zonedWallTimeToUTC(date, '00:00', tz),
    end: zonedWallTimeToUTC(next, '00:00', tz),
  };
}
