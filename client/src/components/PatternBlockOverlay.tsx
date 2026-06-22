import { For } from 'solid-js';
import { patternBlocks, patternPrefs, tags } from '../stores/index.js';
import { isWeekend } from '../lib/dates.js';
import { yOf } from '../lib/grid.js';
import { BASE_TAG_DEFAULTS, HATCH_OFFSET_BY_NAME, colorVar } from '../lib/pattern-meta.js';

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function displayTag(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ── Hatch geometry ─────────────────────────────────────────────────────────────
// Each "line" is a 1px stroke shaped by the pattern's icon, repeated vertically with
// an 8px gap. The shape lives in the top band of a tile; the rest is the gap.
const WAVELENGTH = 12;          // horizontal period of the shape
const AMPLITUDE = 2;            // peak/trough from the centre line
const CENTER_Y = AMPLITUDE + 0.5;          // 2.5 — top of stroke clears y=0
const GAP_PX = 8;
const TILE_H = AMPLITUDE * 2 + 1 + GAP_PX;  // shape band (5px) + 8px gap = 13px

/** The stroke path for one tile, by motif. Each starts/ends at matching y for a
 * seamless horizontal repeat. circle→wavy, triangle→zigzag, square→castle wall. */
function hatchPath(shape: string): string {
  const cy = CENTER_Y, a = AMPLITUDE, w = WAVELENGTH;
  switch (shape) {
    case 'circle':   return `M0 ${cy} Q${w / 4} ${cy - a} ${w / 2} ${cy} T${w} ${cy}`;
    case 'triangle': return `M0 ${cy} L${w / 4} ${cy - a} L${(w * 3) / 4} ${cy + a} L${w} ${cy}`;
    case 'square':   return `M0 ${cy - a} H${w / 4} V${cy + a} H${(w * 3) / 4} V${cy - a} H${w}`;
    default:         return `M0 ${cy} H${w}`; // straight line for any other shape
  }
}

/** A CSS mask url() carrying one shaped tile. Colour stays in CSS (theme-aware): the
 * mask clips a coloured background to the stroke, like the pattern textures do. */
function hatchMask(shape: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WAVELENGTH}" height="${TILE_H}" viewBox="0 0 ${WAVELENGTH} ${TILE_H}">` +
    `<path d="${hatchPath(shape)}" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** A flattened availability band, ready to render. `labelIndex` stacks the titles of
 * windows that start at the same minute so none overlap. */
interface Band {
  key: string;
  name: string;
  color: string;
  shape: string;
  offset: number;
  top: number;
  height: number;
  labelIndex: number;
}

/** Vertical step (px) between stacked titles of windows that start together. */
const LABEL_STEP_PX = 18;

/**
 * Renders availability-zone bands behind the Planner grid — one per pattern-block
 * range. Each band reads in its pattern's own colour: a 1px outline plus a faint
 * (10%) horizontal hatch whose line *shape* comes from the pattern icon (wavy /
 * zigzag / castle), 1px stroke + 8px gap. Work & Home are phase-offset so overlapping
 * zones don't line up. Titles of windows that start together are stacked so each
 * stays readable. Purely visual — pointer-events: none.
 */
export function PatternBlockOverlay(props: { date: string }) {
  const dayType = () => (isWeekend(props.date) ? 'weekend' : 'workday');
  const windows = () => patternBlocks()?.[dayType()] ?? {};
  const allTags = () => tags() ?? [];

  const tagName = (dirTagId: string) => allTags().find((t) => t.id === dirTagId)?.name ?? '';

  // The pattern's display colour: the saved per-tag token, else the brand base
  // default (Community/Home/Work), else the primary accent.
  function colorFor(dirTagId: string): string {
    const saved = patternPrefs()?.prefs?.[dirTagId]?.color_token;
    if (saved) return colorVar(saved);
    return colorVar(BASE_TAG_DEFAULTS[tagName(dirTagId).toLowerCase()]?.color_token);
  }

  // The line shape comes from the pattern's icon (saved pref or brand base default).
  function shapeFor(dirTagId: string): string {
    const saved = patternPrefs()?.prefs?.[dirTagId]?.icon_shape;
    if (saved) return saved.toLowerCase();
    return (BASE_TAG_DEFAULTS[tagName(dirTagId).toLowerCase()]?.icon_shape ?? 'circle').toLowerCase();
  }

  function offsetFor(dirTagId: string): number {
    return HATCH_OFFSET_BY_NAME[tagName(dirTagId).toLowerCase()] ?? 0;
  }

  // Flatten every range across all directions into bands, assigning each a label
  // stacking index per identical start minute (titles share the right corner).
  const bands = (): Band[] => {
    const out: Band[] = [];
    const seenAtStart = new Map<number, number>();
    for (const [dirTagId, ranges] of Object.entries(windows())) {
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
  };

  return (
    <div class="absolute inset-0 pointer-events-none z-0">
      <For each={bands()}>
        {(b) => {
          const mask = hatchMask(b.shape);
          return (
            <div
              class="absolute left-0 right-0 rounded-sm"
              style={{ top: `${b.top}px`, height: `${b.height}px`, border: `1px solid ${b.color}` }}
            >
              {/* Hatch fill — a masked shaped line; colour comes from CSS so it stays
                  theme-aware, and the mask leaves the border/label untouched. */}
              <div
                style={{
                  position: 'absolute',
                  inset: '0',
                  'background-color': `color-mix(in srgb, ${b.color} 10%, transparent)`,
                  'mask-image': mask,
                  '-webkit-mask-image': mask,
                  'mask-size': `${WAVELENGTH}px ${TILE_H}px`,
                  '-webkit-mask-size': `${WAVELENGTH}px ${TILE_H}px`,
                  'mask-repeat': 'repeat',
                  '-webkit-mask-repeat': 'repeat',
                  'mask-position': `${b.offset}px 0`,
                  '-webkit-mask-position': `${b.offset}px 0`,
                }}
              />
              <span
                class="absolute right-1 text-[10px] bg-background/70 rounded px-1.5 py-0.5 leading-none select-none whitespace-nowrap"
                style={{ color: b.color, top: `${4 + b.labelIndex * LABEL_STEP_PX}px` }}
              >
                {displayTag(b.name)}
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}
