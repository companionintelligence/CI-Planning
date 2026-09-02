/**
 * Open time: the parts of the day's placement windows that nothing is scheduled into.
 *
 * Today's header answers "when could I put something?", so it reports the gaps rather
 * than re-listing the schedule (which the Planner and Calendar already show). Which
 * directions count is caller-configurable (owner preference, `show_open_time` per
 * pattern — see `SchedulePatternEditor`); `OPEN_TIME_DIRECTIONS` below is only the
 * default used when a caller doesn't pass its own list (e.g. these unit tests).
 *
 * Pure and data-only so it can be unit-tested without a DOM: callers pass the day's
 * windows (already resolved to direction names) and the day's busy intervals.
 */
import type { Block } from './api.js';
import { localISODate } from './dates.js';
import { MINUTES_PER_DAY } from './grid.js';
import { occupiesMinuteAxis } from './overlay.js';

/** Minutes since midnight. The whole module works in this one unit. */
export type Minutes = number;

export interface TimeRange {
  start: Minutes;
  end: Minutes;
}

export interface OpenSegment extends TimeRange {
  /**
   * Every direction whose window covers exactly this span. More than one entry means
   * two (or more) directions configured the identical start/end for this day type —
   * those rows are combined into one rather than listed as duplicate back-to-back
   * rows for the same time range.
   */
  directions: string[];
}

/** Default directions to check when a caller doesn't pass its own list. */
export const OPEN_TIME_DIRECTIONS = ['work', 'community'] as const;

/**
 * The hours the Today card is willing to call "open", independent of how wide the
 * day's availability windows actually run.
 *
 * A window can legitimately stretch 07:00–23:00 — that is when work is *allowed*, not
 * when you would choose to schedule. Reporting the whole span buries the hours you would
 * actually use among ones you would not, which is the opposite of what the card is for.
 * These bound the DISPLAY only: nothing here changes placement, and a block already
 * scheduled outside the range still counts as busy inside it.
 */
export const DEFAULT_OPEN_START: Minutes = 9 * 60;   // 09:00
export const DEFAULT_OPEN_END: Minutes = 20 * 60;    // 20:00

/** Overlap of two ranges, or null when they do not meet. */
export function intersect(a: TimeRange, b: TimeRange): TimeRange | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/**
 * Gaps shorter than this are dropped. A few minutes between two meetings is not
 * schedulable, and listing it as "open" is noise dressed up as information.
 */
export const MIN_OPEN_MINUTES = 15;

/** `"09:30"` → 570. Returns null for anything unparseable rather than NaN. */
export function parseHHMM(value: string): Minutes | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The day's busy intervals, from the blocks the store has loaded.
 *
 * This is the half of "open time" that decides what counts as taken, and it is the
 * reason a **Time Block is not open time**: a `timeblock` container occupies its whole
 * span whether or not anything is nested inside it, because the span IS the commitment.
 * A member task block nested in one contributes its own interval too, but that costs
 * nothing — `openTime` merges before subtracting, so the overlap is removed once.
 *
 * Two things it deliberately refuses to treat as busy:
 *
 *  - anything `occupiesMinuteAxis` rejects (all-day, someday concepts, finished or
 *    cancelled work) — see that predicate for why each one holds no minutes;
 *  - blocks belonging to another date. The day fetch is range-contained today, but
 *    `blockRange` widens to a whole week whenever the standalone Calendar is mounted,
 *    and a Tuesday meeting must never wall off Monday's morning.
 *
 * Wall-clock minutes, not elapsed minutes, so a block lines up with the `HH:MM` window
 * bounds `parseHHMM` produces on a DST day — the two must be read on the same clock.
 */
export function busyFromBlocks(blocks: readonly Block[], day: string): TimeRange[] {
  const out: TimeRange[] = [];
  for (const b of blocks) {
    if (!occupiesMinuteAxis(b)) continue;
    const start = new Date(b.start_at);
    const end = new Date(b.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end.getTime() <= start.getTime()) continue;   // malformed span, not a zero gap
    if (localISODate(start) !== day) continue;
    // A block running past midnight is busy until the END OF THIS DAY. Reading its
    // wall clock instead would give a smaller number than its start and invert the
    // range — a 22:00–02:00 block would silently vanish rather than close the night.
    const endMin = localISODate(end) === day
      ? end.getHours() * 60 + end.getMinutes()
      : MINUTES_PER_DAY;
    const startMin = start.getHours() * 60 + start.getMinutes();
    if (endMin > startMin) out.push({ start: startMin, end: endMin });
  }
  return out;
}

/** `570` → `"9:30am"`. */
export function formatClock(mins: Minutes): string {
  const total = Math.round(mins);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const suffix = h24 >= 12 ? 'pm' : 'am';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')}${suffix}`;
}

/** `75` → `"1h 15m"`. */
export function formatDuration(mins: Minutes): string {
  const total = Math.max(0, Math.round(mins));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Merge overlapping/adjacent ranges so subtraction can walk them once, in order. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * Subtract `busy` from one window, returning what is left of it.
 *
 * Busy intervals must already be merged — overlapping meetings would otherwise
 * subtract twice and under-report the gap between them.
 */
export function subtractBusy(window: TimeRange, busy: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= cursor) continue;          // already behind us
    if (b.start >= window.end) break;       // past this window entirely
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out;
}

/**
 * The day's open segments, ordered by start time. Two directions whose windows
 * resolve to the exact same open span (same start AND end, after subtracting the
 * day's busy time) are combined into one segment listing both directions, rather
 * than rendered as duplicate rows — see {@link OpenSegment.directions}.
 *
 * @param windows  Direction name → its configured ranges for the resolved day type.
 * @param busy     Every scheduled interval for the day, in any order.
 */
export function openTime(
  windows: Record<string, TimeRange[]>,
  // Defaults to "nothing scheduled" so an empty day is a normal call, not a crash —
  // the resource feeding this can resolve before the blocks one does.
  busy: TimeRange[] = [],
  directions: readonly string[] = OPEN_TIME_DIRECTIONS,
  /**
   * Clamp every window to these hours before reporting gaps (see DEFAULT_OPEN_START).
   * Omitted ⇒ no clamping, so the pure unit tests and any caller that wants the raw
   * windows keep their existing behaviour byte-for-byte.
   */
  bounds?: TimeRange,
): OpenSegment[] {
  const merged = mergeRanges(busy);
  // Keyed by "start-end" so two directions landing on the identical open span collapse
  // into one segment instead of two adjacent rows for the same time range.
  const byRange = new Map<string, OpenSegment>();
  for (const direction of directions) {
    for (const raw of mergeRanges(windows[direction] ?? [])) {
      // Clamp BEFORE subtracting busy, not after: a meeting that runs past the bound
      // must still consume the part of the window inside it, and clamping afterwards
      // would let the tail of that meeting reappear as open time.
      const window = bounds ? intersect(raw, bounds) : raw;
      if (!window) continue;
      for (const gap of subtractBusy(window, merged)) {
        if (gap.end - gap.start < MIN_OPEN_MINUTES) continue;
        const key = `${gap.start}-${gap.end}`;
        const existing = byRange.get(key);
        if (existing) existing.directions.push(direction);
        else byRange.set(key, { start: gap.start, end: gap.end, directions: [direction] });
      }
    }
  }
  return [...byRange.values()].sort((a, b) => a.start - b.start);
}

/** Total open minutes across the segments. */
export function totalOpen(segments: OpenSegment[]): Minutes {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0);
}
