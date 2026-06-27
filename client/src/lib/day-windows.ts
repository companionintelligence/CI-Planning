/**
 * Day-type availability windows → flattened, ready-to-render bands.
 *
 * A day-type carries availability windows keyed by **direction tag id** → time
 * ranges. This module turns that map (plus the tag defs + per-pattern prefs) into
 * a flat `Band[]` with vertical geometry already resolved, so both the background
 * availability hatch (`PatternBlockOverlay`) and the left **Direction column**
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

/** A flattened availability band, ready to render. `labelIndex` stacks the titles of
 * windows that start at the same minute so none overlap. */
export interface Band {
  key: string;
  name: string;
  color: string;
  shape: string;
  offset: number;
  top: number;
  height: number;
  labelIndex: number;
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
  const seenAtStart = new Map<number, number>();
  for (const [dirTagId, ranges] of Object.entries(windows)) {
    const name = tagName(dirTagId);
    const color = colorFor(dirTagId);
    const shape = shapeFor(dirTagId);
    const offset = offsetFor(dirTagId);
    for (const range of ranges) {
      const startMin = timeToMinutes(range.start_time);
      const labelIndex = seenAtStart.get(startMin) ?? 0;
      seenAtStart.set(startMin, labelIndex + 1);
      const top = yOf(startMin);
      out.push({
        key: `${dirTagId}:${range.start_time}-${range.end_time}`,
        name, color, shape, offset,
        top,
        height: yOf(timeToMinutes(range.end_time)) - top,
        labelIndex,
      });
    }
  }
  return out;
}
