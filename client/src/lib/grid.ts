/**
 * Calendar-grid geometry: the single source of truth mapping a UTC instant to a
 * vertical pixel position inside a day column, and back.
 *
 * The whole point of Phase F: **no timezone drift between a block's pixel
 * position and its stored UTC instant.** Position math uses real elapsed
 * milliseconds (`getTime()` deltas), never wall-clock string slicing, so a block
 * spanning a DST boundary is placed by actual minutes elapsed (no off-by-60).
 *
 * `minutesIntoDay` and `instantFor` are exact inverses — UTC↔local conversion
 * lives only inside this pair. View code never formats a wall-clock string with a
 * literal `Z` or slices an ISO string to read hours/minutes.
 */

/** Vertical scale: 48px per hour. One source of truth for position + persistence. */
export const PX_PER_MIN = 0.8;

/** Snap granularity (minutes) for pixel→minute conversion. */
export const SNAP_MIN = 15;

/** Total minutes in a calendar day (DST days still render on a 24h axis). */
export const MINUTES_PER_DAY = 24 * 60;

/** Full height of a day column in pixels. */
export const DAY_HEIGHT_PX = MINUTES_PER_DAY * PX_PER_MIN;

/**
 * Local minutes-since-midnight for a UTC instant, measured in the *column's* day.
 *
 * `new Date(iso)` parses the stored UTC instant; `.getTime()` reads it as real
 * epoch ms. Midnight is built from the column's LOCAL date parts (the same
 * convention as `dayRangeUTC`). The delta is real elapsed time, so a block on a
 * spring-forward day lands at the correct minute — never off by 60.
 */
export function minutesIntoDay(iso: string, dayStr: string): number {
  const d = new Date(iso);
  const [y, m, day] = dayStr.split('-').map(Number);
  const midnight = new Date(y, m - 1, day, 0, 0, 0, 0).getTime();
  return (d.getTime() - midnight) / 60_000;
}

/**
 * Inverse of `minutesIntoDay`: rebuild the UTC instant from a column's local day
 * plus a minutes-into-day offset. `minutesIntoDay(instantFor(day, mins), day)`
 * is the identity (modulo float rounding) for any sampled instant.
 */
export function instantFor(dayStr: string, mins: number): string {
  const [y, m, d] = dayStr.split('-').map(Number);
  const midnight = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  return new Date(midnight + mins * 60_000).toISOString();
}

/** Minutes → pixels (top offset / height). */
export const yOf = (mins: number): number => mins * PX_PER_MIN;

/** Pixels → minutes, snapped to `SNAP_MIN`. (Used by PR2 gestures; pure + tested here.) */
export const minsOf = (y: number): number =>
  Math.round(y / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
