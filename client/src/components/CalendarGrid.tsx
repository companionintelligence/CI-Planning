import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { Lock } from 'lucide-solid';
import type { Block } from '../lib/api.js';
import {
  PX_PER_MIN,
  DAY_HEIGHT_PX,
  minutesIntoDay,
  yOf,
} from '../lib/grid.js';
import {
  HANDLE_PX,
  type GestureMode,
  isImmovable,
  resolveGesture,
  commitDrag,
} from '../lib/drag.js';
import { showToast } from '../stores/index.js';
import { isAllDay, isTimed } from '../lib/overlay.js';
import { localISODate, addDays } from '../lib/dates.js';

// ── Palette (mirrors BlockCard's CI teal kinds) ───────────────────────────────
const kindColor: Record<string, string> = {
  task:    '#409b9b', // ci-4
  meeting: '#244859', // ci-10
  focus:   '#58ebbf', // ci-3
  habit:   '#85c3b4', // ci-2
  break:   '#1a3040',
  buffer:  '#152637',
};

// Minimum visible chip height (px). Display-only clamp — the stored duration is
// never altered, position math still uses the true minutes.
const MIN_CHIP_PX = 18;

/** A block placed in the overlap layout: vertical extent + horizontal column slot. */
interface Placed {
  block: Block;
  top: number;     // minutes into day
  height: number;  // minutes
  col: number;     // column index within its cluster (0-based)
  cols: number;    // total columns in its cluster (cluster width)
}

/**
 * Overlap layout: sort blocks by start, sweep into clusters of mutually
 * overlapping blocks, and assign each a column slot so concurrent blocks tile
 * side-by-side. `cols` (cluster width) > 1 is the signal for conflict
 * highlighting. O(n log n) per day.
 */
