import { For, Show, createMemo, createSignal, onCleanup, onMount, createEffect } from 'solid-js';
import { Lock, AlertTriangle, Play, Maximize2, Minimize2, Star, Pentagon } from 'lucide-solid';
import type { Block } from '../lib/api.js';
import { PX_PER_MIN, DAY_HEIGHT_PX, minutesIntoDay, yOf } from '../lib/grid.js';
import { HANDLE_PX, type GestureMode, isImmovable, resolveGesture, commitDrag } from '../lib/drag.js';
import { layoutBlocks } from './CalendarGrid.js';
import { blocks, concepts, taskOf, patternForTask, showToast } from '../stores/index.js';
import { isAllDay } from '../lib/overlay.js';
import { textureStyle } from '../lib/textures.js';
import { pickNextUp, scrollTopForBlock, VISIBLE_HOURS } from '../lib/planner.js';
import { localISODate } from '../lib/dates.js';

/**
 * The PLANNER (Phase G, G6): the hour-by-hour view of TODAY. 8h visible by default,
 * expandable to the full 24h; the **next-up** item is pinned to the second slot and
 * the view auto-scrolls there. Items show **name · tag · start–end**; Time-Blocks
 * render as labelled outlines; pattern instances carry their type texture; chips
 * drag-to-reorder (one tz-safe PATCH); overlaps are **allowed but flagged**.
 *
 * Built on the shared grid math (`grid.ts`), the overlap layout (`layoutBlocks`),
 * and the drag gesture (`drag.ts`) — the same engine the Calendar grid uses — so
 * there is no tz drift between a chip's pixel position and its stored instant.
 */

type Placed = ReturnType<typeof layoutBlocks>[number];

