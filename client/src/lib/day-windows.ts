/**
 * Day-type availability windows → flattened, ready-to-render bands.
 *
 * A day-type carries availability windows keyed by **direction tag id** → time
 * ranges. This module turns that map (plus the tag defs + per-pattern prefs) into
 * a flat `Band[]` with vertical geometry already resolved, so both the background
 * availability bands (`PatternBlockOverlay`) and the left **Direction column**
 * (`DirectionColumn`) render from the same source — no drift between them.
 *
 * Pure + DOM-free (only depends on `yOf` for the px mapping) so it's unit-testable
 * like `grid.ts`/`planner.ts`.
 */
import { BASE_TAG_DEFAULTS, HATCH_OFFSET_BY_NAME, colorVar } from './pattern-meta.js';
import { yOf } from './grid.js';

/** One availability range inside a day-type window (local wall-clock HH:MM). */
export interface WindowRange {
  start_time: string;
  end_time: string;
}

/** Day-type windows as returned by `api.patternBlocks.forDay`: dirTagId → ranges. */
export type DayWindows = Record<string, WindowRange[]>;

/** The minimal tag shape the band math needs (id ⇄ name, kind unused here). */
export interface TagDef {
  id: string;
  name: string;
}

/** The per-pattern presentation prefs, keyed by tag id (color + motif overrides). */
export type PatternPrefMap = Record<string, { color_token?: string | null; icon_shape?: string | null }>;

/** A flattened availability band, ready to render. Minute bounds let the Planner mark
 * each start/end transition after reprojecting the band onto its segmented day axis. */
export interface Band {
  key: string;
  name: string;
  color: string;
  shape: string;
  offset: number;
  startMin: number;
  endMin: number;
  top: number;
  height: number;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Display label for a direction name (rendered capitalized). */
export function displayDirection(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Flatten every range across all directions into bands. Colour/shape/offset resolve
 * per direction: saved pref → brand base
 * default ([[pattern-meta]]) → primary accent.
 */
export function computeBands(windows: DayWindows, tags: TagDef[], prefs: PatternPrefMap = {}): Band[] {
  const tagName = (dirTagId: string) => tags.find((t) => t.id === dirTagId)?.name ?? '';

  const colorFor = (dirTagId: string): string => {
    const saved = prefs[dirTagId]?.color_token;
    if (saved) return colorVar(saved);
    return colorVar(BASE_TAG_DEFAULTS[tagName(dirTagId).toLowerCase()]?.color_token);
  };
  const shapeFor = (dirTagId: string): string => {
    const saved = prefs[dirTagId]?.icon_shape;
    if (saved) return saved.toLowerCase();
    return (BASE_TAG_DEFAULTS[tagName(dirTagId).toLowerCase()]?.icon_shape ?? 'circle').toLowerCase();
  };
  const offsetFor = (dirTagId: string): number =>
    HATCH_OFFSET_BY_NAME[tagName(dirTagId).toLowerCase()] ?? 0;

  const out: Band[] = [];
  for (const [dirTagId, ranges] of Object.entries(windows)) {
    const name = tagName(dirTagId);
    const color = colorFor(dirTagId);
    const shape = shapeFor(dirTagId);
    const offset = offsetFor(dirTagId);
    for (const range of ranges) {
      const startMin = timeToMinutes(range.start_time);
      const endMin = timeToMinutes(range.end_time);
      const top = yOf(startMin);
      out.push({
        key: `${dirTagId}:${range.start_time}-${range.end_time}`,
        name, color, shape, offset,
        startMin,
        endMin,
        top,
        height: yOf(endMin) - top,
      });
    }
  }
  return out;
}

/** One availability window resolved to a direction name and minute-of-day bounds. */
export interface ActiveWindow {
  direction: string;
  start: number;
  end: number;
}

/**
 * The availability windows covering a given minute of the day.
 *
 * The details drawer answers "what am I inside right now?" when nothing is selected —
 * a day type alone ("Workday") does not tell you whether you are currently in work
 * hours or the evening. Returns every covering window, not just the first: overlapping
 * directions are legal (Home and Community can both run 19:00-21:00) and reporting one
 * would silently hide the other.
 *
 * Pure and minute-based so it is unit-testable without a DOM or a clock.
 */
export function activeWindowsAt(windows: DayWindows, tags: TagDef[], nowMin: number): ActiveWindow[] {
  const nameById = new Map(tags.map((t) => [t.id, t.name.toLowerCase()]));
  const out: ActiveWindow[] = [];
  for (const [tagId, ranges] of Object.entries(windows ?? {})) {
    const direction = nameById.get(tagId);
    if (!direction) continue; // a window for a tag we do not know about is not describable
    for (const r of ranges ?? []) {
      const start = timeToMinutes(r.start_time);
      const end = timeToMinutes(r.end_time);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      // End-exclusive: at exactly 13:00 you are in the afternoon window, not still in
      // the morning one that ends there — otherwise a boundary minute reports both.
      if (nowMin >= start && nowMin < end) out.push({ direction, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.direction.localeCompare(b.direction));
}
