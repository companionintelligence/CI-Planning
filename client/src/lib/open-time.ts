/**
 * Open time: the parts of the day's placement windows that nothing is scheduled into.
 *
 * Today's header answers "when could I put something?", so it reports the gaps rather
 * than re-listing the schedule (which the Planner and Calendar already show). Only
 * WORK and COMMUNITY windows count — home hours are the day's own time, and offering
 * them as placement capacity is what makes a planner feel like a second job.
 *
 * Pure and data-only so it can be unit-tested without a DOM: callers pass the day's
 * windows (already resolved to direction names) and the day's busy intervals.
 */

/** Minutes since midnight. The whole module works in this one unit. */
export type Minutes = number;

export interface TimeRange {
  start: Minutes;
  end: Minutes;
}

export interface OpenSegment extends TimeRange {
  /** The direction whose window this gap sits in — 'work' or 'community'. */
  direction: string;
}

/** Directions whose windows count as schedulable capacity on the Today header. */
export const OPEN_TIME_DIRECTIONS = ['work', 'community'] as const;

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

/** Minutes-since-midnight for an ISO timestamp, in the viewer's local zone. */
export function minutesOfDay(iso: string): Minutes | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
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
 * The day's open segments, ordered by start time.
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
): OpenSegment[] {
  const merged = mergeRanges(busy);
  const out: OpenSegment[] = [];
  for (const direction of directions) {
    for (const window of mergeRanges(windows[direction] ?? [])) {
      for (const gap of subtractBusy(window, merged)) {
        if (gap.end - gap.start >= MIN_OPEN_MINUTES) out.push({ ...gap, direction });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Total open minutes across the segments. */
export function totalOpen(segments: OpenSegment[]): Minutes {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0);
}
