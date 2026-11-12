import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { api, type Block } from '../lib/api.js';
import {
  busyFromBlocks, formatClock, formatDuration, openTime, parseHHMM,
  type OpenSegment, type TimeRange,
} from '../lib/open-time.js';
import { localISODate } from '../lib/dates.js';
import { colorVar, directionColorForTask, BASE_TAG_DEFAULTS } from '../lib/pattern-meta.js';
import { blockColorVar } from '../lib/textures.js';
import { isTaskBlock, occupiesMinuteAxis } from '../lib/overlay.js';
import {
  blocks, categoryPrefs, patternBlocks, patternPrefs, tags, taskOf,
  openTimeRange, setElementModal,
} from '../stores/index.js';
import { Skeleton } from './Skeleton.js';

const DAY_MINUTES = 24 * 60;
const DAY_TICKS = [0, 180, 360, 540, 720, 900, 1080, 1260, DAY_MINUTES];

interface OpenSlot extends TimeRange { directions: string[] }

interface TimelineBlock {
  block: Block;
  task?: ReturnType<typeof taskOf>;
  start: number;
  end: number;
  directions: string[];
  color: string;
  title: string;
}

interface WindowEdge {
  minute: number;
  items: Array<{ direction: string; edge: 'start' | 'end' | 'both' }>;
}

type PopupState =
  | { kind: 'block'; id: string; pinned: boolean }
  | { kind: 'open'; start: number; end: number; directions: string[] };

/** Merge overlapping open windows into one clickable interval while retaining the
 * directions available throughout each part of that interval. */
function combineOpenSlots(segments: OpenSegment[]): OpenSlot[] {
  const points = [...new Set(segments.flatMap((segment) => [segment.start, segment.end]))]
    .sort((a, b) => a - b);
  const out: OpenSlot[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const directions = [...new Set(segments
      .filter((segment) => segment.start <= start && segment.end >= end)
      .flatMap((segment) => segment.directions))]
      .sort((a, b) => directionRank(a) - directionRank(b) || a.localeCompare(b));
    if (!directions.length) continue;
    const previous = out[out.length - 1];
    if (previous && previous.end === start && sameNames(previous.directions, directions)) previous.end = end;
    else out.push({ start, end, directions });
  }
  return out;
}

