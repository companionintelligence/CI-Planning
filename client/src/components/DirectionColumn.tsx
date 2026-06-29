import { For } from 'solid-js';
import { DAY_HEIGHT_PX } from '../lib/grid.js';
import { displayDirection, type Band } from '../lib/day-windows.js';

/**
 * The Direction column: a thin, fixed-width lane (right after the time gutter) that
 * names the day's availability windows. Each band gets a 3px coloured left edge; its
 * 90°-rotated 10pt label (Home / Work / Community …, in that direction's colour, read
 * bottom-to-top) is placed at the band's pre-packed `labelTop` so titles NEVER
 * overlap — even when windows overlap (weekend Home/Work/Community all span midday).
 * Fixed width by design — it never widens, so the grid stays stable.
 *
 * Purely indicative + pointer-transparent: the windows are owned by day-type settings,
 * not edited here. Bands are computed once in the Planner and shared with the
 * background hatch (`PatternBlockOverlay`) so the two never drift.
 */
export function DirectionColumn(props: { bands: () => Band[] }) {
  return (
    <div class="relative pointer-events-none select-none" style={{ height: `${DAY_HEIGHT_PX}px` }}>
      {/* Band region markers — the coloured left edge over each window's full extent. */}
      <For each={props.bands()}>
        {(b) => (
          <div
            class="absolute left-0 right-0"
            style={{ top: `${b.top}px`, height: `${b.height}px`, 'border-left': `3px solid ${b.color}` }}
            title={displayDirection(b.name)}
          />
        )}
      </For>
      {/* Titles — anchored at the packed labelTop (own layer, so they're never clipped). */}
      <For each={props.bands()}>
        {(b) => (
          <div class="absolute left-0 right-0 flex justify-center" style={{ top: `${b.labelTop}px` }} title={displayDirection(b.name)}>
            <span
              class="whitespace-nowrap leading-none"
              style={{
                'writing-mode': 'vertical-rl',
                transform: 'rotate(180deg)',
                color: b.color,
                'font-size': '10px',
                'letter-spacing': '0.04em',
              }}
            >
              {displayDirection(b.name)}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