const VISIBLE_PX = VISIBLE_HOURS * 60 * PX_PER_MIN;

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── Time gutter (hour labels) ─────────────────────────────────────────────────
function TimeGutter() {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div class="relative" style={{ height: `${DAY_HEIGHT_PX}px` }}>
      <For each={hours}>
        {(h) => (
          <div
            class="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground font-mono tabular-nums"
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

function HourLines() {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <For each={hours}>
      {(h) => (
        <div class="absolute left-0 right-0 border-t border-border/40" style={{ top: `${yOf(h * 60)}px` }} />
      )}
    </For>
  );
}

// ── Now line: ticks every minute ──────────────────────────────────────────────
function NowLine(props: { day: string; now: string }) {
  const mins = () => minutesIntoDay(props.now, props.day);
  return (
    <div class="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${yOf(mins())}px` }}>
      <div class="h-px bg-ring shadow-[0_0_6px_rgba(88,235,191,.5)]" />
      <div class="absolute -left-1 -top-[3px] w-[7px] h-[7px] rounded-full bg-ring" />
    </div>
  );
}

// ── Plan container outline (a timed Time-Block: ★ solid 3pt) ───────────────────
function ContainerOutline(props: { block: Block; day: string }) {
  const top = () => minutesIntoDay(props.block.start_at, props.day);
  const height = () => Math.max(minutesIntoDay(props.block.end_at, props.day) - top(), 0);
  return (
    <div
      class="absolute left-0.5 right-0.5 z-0 rounded-lg border-[3px] border-primary/70 pointer-events-none"
      style={{ top: `${yOf(top())}px`, height: `${yOf(height())}px` }}
    >
      <span class="absolute -top-2 left-2 px-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground bg-card rounded">
        <Star size={9} class="text-primary" />
        {props.block.title}
        <Show when={props.block.tag}>{(t) => <span class="text-primary">#{t()}</span>}</Show>
      </span>
    </div>
  );
}

// ── Header-lane chip (all-day Plans ★ + goal-day Concepts ⬟) — off the minute axis.
function HeaderChip(props: { block: Block; concept?: boolean }) {
  return (
    <span
      class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] bg-card max-w-[180px]"
      classList={{
        'border-l-2 border-l-primary border border-border': !props.concept,
        'border-2 border-dotted border-muted-foreground': props.concept,
      }}
      title={props.block.title}
    >
      <Show when={props.concept} fallback={<Star size={10} class="text-primary flex-shrink-0" />}>
        <Pentagon size={10} class="text-muted-foreground flex-shrink-0" />
      </Show>
      <span class="text-foreground truncate">{props.block.title}</span>
      <Show when={props.block.tag}>{(t) => <span class="text-primary flex-shrink-0">#{t()}</span>}</Show>
    </span>
  );
}

// ── A draggable planner chip (name · tag · start–end, texture, next-up marker) ──
function PlannerChip(props: { placed: Placed; day: string; isNextUp: boolean }) {
  const b = () => props.placed.block;
  const task = () => taskOf(b().task_id);
  const pat = () => patternForTask(b().task_id);
  const tag = () => task()?.tags?.[0] ?? b().tag ?? undefined;
  const conflict = () => props.placed.cols > 1;
  const done = () => ['completed', 'skipped'].includes(b().status);
  const locked = () => isImmovable(b());

  // Live gesture (visual-only) — a single PATCH fires on pointer-up, like the grid.
  const [drag, setDrag] = createSignal<{ mode: GestureMode; dy: number } | null>(null);
  const liveTop = () => {
    const g = drag();
    if (!g) return props.placed.top;
    const dMin = g.dy / PX_PER_MIN;
    return g.mode === 'resize-bottom' ? props.placed.top : props.placed.top + dMin;
  };
  const liveHeight = () => {
    const g = drag();
    if (!g) return props.placed.height;
    const dMin = g.dy / PX_PER_MIN;
    if (g.mode === 'move') return props.placed.height;
    if (g.mode === 'resize-top') return props.placed.height - dMin;
    return props.placed.height + dMin;
  };
  const heightPx = () => Math.max(yOf(liveHeight()), 18);

  function startGesture(mode: GestureMode, e: PointerEvent) {
    if (locked()) return;
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
      const resolved = resolveGesture(b(), props.day, mode, dy);
      void commitDrag(b(), resolved, { onError: (m) => showToast(m, 'error') });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    setDrag({ mode, dy: 0 });
  }

  return (
    <div
      class="absolute z-10 rounded-md overflow-hidden border bg-card text-[11px] leading-tight select-none touch-none transition-shadow"
      classList={{
        'opacity-40': done(),
        'border-l-[3px] border-l-primary border-border': !props.isNextUp,
        'border-l-[3px] border-l-primary border-primary ring-2 ring-primary/70': props.isNextUp,
        'cursor-grab': !locked(),
        'cursor-default': locked(),
        'z-30 cursor-grabbing shadow-lg': !!drag(),
      }}
      style={{
        top: `${yOf(liveTop())}px`,
        height: `${heightPx()}px`,
        left: `${(props.placed.col / props.placed.cols) * 100}%`,
        width: `calc(${100 / props.placed.cols}% - 3px)`,
      }}
      title={`${b().title}${tag() ? ` · #${tag()}` : ''} · ${fmtTime(b().start_at)}–${fmtTime(b().end_at)}`}
      onPointerDown={(e) => startGesture('move', e)}
    >
      {/* Pattern texture (type shape + tag-seeded variation) — a low-contrast whisper. */}
      <Show when={pat()}>
        {(p) => <div style={textureStyle(p().type?.icon_shape, p().pattern.tag ?? tag() ?? null)} />}
      </Show>

      <Show when={!locked()}>
        <div class="absolute top-0 left-0 right-0 z-10 cursor-ns-resize" style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(e) => startGesture('resize-top', e)} />
      </Show>

      <div class="relative px-1.5 py-0.5">
        <div class="flex items-center gap-1 font-medium text-foreground truncate">
          <Show when={props.isNextUp}><Play size={9} class="text-primary flex-shrink-0 fill-primary" /></Show>
          <Show when={b().is_locked}><Lock size={9} class="text-muted-foreground flex-shrink-0" /></Show>
          <span class="truncate">{b().title}</span>
          <Show when={conflict()}>
            <AlertTriangle size={10} class="text-destructive flex-shrink-0 ml-auto" />
          </Show>
        </div>
        <Show when={heightPx() >= 30}>
          <div class="flex items-center gap-1.5 text-muted-foreground truncate">
            <Show when={tag()}>{(t) => <span class="text-primary truncate">#{t()}</span>}</Show>
            <span class="tabular-nums">{fmtTime(b().start_at)}–{fmtTime(b().end_at)}</span>
          </div>
        </Show>
      </div>

      <Show when={!locked()}>
        <div class="absolute bottom-0 left-0 right-0 z-10 cursor-ns-resize" style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(e) => startGesture('resize-bottom', e)} />
      </Show>
    </div>
  );
}

export function Planner() {
  const day = () => localISODate();
  const [expanded, setExpanded] = createSignal(false);

  // A minute ticker so "next up" (and the now line) advance over the day.
  const [nowISO, setNowISO] = createSignal(new Date().toISOString());
  const tick = setInterval(() => setNowISO(new Date().toISOString()), 60_000);
  onCleanup(() => clearInterval(tick));

  // Concepts live off the minute grid (the header lane + horizon), never on it.
  const dayBlocks = () => (blocks() ?? []).filter((b) => b.block_type !== 'concept');
  // Plan containers on the timed grid (★ outline); all-day ones go to the header lane.
  const containers = () => dayBlocks().filter((b) => b.block_kind === 'timeblock' && !isAllDay(b));
  // Task/meeting/focus chips share the overlap layout; containers + break/buffer + all-day don't.
  const chips = () => dayBlocks().filter((b) => !['timeblock', 'break', 'buffer'].includes(b.block_kind) && !isAllDay(b));
  const placed = createMemo(() => layoutBlocks(chips(), day()));
  const nextUp = createMemo(() => pickNextUp(chips(), nowISO()));

  // Header lane (off the minute axis): all-day Plans/events ★ + today's Concepts ⬟.
  const allDayPlans = () => dayBlocks().filter(isAllDay);
  const todayConcepts = () => (concepts() ?? []).filter((c) => c.goal_start_date === day());
  const hasHeaderLane = () => allDayPlans().length > 0 || todayConcepts().length > 0;

  let scroller: HTMLDivElement | undefined;
  const repin = () => {
    if (!scroller || expanded()) return;
    scroller.scrollTop = scrollTopForBlock(nextUp(), day());
  };
  onMount(repin);
  // Re-pin whenever the next-up item or the expand state changes.
  createEffect(() => { nextUp(); expanded(); queueMicrotask(repin); });

  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
      {/* Header — region label + the 8h⇄24h expand control */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Planner</span>
          <span class="text-[10px] text-muted-foreground">{expanded() ? '24h' : '8h · scroll for more'}</span>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={expanded() ? 'Collapse to 8 hours' : 'Expand to 24 hours'}
        >
          <Show when={expanded()} fallback={<><Maximize2 size={12} /> Expand 24h</>}>
            <Minimize2 size={12} /> Collapse
          </Show>
        </button>
      </div>

      {/* Header lane — all-day Plans + Concepts whose goal day is today (off the grid). */}
      <Show when={hasHeaderLane()}>
        <div class="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-border bg-card/60 flex-shrink-0">
          <span class="text-[9px] uppercase tracking-wide text-muted-foreground mr-0.5">all-day</span>
          <For each={allDayPlans()}>{(b) => <HeaderChip block={b} />}</For>
          <For each={todayConcepts()}>{(c) => <HeaderChip block={c} concept />}</For>
        </div>
      </Show>

      {/* Windowed scroller: 8h tall by default, full 24h when expanded. */}
      <div
        ref={scroller}
        class="overflow-y-auto overflow-x-hidden relative"
        style={{ height: `${expanded() ? DAY_HEIGHT_PX : VISIBLE_PX}px` }}
      >
        <div class="grid" style={{ 'grid-template-columns': '3.5rem 1fr' }}>
          <TimeGutter />
          <div class="relative border-l border-border/60" style={{ height: `${DAY_HEIGHT_PX}px` }}>
            <HourLines />
            <For each={containers()}>{(c) => <ContainerOutline block={c} day={day()} />}</For>
            <For each={placed()}>
              {(p) => <PlannerChip placed={p} day={day()} isNextUp={p.block.id === nextUp()?.id} />}
            </For>
            <NowLine day={day()} now={nowISO()} />
            <Show when={chips().length === 0 && containers().length === 0}>
              <div class="absolute left-0 right-0 top-24 text-center text-sm text-muted-foreground px-4">
                Nothing planned yet — stage items in the flight-plan, then hit
                <span class="text-primary font-medium"> Auto Schedule</span>, or drag one onto the grid.
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
