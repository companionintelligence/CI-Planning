import { For } from 'solid-js';
import type { Band } from '../lib/day-windows.js';

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

/**
 * Renders availability-zone bands behind the Planner grid — one per pattern-block
 * range. Each band reads in its pattern's own colour: a 1px outline plus a faint
 * (10%) horizontal hatch whose line *shape* comes from the pattern icon (wavy /
 * zigzag / castle), 1px stroke + 8px gap. Work & Home are phase-offset so overlapping
 * zones don't line up. Purely visual — pointer-events: none.
 *
 * The direction *names* now live in the left `DirectionColumn`, so this overlay only
 * paints the shaded zones. Bands are computed once in the Planner (shared with the
 * column) and passed in, so the two never drift.
 */
export function PatternBlockOverlay(props: { bands: () => Band[] }) {
  return (
    <div class="absolute inset-0 pointer-events-none z-0">
      <For each={props.bands()}>
        {(b) => {
          const mask = hatchMask(b.shape);
          return (
            <div
              class="absolute left-0 right-0 rounded-sm"
              style={{ top: `${b.top}px`, height: `${b.height}px`, border: `1px solid ${b.color}` }}
            >
              {/* Hatch fill — a masked shaped line; colour comes from CSS so it stays
                  theme-aware, and the mask leaves the border untouched. */}
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
            </div>
          );
        }}
      </For>
    </div>
  );
}
