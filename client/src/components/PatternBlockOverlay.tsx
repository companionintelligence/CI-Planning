import { For } from 'solid-js';
import { patternBlocks, tags } from '../stores/index.js';
import { isWeekend } from '../lib/dates.js';
import { yOf } from '../lib/grid.js';

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function displayTag(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Renders subtle availability-zone shading behind the Planner grid, one band per
 * pattern-block range. Shows 10% darker-than-background tinting so direction zones
 * are legible without competing with task chips. Pointer-events: none — purely visual.
 */
export function PatternBlockOverlay(props: { date: string }) {
  const dayType = () => (isWeekend(props.date) ? 'weekend' : 'workday');
  const windows = () => patternBlocks()?.[dayType()] ?? {};
  const allTags = () => tags() ?? [];

  return (
    <div class="absolute inset-0 pointer-events-none z-0">
      <For each={Object.entries(windows())}>
        {([dirTagId, ranges]) => {
          const name = () => allTags().find((t) => t.id === dirTagId)?.name ?? '';
          return (
            <For each={ranges}>
              {(range) => {
                const top = () => yOf(timeToMinutes(range.start_time));
                const h   = () => yOf(timeToMinutes(range.end_time)) - top();
                return (
                  <div
                    class="absolute left-0 right-0 bg-foreground/[0.04]"
                    style={{ top: `${top()}px`, height: `${h()}px` }}
                  >
                    <span class="absolute top-1 right-1 text-[10px] text-muted-foreground/70 bg-background/70 rounded px-1.5 py-0.5 leading-none select-none">
                      {displayTag(name())}
                    </span>
                  </div>
                );
              }}
            </For>
          );
        }}
      </For>
    </div>
  );
}
