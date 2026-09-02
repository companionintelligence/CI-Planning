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

/** A flattened availability band, ready to render. `labelTop` is the absolute px y
 * of the rotated title — packed so titles NEVER overlap, even when windows overlap. */
export interface Band {
  key: string;
  name: string;
  color: string;
  shape: string;
  offset: number;
  top: number;
  height: number;
  labelTop: number;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Rough px height of a rotated (vertical-rl) 10px title — generous so packing never
 * leaves two titles overlapping. ~7px per glyph + base; "Community" (9) ≈ 71px. */
function estimateLabelHeight(name: string): number {
  return name.length * 7 + 8;
}

/** Display label for a direction name (rendered capitalized). */
export function displayDirection(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Flatten every range across all directions into bands, assigning each a label
 * stacking index per identical start minute (so titles that share a start don't
 * collide). Colour/shape/offset resolve per direction: saved pref → brand base
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
      const top = yOf(timeToMinutes(range.start_time));
      out.push({
        key: `${dirTagId}:${range.start_time}-${range.end_time}`,
        name, color, shape, offset,
        top,
        height: yOf(timeToMinutes(range.end_time)) - top,
        labelTop: top,
      });
    }
  }

  // Place each title at its band's top edge, pushed DOWN only as much as needed so no
  // two rotated titles ever overlap in the narrow column. Weekend day-types overlap
  // heavily (e.g. Home 08–23, Work 09–13, Community 10–20) — centering the titles in
  // their bands collided them; top-anchored greedy packing guarantees clearance.
  const LABEL_GAP = 6;
  const TOP_PAD = 4;
  let cursor = -Infinity;
  for (const b of [...out].sort((a, z) => a.top - z.top || z.height - a.height)) {
    b.labelTop = Math.max(b.top + TOP_PAD, cursor + LABEL_GAP);
    cursor = b.labelTop + estimateLabelHeight(b.name);
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
