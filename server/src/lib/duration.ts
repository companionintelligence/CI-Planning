/**
 * Elapsed minutes between two UTC ISO instants.
 *
 * DST-correct by construction: we subtract two absolute instants, never wall
 * clock times, so a timer spanning a DST transition measures real elapsed time
 * (a 23-hour civil day still has 60 real minutes per hour). Clamped at 0 so a
 * reversed pair can't yield a negative.
 */
export const elapsedMinutes = (startISO: string, endISO: string): number =>
  Math.max(0, Math.round((Date.parse(endISO) - Date.parse(startISO)) / 60_000));
