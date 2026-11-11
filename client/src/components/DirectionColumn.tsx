import { For, createMemo } from 'solid-js';
import { PX_PER_MIN } from '../lib/grid.js';
import { type AxisState, axisHeightPx, yOf as axisYOf } from '../lib/day-axis.js';
import { displayDirection, type Band } from '../lib/day-windows.js';

const BADGE_HEIGHT_PX = 14;
const BADGE_GAP_PX = 2;
const BADGE_TOP_INSET_PX = 4;

type TransitionBadge = { band: Band; top: number };
type TransitionMarker = { minute: number; badges: TransitionBadge[] };

/**
 * The Direction column: a thin, fixed-width lane (right after the time gutter) that
 * marks the day's availability windows. Each band gets a 3px coloured left edge.
 * Letter badges show the set of active window types at every start/end transition, so
 * a continuing window is repeated when another one closes. Past transition badges dim.
 * Fixed width by design — it never widens, so the grid stays stable.
 *
 * Purely indicative + pointer-transparent: the windows are owned by day-type settings,
 * not edited here. Bands are computed once in the Planner and shared with the
 * background bands (`PatternBlockOverlay`) so the two never drift; the Planner
 * reprojects each band's extent onto the segmented day axis before passing it in.
 */
export function DirectionColumn(props: {
  bands: () => Band[];
  state: () => AxisState;
  currentMinute: () => number;
}) {
  const markers = createMemo((): TransitionMarker[] => {
    const bands = props.bands();
    const times = [...new Set(bands.flatMap((band) => [band.startMin, band.endMin]))].sort((a, b) => a - b);
    const transitions: Array<{ minute: number; active: Band[] }> = [];
    const directionOrder: Record<string, number> = { home: 0, community: 1, work: 2 };

    for (const minute of times) {
      // Compare the active type set immediately before and after the boundary.
      // Showing the post-boundary set repeats a still-open window when another closes.
      const before = new Set(bands
        .filter((band) => band.startMin < minute && band.endMin >= minute)
        .map((band) => band.name.toLowerCase()));
      const activeByDirection = new Map<string, Band>();
      for (const band of bands) {
        if (band.startMin <= minute && minute < band.endMin) {
          const key = band.name.toLowerCase();
          if (!activeByDirection.has(key)) activeByDirection.set(key, band);
        }
      }
      const active = [...activeByDirection.entries()]
        .sort(([a], [b]) => (directionOrder[a] ?? 3) - (directionOrder[b] ?? 3) || a.localeCompare(b))
        .map(([, band]) => band);
      const after = new Set(active.map((band) => band.name.toLowerCase()));
      if (!active.length || (before.size === after.size && [...before].every((type) => after.has(type)))) continue;
      transitions.push({ minute, active });
    }

    // Keep nearby transition stacks from colliding while anchoring each as close as
    // possible to the exact point where the active window set changes.
    let previousBottom = -Infinity;
    return transitions.map(({ minute, active }) => {
      const top = Math.max(
        axisYOf(minute, props.state(), PX_PER_MIN) + BADGE_TOP_INSET_PX,
        previousBottom + BADGE_GAP_PX,
      );
      const badges = active.map((band, index) => ({
        band,
        top: top + index * (BADGE_HEIGHT_PX + BADGE_GAP_PX),
      }));
      previousBottom = top + active.length * BADGE_HEIGHT_PX + (active.length - 1) * BADGE_GAP_PX;
      return { minute, badges };
    });
  });

  return (
    <div class="relative pointer-events-none select-none" style={{ height: `${axisHeightPx(props.state(), PX_PER_MIN)}px` }}>
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
      {/* At every boundary, show the full set of window types active after it. */}
      <For each={markers()}>
        {(marker) => <For each={marker.badges}>
          {(badge) => (
            <div class="absolute left-0 right-0 flex justify-center" style={{ top: `${badge.top}px` }}>
              <span
                class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-sm px-0.5 text-[8px] font-semibold leading-none transition-opacity duration-300"
                classList={{ 'opacity-40': marker.minute < props.currentMinute() }}
                title={`${displayDirection(badge.band.name)} window`}
                aria-label={`${displayDirection(badge.band.name)} window`}
                style={{
                  'background-color': badge.band.color,
                  color: 'var(--background)',
                }}
              >
                {displayDirection(badge.band.name).charAt(0)}
              </span>
            </div>
          )}
        </For>}
      </For>
    </div>
  );
}
