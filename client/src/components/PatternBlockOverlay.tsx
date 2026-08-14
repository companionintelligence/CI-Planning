import { For } from 'solid-js';
import type { Band } from '../lib/day-windows.js';

/**
 * Renders availability-zone bands behind the Planner grid — one per pattern-block
 * range. Each band is a 1px outline in its pattern's own colour. Purely visual —
 * pointer-events: none.
 *
 * The bands used to carry a faint shaped hatch (wavy / zigzag / castle, per the
 * pattern icon) as a fill. It was removed: repeated across overlapping Work / Home /
 * Community zones it read as texture noise behind the chips rather than as
 * information, and the outline alone already says where a zone starts and ends.
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
          return (
            <div
              class="absolute left-0 right-0 rounded-sm"
              style={{ top: `${b.top}px`, height: `${b.height}px`, border: `1px solid ${b.color}` }}
            />
          );
        }}
      </For>
    </div>
  );
}