export function layoutBlocks(blocks: Block[], dayStr: string): Placed[] {
  const items = blocks
    .filter(isTimed) // all-day blocks live in the header lane, off the minute axis
    .map((block) => {
      const top = minutesIntoDay(block.start_at, dayStr);
      const end = minutesIntoDay(block.end_at, dayStr);
      return { block, top, height: Math.max(end - top, 0) };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  const out: Placed[] = [];
  let cluster: typeof items = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    // Greedy column packing: place each block in the first column whose last
    // block has already ended; cluster width = max columns used.
    const colEnds: number[] = []; // end-minute of the last block in each column
    const assigned: { item: (typeof items)[number]; col: number }[] = [];
    for (const it of cluster) {
      let col = colEnds.findIndex((e) => e <= it.top);
      if (col === -1) { col = colEnds.length; colEnds.push(it.top + it.height); }
      else colEnds[col] = it.top + it.height;
      assigned.push({ item: it, col });
    }
    const cols = colEnds.length;
    for (const a of assigned) {
      out.push({ block: a.item.block, top: a.item.top, height: a.item.height, col: a.col, cols });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    if (it.top >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.top + it.height);
  }
  flush();
  return out;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function dayLabel(dayStr: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(dayStr + 'T12:00:00Z').toLocaleDateString('en-US', opts);
}

// ── Now line: ticks every minute, only in today's column ──────────────────────
function NowLine(props: { day: string }) {
  const [mins, setMins] = createSignal(minutesIntoDay(new Date().toISOString(), props.day));
  const t = setInterval(
    () => setMins(minutesIntoDay(new Date().toISOString(), props.day)),
    60_000,
  );
  onCleanup(() => clearInterval(t));
  return (
    <div
      class="absolute left-0 right-0 z-20 pointer-events-none"
      style={{ top: `${yOf(mins())}px` }}
    >
      <div class="h-px bg-accent-hi shadow-[0_0_6px_rgba(88,235,191,.6)]" />
      <div class="absolute -left-1 -top-[3px] w-[7px] h-[7px] rounded-full bg-accent-hi" />
    </div>
  );
}

// ── Block chip (time-axis positioned, draggable + resizable) ──────────────────
function BlockChip(props: { placed: Placed; day: string }) {
  const b = () => props.placed.block;
  const color = () => kindColor[b().block_kind] ?? '#152637';
  const conflict = () => props.placed.cols > 1;
  const done = () => ['completed', 'skipped'].includes(b().status);
  const locked = () => isImmovable(b());

  // Live gesture state: a pixel delta + the edge(s) being dragged. Only the local
  // chip moves during the gesture; the single PATCH fires on pointer-up.
  const [drag, setDrag] = createSignal<{ mode: GestureMode; dy: number } | null>(null);

  // Base extent (minutes) with the in-flight gesture applied — visual only.
  const liveTop = () => {
    const g = drag();
    if (!g) return props.placed.top;
    const dMin = g.dy / PX_PER_MIN;
    if (g.mode === 'move' || g.mode === 'resize-top') return props.placed.top + dMin;
    return props.placed.top;
  };
  const liveHeight = () => {
    const g = drag();
    if (!g) return props.placed.height;
    const dMin = g.dy / PX_PER_MIN;
    if (g.mode === 'move') return props.placed.height;
    if (g.mode === 'resize-top') return props.placed.height - dMin;
    return props.placed.height + dMin; // resize-bottom
  };
  const heightPx = () => Math.max(yOf(liveHeight()), MIN_CHIP_PX);

  function startGesture(mode: GestureMode, e: PointerEvent) {
    if (locked()) return; // locked / meeting: no gesture, no PATCH
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => setDrag({ mode, dy: ev.clientY - startY });
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture?.(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const dy = ev.clientY - startY;
      setDrag(null);
      // Resolve through the pure gesture math and emit exactly one PATCH.
      const resolved = resolveGesture(b(), props.day, mode, dy);
      void commitDrag(b(), resolved, { onError: (m) => showToast(m, 'error') });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    setDrag({ mode, dy: 0 });
  }

  return (
    <div
      class="absolute rounded-md overflow-hidden text-[11px] leading-tight border transition-colors select-none touch-none"
      classList={{
        'opacity-40': done(),
        'ring-1 ring-amber-400/70': conflict(),
        'cursor-grab': !locked(),
        'cursor-default': locked(),
        'z-10 cursor-grabbing shadow-lg': !!drag(),
      }}
      style={{
        top: `${yOf(liveTop())}px`,
        height: `${heightPx()}px`,
        left: `${(props.placed.col / props.placed.cols) * 100}%`,
        width: `calc(${100 / props.placed.cols}% - 2px)`,
        'background-color': `${color()}26`,       // ~15% alpha fill
        'border-color': color(),
        'border-left-width': '3px',
      }}
      title={`${b().title} · ${fmtTime(b().start_at)}–${fmtTime(b().end_at)}`}
      onPointerDown={[ (e: PointerEvent) => startGesture('move', e) ][0]}
    >
      {/* Top resize handle */}
      <Show when={!locked()}>
        <div
          class="absolute top-0 left-0 right-0 cursor-ns-resize z-10"
          style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(e) => startGesture('resize-top', e)}
        />
      </Show>
      <div class="px-1.5 py-0.5">
        <div class="flex items-center gap-1 font-medium text-slate-100 truncate">
          <Show when={b().is_locked}><Lock size={9} class="text-slate-400 flex-shrink-0" /></Show>
          <span class="truncate">{b().title}</span>
        </div>
        <Show when={heightPx() >= 30}>
          <div class="text-slate-400 truncate">{fmtTime(b().start_at)}</div>
        </Show>
      </div>
      {/* Bottom resize handle */}
      <Show when={!locked()}>
        <div
          class="absolute bottom-0 left-0 right-0 cursor-ns-resize z-10"
          style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(e) => startGesture('resize-bottom', e)}
        />
      </Show>
    </div>
  );
}

// ── All-day chip (pinned header lane; not on the minute axis) ──────────────────
function AllDayChip(props: { block: Block }) {
  const color = () => kindColor[props.block.block_kind] ?? '#152637';
  const done = () => ['completed', 'skipped'].includes(props.block.status);
  return (
    <div
      class="rounded px-1.5 py-0.5 text-[10px] leading-tight truncate border-l-2"
      classList={{ 'opacity-40': done() }}
      style={{
        'background-color': `${color()}26`,
        'border-left-color': color(),
      }}
      title={props.block.title}
    >
      <span class="text-slate-200">{props.block.title}</span>
    </div>
  );
}

// ── Time gutter (hour labels) ─────────────────────────────────────────────────
function TimeGutter() {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div class="relative" style={{ height: `${DAY_HEIGHT_PX}px` }}>
      <For each={hours}>
        {(h) => (
          <div
            class="absolute right-1.5 -translate-y-1/2 text-[10px] text-slate-500 font-mono tabular-nums"
            style={{ top: `${yOf(h * 60)}px` }}
          >
            <Show when={h > 0}>
              {new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })}
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

// ── Hour gridlines for a day column ───────────────────────────────────────────
function HourLines() {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <For each={hours}>
      {(h) => (
        <div
          class="absolute left-0 right-0 border-t border-surface-700/50"
          style={{ top: `${yOf(h * 60)}px` }}
        />
      )}
    </For>
  );
}

interface Props {
  /** 'day' | 'week' → time-axis grid over `days`; 'month' → 6×7 cell renderer. */
  view: 'day' | 'week' | 'month';
  /** Visible local days (YYYY-MM-DD). Day=1, Week=7, Month=42. */
  days: string[];
  /** Blocks already fetched for the visible range, grouped by local day. */
  blocksByDay: () => Record<string, Block[]>;
}

export function CalendarGrid(props: Props) {
  const today = () => localISODate();

  // Time-axis views (day + week) share the same renderer.
  const TimeAxis = () => (
    <div class="overflow-auto rounded-xl border border-surface-700 bg-surface-800">
      {/* Day-of-week header */}
      <div
        class="grid sticky top-0 z-30 bg-surface-800/95 backdrop-blur border-b border-surface-700"
        style={{ 'grid-template-columns': `3.5rem repeat(${props.days.length}, 1fr)` }}
      >
        <div />
        <For each={props.days}>
          {(day) => (
            <div
              class="py-2 text-center border-l border-surface-700/60"
              classList={{ 'text-accent-light': day === today() }}
            >
              <div class="text-[10px] uppercase tracking-wide text-slate-500">
                {dayLabel(day, { weekday: 'short' })}
              </div>
              <div class="text-sm font-semibold" classList={{ 'text-slate-200': day !== today() }}>
                {dayLabel(day, { day: 'numeric' })}
              </div>
            </div>
          )}
        </For>
      </div>

      {/* All-day lane: pinned above the minute axis. Only shown when any visible
          day has all-day blocks, so a column without the migration (no all_day)
          simply renders nothing here. */}
      <Show when={props.days.some((d) => (props.blocksByDay()[d] ?? []).some(isAllDay))}>
        <div
          class="grid sticky top-[3.25rem] z-20 bg-surface-800/95 backdrop-blur border-b border-surface-700"
          style={{ 'grid-template-columns': `3.5rem repeat(${props.days.length}, 1fr)` }}
        >
          <div class="flex items-start justify-end pr-1.5 pt-1 text-[9px] uppercase tracking-wide text-slate-500">
            all-day
          </div>
          <For each={props.days}>
            {(day) => (
              <div class="border-l border-surface-700/60 p-1 flex flex-col gap-0.5 min-h-[1.75rem]">
                <For each={(props.blocksByDay()[day] ?? []).filter(isAllDay)}>
                  {(b) => <AllDayChip block={b} />}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Time grid */}
      <div
        class="grid"
        style={{ 'grid-template-columns': `3.5rem repeat(${props.days.length}, 1fr)` }}
      >
        <TimeGutter />
        <For each={props.days}>
          {(day) => {
            const placed = createMemo(() => layoutBlocks(props.blocksByDay()[day] ?? [], day));
            return (
              <div class="relative border-l border-surface-700/60" style={{ height: `${DAY_HEIGHT_PX}px` }}>
                <HourLines />
                <For each={placed()}>
                  {(p) => <BlockChip placed={p} day={day} />}
                </For>
                <Show when={day === today()}>
                  <NowLine day={day} />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );

  // Month view: 6×7 cell grid, each cell a date + count + chips (no time axis).
  const anchorMonth = () => {
    // The "current" month is whichever month owns the majority of cells (week 3-4).
    return props.days[Math.floor(props.days.length / 2)]?.slice(0, 7);
  };
  const MAX_CHIPS = 3;

  const MonthGrid = () => (
    <div class="rounded-xl border border-surface-700 bg-surface-800 overflow-hidden">
      <div class="grid grid-cols-7 border-b border-surface-700">
        <For each={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}>
          {(d) => (
            <div class="py-2 text-center text-[10px] uppercase tracking-wide text-slate-500 border-l border-surface-700/40 first:border-l-0">
              {d}
            </div>
          )}
        </For>
      </div>
      <div class="grid grid-cols-7" style={{ 'grid-auto-rows': '1fr' }}>
        <For each={props.days}>
          {(day, i) => {
            const dayBlocks = () =>
              (props.blocksByDay()[day] ?? []).slice().sort((a, b) => a.start_at.localeCompare(b.start_at));
            const inMonth = () => day.slice(0, 7) === anchorMonth();
            const isToday = () => day === today();
            return (
              <div
                class="min-h-[6rem] p-1.5 border-l border-t border-surface-700/40 first:border-l-0"
                classList={{
                  'opacity-45': !inMonth(),
                  'border-t-0': i() < 7,
                }}
              >
                <div class="flex items-center justify-between mb-1">
                  <span
                    class="text-xs font-mono tabular-nums"
                    classList={{
                      'text-slate-400': inMonth() && !isToday(),
                      'text-slate-600': !inMonth(),
                      'inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-surface-950 font-semibold': isToday(),
                    }}
                  >
                    {dayLabel(day, { day: 'numeric' })}
                  </span>
                  <Show when={dayBlocks().length > 0}>
                    <span class="text-[10px] text-slate-500">{dayBlocks().length}</span>
                  </Show>
                </div>
                <div class="flex flex-col gap-0.5">
                  <For each={dayBlocks().slice(0, MAX_CHIPS)}>
                    {(b) => (
                      <div
                        class="text-[10px] leading-tight truncate rounded px-1 py-0.5"
                        style={{
                          'background-color': `${kindColor[b.block_kind] ?? '#152637'}26`,
                          'border-left': `2px solid ${kindColor[b.block_kind] ?? '#152637'}`,
                        }}
                        title={`${b.title} · ${fmtTime(b.start_at)}`}
                      >
                        <span class="text-slate-300">{b.title}</span>
                      </div>
                    )}
                  </For>
                  <Show when={dayBlocks().length > MAX_CHIPS}>
                    <div class="text-[10px] text-slate-500 px-1">
                      +{dayBlocks().length - MAX_CHIPS} more
                    </div>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );

  return (
    <Show when={props.view === 'month'} fallback={<TimeAxis />}>
      <MonthGrid />
    </Show>
  );
}

// Re-export for the view to compute the anchor day's neighbors if needed.
export { addDays };