const DIRECTION_ORDER = ['work', 'home', 'community'];
function directionRank(direction: string): number {
  const index = DIRECTION_ORDER.indexOf(direction);
  return index < 0 ? DIRECTION_ORDER.length : index;
}
function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
function percent(minute: number): string {
  return `${Math.max(0, Math.min(100, (minute / DAY_MINUTES) * 100))}%`;
}
function tickLabel(minute: number): string {
  if (minute === DAY_MINUTES || minute === 0) return minute === DAY_MINUTES ? 'Midnight' : '12am';
  const hour = Math.floor(minute / 60);
  if (hour === 12) return '12pm';
  return `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
}
function localMinute(value: string): number | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getHours() * 60 + date.getMinutes();
}
function isInDay(block: Block, date: string): boolean {
  const start = new Date(block.start_at);
  return !Number.isNaN(start.getTime()) && localISODate(start) === date;
}

export function OpenTimeSummary(props: { date: string }) {
  // Re-read when this date changes or its day-window overrides are edited.
  const [windows] = createResource(
    () => [props.date, patternBlocks()] as const,
    ([date]) => api.patternBlocks.forDate(date).then((result) => result.windows).catch(() => ({})),
  );

  const directionName = createMemo(() => {
    const names = new Map<string, string>();
    for (const tag of tags() ?? []) if (tag.kind === 'direction') names.set(tag.id, tag.name.toLowerCase());
    return names;
  });

  /** Directions whose show_open_time preference is enabled for this day strip. */
  const visibleDirections = createMemo(() => {
    const preferences = patternPrefs()?.prefs;
    return (tags() ?? [])
      .filter((tag) => tag.kind === 'direction' && preferences?.[tag.id]?.show_open_time !== false)
      .map((tag) => tag.name.toLowerCase())
      .sort((a, b) => directionRank(a) - directionRank(b) || a.localeCompare(b));
  });

  const byDirection = createMemo<Record<string, TimeRange[]>>(() => {
    const out: Record<string, TimeRange[]> = {};
    for (const [tagId, ranges] of Object.entries(windows() ?? {})) {
      const name = directionName().get(tagId);
      if (!name) continue;
      for (const range of ranges as { start_time: string; end_time: string }[]) {
        const start = parseHHMM(range.start_time);
        const end = parseHHMM(range.end_time);
        if (start === null || end === null || end <= start) continue;
        (out[name] ??= []).push({ start, end });
      }
    }
    return out;
  });

  const busy = createMemo<TimeRange[]>(() => busyFromBlocks(blocks() ?? [], props.date));
  const openSegments = createMemo(() => openTime(byDirection(), busy(), visibleDirections(), openTimeRange()));
  const openSlots = createMemo(() => combineOpenSlots(openSegments()));
  const openMinutes = createMemo(() => openSlots().reduce((total, slot) => total + slot.end - slot.start, 0));
  const loading = () => windows.loading;

  const directionColor = (direction: string): string => {
    const tag = (tags() ?? []).find((item) => item.kind === 'direction' && item.name.toLowerCase() === direction);
    if (!tag) return 'var(--primary)';
    const token = patternPrefs()?.prefs?.[tag.id]?.color_token ?? BASE_TAG_DEFAULTS[direction]?.color_token;
    return colorVar(token);
  };

  const timelineBlocks = createMemo<TimelineBlock[]>(() => {
    const output: TimelineBlock[] = [];
    for (const block of blocks() ?? []) {
      if (!occupiesMinuteAxis(block) || !isInDay(block, props.date)) continue;
      const start = localMinute(block.start_at);
      const rawEnd = localMinute(block.end_at);
      const endDate = new Date(block.end_at);
      if (start === null || rawEnd === null || Number.isNaN(endDate.getTime())) continue;
      const end = localISODate(endDate) === props.date ? rawEnd : DAY_MINUTES;
      if (end <= start) continue;

      const task = block.task_id ? taskOf(block.task_id) : undefined;
      const validDirections = new Set((tags() ?? []).filter((tag) => tag.kind === 'direction').map((tag) => tag.name.toLowerCase()));
      const directions = [...new Set((task?.tags?.length ? task.tags : block.tag ? [block.tag] : [])
        .map((name) => name.toLowerCase())
        .filter((name) => validDirections.has(name)))];
      const color = task
        ? directionColorForTask(task, tags() ?? [], patternPrefs()?.prefs ?? {})
        : directions[0]
          ? directionColor(directions[0])
          : blockColorVar(block, categoryPrefs()?.prefs);

      output.push({
        block,
        task,
        start: Math.max(0, start),
        end: Math.min(DAY_MINUTES, end),
        directions: directions.sort((a, b) => directionRank(a) - directionRank(b) || a.localeCompare(b)),
        color,
        title: task?.title ?? block.title,
      });
    }
    return output.sort((a, b) => a.start - b.start || a.end - b.end);
  });

  const windowEdges = createMemo<WindowEdge[]>(() => {
    const byMinute = new Map<number, Map<string, { start: boolean; end: boolean }>>();
    const addEdge = (minute: number, direction: string, edge: 'start' | 'end') => {
      if (!visibleDirections().includes(direction)) return;
      let byDirection = byMinute.get(minute);
      if (!byDirection) { byDirection = new Map(); byMinute.set(minute, byDirection); }
      const state = byDirection.get(direction) ?? { start: false, end: false };
      state[edge] = true;
      byDirection.set(direction, state);
    };
    for (const [direction, ranges] of Object.entries(byDirection())) {
      for (const range of ranges) {
        addEdge(range.start, direction, 'start');
        addEdge(range.end, direction, 'end');
      }
    }
    return [...byMinute.entries()].sort(([a], [b]) => a - b).map(([minute, byDirectionAtMinute]) => ({
      minute,
      items: [...byDirectionAtMinute.entries()]
        .sort(([a], [b]) => directionRank(a) - directionRank(b) || a.localeCompare(b))
        .map(([direction, edge]) => ({ direction, edge: edge.start && edge.end ? 'both' as const : edge.start ? 'start' as const : 'end' as const })),
    }));
  });

  const [dimmedDirections, setDimmedDirections] = createSignal<Set<string>>(new Set());
  function toggleDirection(direction: string) {
    setDimmedDirections((previous) => {
      const next = new Set(previous);
      if (next.has(direction)) next.delete(direction);
      else next.add(direction);
      return next;
    });
  }
  const isDimmed = (directions: string[]) => directions.length > 0 && directions.every((name) => dimmedDirections().has(name));

  const [popup, setPopup] = createSignal<PopupState | null>(null);
  const [now, setNow] = createSignal(new Date());
  let rootEl: HTMLDivElement | undefined;
  let trackEl: HTMLDivElement | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    const updateNow = () => setNow(new Date());
    const interval = window.setInterval(updateNow, 60_000);
    const onOutsidePointer = (event: PointerEvent) => {
      if (rootEl && !rootEl.contains(event.target as Node)) setPopup(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopup(null);
    };
    document.addEventListener('pointerdown', onOutsidePointer);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.clearInterval(interval);
      if (closeTimer) clearTimeout(closeTimer);
      document.removeEventListener('pointerdown', onOutsidePointer);
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  const currentMinute = () => props.date < localISODate(now()) ? DAY_MINUTES
    : props.date > localISODate(now()) ? -1
      : now().getHours() * 60 + now().getMinutes();

  function cancelClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  function scheduleClose() {
    cancelClose();
    closeTimer = setTimeout(() => {
      const current = popup();
      if (current?.kind === 'block' && !current.pinned) setPopup(null);
    }, 180);
  }

  function editTimelineBlock(item: TimelineBlock) {
    setPopup(null);
    if (isTaskBlock(item.block) && item.task) {
      const kind = item.task.is_habit ? 'habit' : 'task';
      setElementModal({ open: true, mode: 'edit', kind, editTarget: { kind, id: item.task.id } });
    } else {
      setElementModal({ open: true, mode: 'edit', kind: 'timeblock', editTarget: { kind: 'timeblock', id: item.block.id } });
    }
  }

  function openAt(kind: 'task' | 'timeblock', slot: OpenSlot) {
    const current = popup();
    const clickMinute = current?.kind === 'open' ? current.start : slot.start;
    const start = Math.max(slot.start, Math.min(slot.end - 15, Math.floor(clickMinute / 15) * 15));
    const durationMin = Math.max(15, Math.min(60, slot.end - start));
    setPopup(null);
    setElementModal({
      open: true,
      mode: 'add',
      kind,
      prefill: { day: props.date, start: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`, durationMin },
    });
  }

  function clickOpenSlot(event: MouseEvent, slot: OpenSlot) {
    event.stopPropagation();
    const rect = trackEl?.getBoundingClientRect();
    const minute = rect && rect.width > 0
      ? Math.max(slot.start, Math.min(slot.end - 1, Math.floor(((event.clientX - rect.left) / rect.width) * DAY_MINUTES)))
      : slot.start;
    setPopup({ kind: 'open', start: minute, end: slot.end, directions: slot.directions });
  }

  function clickTimelineBlock(item: TimelineBlock) {
    const current = popup();
    if (current?.kind === 'block' && current.id === item.block.id && current.pinned) {
      editTimelineBlock(item);
    } else {
      setPopup({ kind: 'block', id: item.block.id, pinned: true });
    }
  }

  const popupBlock = () => {
    const current = popup();
    return current?.kind === 'block' ? timelineBlocks().find((item) => item.block.id === current.id) : undefined;
  };
  const openPopup = () => {
    const current = popup();
    return current?.kind === 'open' ? current : undefined;
  };

  return (
    <div
      ref={(element) => { rootEl = element; }}
      class="open-time-summary"
      onPointerEnter={cancelClose}
      onPointerLeave={scheduleClose}
    >
      <div class="open-time-summary-head">
        <span class="section-label !mb-0">Open time</span>
        <span class="text-[10.5px] text-muted-foreground">{visibleDirections().map((direction) => direction[0].toUpperCase() + direction.slice(1)).join(', ') || 'No directions selected'}</span>
        <div class="flex-1" />
        <Show when={!loading()}>
          <span class="text-[10.5px] text-muted-foreground font-mono whitespace-nowrap">
            {openSlots().length} window{openSlots().length === 1 ? '' : 's'} · {formatDuration(openMinutes())}
          </span>
        </Show>
      </div>

      <Show
        when={!loading()}
        fallback={<div role="status" class="open-time-loading"><span class="sr-only">Reading the day's windows</span><Skeleton class="h-8" /></div>}
      >
        <div class="open-time-axis" aria-hidden="true">
          <For each={DAY_TICKS}>{(minute, index) => (
            <span
              class="open-time-axis-tick"
              classList={{ 'is-first': index() === 0, 'is-last': index() === DAY_TICKS.length - 1 }}
              style={{ left: percent(minute) }}
            >{tickLabel(minute)}</span>
          )}</For>
        </div>

        <div class="open-time-window-edges" aria-label="Availability window changes">
          <For each={windowEdges()}>{(edge) => (
            <div
              class="open-time-window-edge"
              classList={{ 'is-first': edge.minute === 0, 'is-last': edge.minute === DAY_MINUTES }}
              style={{ left: percent(edge.minute) }}
            >
              <For each={edge.items}>{(item) => (
                <span
                  class="open-time-bug"
                  classList={{
                    'is-dimmed': edge.minute < currentMinute() || dimmedDirections().has(item.direction),
                    'is-ending': item.edge === 'end',
                  }}
                  style={{ '--bug-color': directionColor(item.direction) }}
                  title={`${item.direction} window ${item.edge === 'end' ? 'ends' : item.edge === 'both' ? 'changes' : 'starts'} at ${formatClock(edge.minute)}`}
                >{item.direction.charAt(0).toUpperCase()}</span>
              )}</For>
            </div>
          )}</For>
        </div>

        <div
          ref={(element) => { trackEl = element; }}
          class="open-time-track"
          role="group"
          aria-label={`Open-time timeline for ${props.date}`}
        >
          <For each={openSlots()}>{(slot) => (
            <button
              type="button"
              class="open-time-slot"
              classList={{ 'is-dimmed': isDimmed(slot.directions) }}
              style={{ left: percent(slot.start), width: percent(slot.end - slot.start) }}
              aria-label={`Open ${slot.directions.join(' and ')} time, ${formatClock(slot.start)} to ${formatClock(slot.end)}. Add a task or block.`}
              title={`Open ${slot.directions.join(' / ')} · ${formatClock(slot.start)}–${formatClock(slot.end)}`}
              onClick={(event) => clickOpenSlot(event, slot)}
            />
          )}</For>

          <For each={timelineBlocks()}>{(item) => (
            <button
              type="button"
              class="open-time-scheduled"
              classList={{ 'is-dimmed': isDimmed(item.directions), 'has-label': item.end - item.start >= 90 }}
              style={{
                left: percent(item.start),
                width: percent(item.end - item.start),
                '--item-color': item.color,
              }}
              aria-label={`${item.title}, ${formatClock(item.start)} to ${formatClock(item.end)}. Click to preview; click again to edit.`}
              onPointerEnter={() => {
                cancelClose();
                const current = popup();
                if (current?.kind !== 'block' || current.id !== item.block.id) {
                  setPopup({ kind: 'block', id: item.block.id, pinned: false });
                }
              }}
              onClick={(event) => { event.stopPropagation(); clickTimelineBlock(item); }}
            >
              <span class="open-time-scheduled-title">{item.title}</span>
              <Show when={item.directions.length > 0}>
                <span class="open-time-scheduled-bugs" aria-hidden="true">
                  <For each={item.directions}>{(direction) => (
                    <span class="open-time-bug" style={{ '--bug-color': directionColor(direction) }}>{direction.charAt(0).toUpperCase()}</span>
                  )}</For>
                </span>
              </Show>
            </button>
          )}</For>
        </div>

        <Show when={visibleDirections().length > 0}>
          <div class="open-time-filters" aria-label="Dim directions on the timeline">
            <For each={visibleDirections()}>{(direction) => (
              <button
                type="button"
                class="open-time-filter"
                classList={{ 'is-dimmed': dimmedDirections().has(direction) }}
                aria-pressed={!dimmedDirections().has(direction)}
                onClick={() => toggleDirection(direction)}
              >#{direction}</button>
            )}</For>
          </div>
        </Show>

        <Show when={openPopup()}>
          {(state) => (
            <div class="open-time-popup" role="dialog" aria-label="Add to open time" onPointerEnter={cancelClose}>
              <div class="open-time-popup-copy">
                <strong>Open time</strong>
                <span>{formatClock(state().start)}–{formatClock(state().end)}</span>
                <small>{state().directions.join(' · ')}</small>
              </div>
              <div class="open-time-popup-actions">
                <button type="button" class="btn-primary text-xs px-2 py-1" onClick={() => openAt('task', { start: state().start, end: state().end, directions: state().directions })}>New task</button>
                <button type="button" class="btn-secondary text-xs px-2 py-1" onClick={() => openAt('timeblock', { start: state().start, end: state().end, directions: state().directions })}>Block</button>
              </div>
            </div>
          )}
        </Show>

        <Show when={popupBlock()}>
          {(item) => (
            <div class="open-time-popup" role="dialog" aria-label={`${item().title} details`} onPointerEnter={cancelClose}>
              <div class="open-time-popup-copy">
                <strong>{item().title}</strong>
                <span>{formatClock(item().start)}–{formatClock(item().end)}</span>
                <small>{item().directions.join(' · ') || 'Scheduled'}</small>
              </div>
              <button type="button" class="btn-secondary text-xs px-2 py-1" onClick={() => editTimelineBlock(item())}>
                {item().task ? 'Open task' : 'Edit block'}
              </button>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
