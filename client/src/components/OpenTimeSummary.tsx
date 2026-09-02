import { For, Show, createMemo, createResource } from 'solid-js';
import { api } from '../lib/api.js';
import { blocks, tags, patternPrefs, openTimeRange } from '../stores/index.js';
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
 * Which directions count is per-direction owner preference (`show_open_time`, set
 * next to that direction's windows in `SchedulePatternEditor`) — default on for
 * every direction, including home.
 */
/** Fixed display order for the three built-in directions; anything else (a custom
 *  direction) sorts after them, alphabetically. */
const DIRECTION_ORDER = ['work', 'home', 'community'];
function directionRank(direction: string): number {
  const i = DIRECTION_ORDER.indexOf(direction);
  return i === -1 ? DIRECTION_ORDER.length : i;
}

/** Single-letter tag for the open-window row; an unrecognized (custom) direction
 *  still gets a sane initial rather than rendering blank. */
function directionLetter(direction: string): string {
  if (direction === 'work') return 'W';
  if (direction === 'home') return 'H';
  if (direction === 'community') return 'C';
  return direction.charAt(0).toUpperCase();
}

/** "Work, home & community hours" — built from whichever directions are actually
 *  showing, so the subtitle never claims a direction the card doesn't list. Only the
 *  leading word is capitalized (mid-sentence uses of this read naturally too). */
function describeDirections(directions: string[]): string {
  const body = directions.length === 0
    ? 'hours'
    : directions.length === 1
      ? `${directions[0]} hours`
      : `${directions.slice(0, -1).join(', ')} & ${directions[directions.length - 1]} hours`;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

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

  /** Directions whose `show_open_time` pref is on (default true) — the set the card
   *  actually reports, in a fixed work/home/community-first display order. */
  const visibleDirections = createMemo(() => {
    const prefs = patternPrefs()?.prefs;
    const names: string[] = [];
    for (const t of tags() ?? []) {
      if (t.kind !== 'direction') continue;
      if ((prefs?.[t.id]?.show_open_time ?? true) === false) continue;
      names.push(t.name.toLowerCase());
    }
    return names.sort((a, b) => directionRank(a) - directionRank(b) || a.localeCompare(b));
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

  // Clamped to the owner's Open Time range (view_prefs.today, default 9am-8pm): a
  // window may run far wider than the hours anyone would actually schedule into.
  const segments = createMemo(() => openTime(byDirection(), busy(), visibleDirections(), openTimeRange()));
  const total = () => totalOpen(segments());
  const loading = () => dayType.loading || windows.loading;

  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="section-label !mb-0">Open time</span>
        <span class="text-[10.5px] text-muted-foreground">{describeDirections(visibleDirections())}</span>
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
              No open time left in {describeDirections(visibleDirections())}.
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
                <span class="open-window-tags">
                  <For each={s.directions}>
                    {(d) => <span class="open-window-tag" data-direction={d} title={d}>{directionLetter(d)}</span>}
                  </For>
                </span>
                <span class="open-window-dur">{formatDuration(s.end - s.start)}</span>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
