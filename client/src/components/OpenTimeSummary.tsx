import { For, Show, createMemo, createResource } from 'solid-js';
import { api } from '../lib/api.js';
import { blocks, tags } from '../stores/index.js';
import {
  busyFromBlocks, formatClock, formatDuration, openTime, parseHHMM, totalOpen,
  type TimeRange,
} from '../lib/open-time.js';

/**
 * Today's header answers "when could I put something?" rather than re-listing the
 * schedule — the Planner tab and the Calendar both already show the blocks.
 *
 * Windows come from the day type resolved for this date (`pattern-blocks/:dayType`),
 * so the summary reflects the operator's configured hours instead of assumed ones.
 * Only work and community windows count; home hours are the day's own time.
 */
export function OpenTimeSummary(props: { date: string }) {
  // Which day type applies to this date, then that day type's placement windows.
  const [dayType] = createResource(
    () => props.date,
    (date) => api.dayTypes.resolve(date).then((r) => r.key).catch(() => null),
  );
  const [windows] = createResource(
    () => dayType() ?? null,
    (key) => api.patternBlocks.forDay(key).then((r) => r.windows).catch(() => ({})),
  );

  /** Direction tag id → lowercased name, so windows can be read by direction. */
  const directionName = createMemo(() => {
    const m = new Map<string, string>();
    for (const t of tags() ?? []) if (t.kind === 'direction') m.set(t.id, t.name.toLowerCase());
    return m;
  });

  const byDirection = createMemo<Record<string, TimeRange[]>>(() => {
    const out: Record<string, TimeRange[]> = {};
    for (const [tagId, ranges] of Object.entries(windows() ?? {})) {
      const name = directionName().get(tagId);
      if (!name) continue; // a window whose direction was deleted
      for (const r of ranges as { start_time: string; end_time: string }[]) {
        const start = parseHHMM(r.start_time);
        const end = parseHHMM(r.end_time);
        if (start === null || end === null) continue; // malformed row, not a NaN gap
        (out[name] ??= []).push({ start, end });
      }
    }
    return out;
  });

  /** Everything scheduled on this date, as minute intervals. */
  const busy = createMemo<TimeRange[]>(() => busyFromBlocks(blocks() ?? [], props.date));

  const segments = createMemo(() => openTime(byDirection(), busy()));
  const total = () => totalOpen(segments());
  const loading = () => dayType.loading || windows.loading;

  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="section-label !mb-0">Open time</span>
        <span class="text-[10.5px] text-muted-foreground">Work &amp; community hours</span>
        <div class="flex-1" />
        <Show when={!loading()}>
          <span class="text-[10.5px] text-muted-foreground font-mono">
            {segments().length} window{segments().length === 1 ? '' : 's'} · {formatDuration(total())}
          </span>
        </Show>
      </div>

      <Show
        when={!loading()}
        fallback={<p class="text-xs text-muted-foreground">Reading the day's windows…</p>}
      >
        <Show
          when={segments().length > 0}
          fallback={
            <p class="text-xs text-muted-foreground">
              No open time left in work or community hours.
            </p>
          }
        >
          <For each={segments()}>
            {(s) => (
              <div class="open-window">
                <span class="open-window-range">
                  {formatClock(s.start)} – {formatClock(s.end)}
                </span>
                <span class="open-window-bar">
                  {/* Width is the segment against a four-hour reference, so a long
                      afternoon reads as longer at a glance without a second axis. */}
                  <i style={{ width: `${Math.min(100, ((s.end - s.start) / 240) * 100)}%` }} />
                </span>
                <span class="open-window-tag" data-direction={s.direction}>{s.direction}</span>
                <span class="open-window-dur">{formatDuration(s.end - s.start)}</span>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
