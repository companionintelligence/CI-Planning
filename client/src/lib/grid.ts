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

/** Vertical scale: ~77px per hour. One source of truth for position + persistence.
 * (Bumped 60% from the original 0.8 = 48px/hr so hour rows read comfortably.) */
export const PX_PER_MIN = 1.28;

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

/**
 * Half-open interval intersection: do `[aStart, aEnd)` and `[bStart, bEnd)` overlap?
 * Unit-agnostic — callers pass a consistent unit (the client clamp uses
 * minutes-into-day; the server obstacle math uses epoch ms). The single shared
 * definition of "these two blocks collide", mirroring the server's `start < end &&
 * end > start` SQL so the drag clamp and any server guard never drift.
 */
export const intervalsOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && aEnd > bStart;

/** Pixels → minutes, snapped to `SNAP_MIN`. (Used by PR2 gestures; pure + tested here.) */
export const minsOf = (y: number): number =>
  Math.round(y / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;

/**
 * A grid Y offset (px from the column's midnight) → the snapped UTC instant at that
 * row, clamped into the day. The single seam for "dropped/clicked at this pixel →
 * this start time" (CON-5 click-to-create + drag-to-schedule): compose `minsOf`
 * (snap) with `instantFor` (the exact inverse of `minutesIntoDay`), so a created
 * block snaps to the grid with no tz drift. Pure + tested.
 */
export const instantAtY = (dayStr: string, y: number): string =>
  instantFor(dayStr, Math.min(Math.max(minsOf(y), 0), MINUTES_PER_DAY - SNAP_MIN));
