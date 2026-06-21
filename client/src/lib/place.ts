/**
 * Pure placement math for CON-5 (drag-to-place / click-to-create).
 *
 * Turns a grid Y offset (px from the column's midnight) into the `{ start_at, end_at }`
 * a new Time Block should occupy. New instants are produced ONLY through `instantAtY`
 * (which snaps via `minsOf` and rebuilds via `instantFor`, the exact inverse of
 * `minutesIntoDay`) + a real-ms duration add — so a created block snaps to the grid
 * with no tz drift, exactly like a dragged chip. No DOM, no signals: unit-tested here.
 */
import { instantAtY } from './grid.js';

export interface Span { start_at: string; end_at: string }

/**
 * The span a block dropped/clicked at grid offset `y` should occupy: the snapped
 * start at `y`, plus `durationMin` of real elapsed time. `durationMin` is clamped to
 * at least one snap step so a block is never zero/negative length.
 */
export function spanAtY(day: string, y: number, durationMin: number): Span {
  const start_at = instantAtY(day, y);
  const dur = Math.max(durationMin, 15);
  return { start_at, end_at: new Date(Date.parse(start_at) + dur * 60_000).toISOString() };
}
