import { For, Show, createMemo, createSignal, createResource, onCleanup } from 'solid-js';
import { Lock, AlertTriangle, Play, Star, Pentagon, Pencil, Trash2, Repeat, Check, CheckCircle2, ArrowUpRight, Eraser, X, ListChecks, ChevronRight, ChevronDown } from 'lucide-solid';
import { api, type Block } from '../lib/api.js';
import { PX_PER_MIN, MINUTES_PER_DAY, SNAP_MIN, minutesIntoDay } from '../lib/grid.js';
import {
  type AxisState,
  segments,
  axisHeightPx,
  yOf as axisYOf,
  minAt as axisMinAt,
  visibleExtent,
  TOP_COLLAPSE_END,
  BOTTOM_COLLAPSE_START,
} from '../lib/day-axis.js';
import { HANDLE_PX, type GestureMode, type Neighbour, isImmovable, resolveGesture, commitDrag, clampLiveDelta } from '../lib/drag.js';
import { resolveGroup, containerAt, clampGroupDelta } from '../lib/group-move.js';
import { spanAtY } from '../lib/place.js';
import { snapToSlot, minuteToHHMM, isSlotOccupied } from '../lib/create-click.js';
import { useDropZone } from '../lib/draggable.js';
import { isSelected, toggleSelection, setActiveTask, setActiveBlock, selection, setRoutineModal } from '../stores/selection.js';
import { layoutBlocks } from './CalendarGrid.js';
import { blocks, concepts, flightPlan, taskOf, patternForTask, setElementModal, refetchBlocks, refetchFlightPlan, refetchConcepts, showToast, selectedDay, tags, categoryPrefs, patternPrefs, patternBlocks, tasks, plannerAxisState, togglePlannerTop, togglePlannerBottom } from '../stores/index.js';
import { isAllDay } from '../lib/overlay.js';
import { textureStyle, blockColorVar, doneHatchStyle } from '../lib/textures.js';
import { displayTag } from '../lib/tag-tax.js';
import { pickNextUp, segmentExtentPx, dragDeltaMin } from '../lib/planner.js';
import { computeBands, type Band } from '../lib/day-windows.js';
import { localISODate } from '../lib/dates.js';
import { PatternBlockOverlay } from './PatternBlockOverlay.js';
import { DirectionColumn } from './DirectionColumn.js';
import { PlannerEntityCard } from './PlannerEntityCard.js';

/** Open the unified Element wizard to edit a Time Block. */
function editTimeBlock(id: string) {
  setElementModal({ open: true, mode: 'edit', kind: 'timeblock', editTarget: { kind: 'timeblock', id } });
}

/** A block's grouping chip label: its #tag, else its Time Block Category name (0069). */
function blockTagLabel(block: { tag?: string | null; category_id?: string | null }): string | undefined {
  if (block.tag) return `#${block.tag}`;
  if (block.category_id) {
    const c = (tags() ?? []).find((t) => t.id === block.category_id);
    if (c) return displayTag(c.name);
  }
  return undefined;
}

/**
 * The PLANNER (Phase G, G6): the hour-by-hour view of TODAY. The WHOLE day renders
 * at natural height on the **segmented day axis** (`day-axis.ts`) — the quiet night
 * hours (00:00–07:00 and 21:00–24:00) collapse to thin, expandable bars by default,
 * so every hour is reachable with no inner scroll and no zoom control. (This
 * replaced the old fixed 4/8/16h clipped zoom window, which left the hours outside
 * the window unreachable.) Items show **name · tag · start–end**; Time-Blocks render
 * as labelled outlines; pattern instances carry their type texture; chips
 * drag-to-reorder (one tz-safe PATCH); overlaps are **allowed but flagged**.
 *
 * Plan-as-container (PR-C): a Plan + the task blocks scheduled into it move together.
 * Dragging the Plan — or any member — shifts the whole group by one minute delta
 * (atomic `move-group`); members render nested under their Plan; Alt-dragging a
 * member detaches just it; dropping a loose chip into a Plan's window attaches it.
 *
 * Write-capable (CON-5): clicking an empty slot creates a Time Block at that time,
 * and a flight-plan task dragged onto the grid is scheduled there (drop-Y → time via
 * the segmented `minAt` inverse, then snap), then `api.blocks.create` + `flightPlan.remove`;
 * a drop inside a Plan's window attaches via `parent_block_id`. Authoring is no longer
 * wizard-only.
 *
 * Built on the pure segmented axis (`day-axis.ts`), the tz-safe minute math
 * (`grid.ts`), the overlap layout (`layoutBlocks`), the drag gesture (`drag.ts`),
 * the pure group math (`group-move.ts`), and the shared pointer-DnD (`draggable.ts`).
 * The one seam the collapsible axis adds is that pixel↔minute is piecewise: block/
 * card/band placement routes through `segmentExtentPx`, and drag pixel deltas convert
 * to minutes via `dragDeltaMin` (position-based) so a drag across a collapsed bar
 * still maps sanely.
 */

type Placed = ReturnType<typeof layoutBlocks>[number];

/** Width (px) of a Time-Block's solid category label cell — the left edge of its
 * container box. Child task chips render in the task region to the right of it. */
const CAT_WIDTH_PX = 104;
/** Gutter (px) kept to the right of each chip so neighbours don't touch. */
const CHIP_GAP_PX = 3;
/** Default duration (minutes) for click-to-create / drag-to-schedule when no estimate. */
const DEFAULT_BLOCK_MIN = 60;

/** Inline left/width for a chip, framed either inside a Time-Block's task region
 * (offset past the category cell) or across the full width when it's a loose task.
 * `col`/`cols` are the chip's slot within its overlap cluster. */
function chipFrame(col: number, cols: number, nested: boolean): { left: string; width: string } {
  if (nested) {
    // Task region = everything right of the category cell, split into overlap columns.
    const region = `(100% - ${CAT_WIDTH_PX}px)`;
    return {
      left: `calc(${CAT_WIDTH_PX}px + ${col / cols} * ${region})`,
      width: `calc(${region} / ${cols} - ${CHIP_GAP_PX}px)`,
    };
  }
  // Loose task: tile across the full width (it never shares a row with a Time-Block).
  return {
    left: `calc(${(col / cols) * 100}%)`,
    width: `calc(${100 / cols}% - ${CHIP_GAP_PX}px)`,
  };
}

/**
 * The blocks a dragged/resized block must not overlap, reduced to day-minute extents
 * for the collision clamp. Scoping by kind:
 *  - a Time-Block container clamps against every other timed block EXCEPT its own
 *    children (they ride along on a group move);
 *  - a nested chip clamps against its siblings in the same container only (it moves
 *    freely within its Plan; the container is its home, not an obstacle);
 *  - a loose chip clamps against other top-level non-container blocks — Plan
 *    containers are attach-on-drop targets, never walls.
 */
function neighboursFor(b: Block, day: string, all: Block[]): Neighbour[] {
  const timed = all.filter((x) => !isAllDay(x) && x.block_type !== 'someday');
  const toMin = (x: Block): Neighbour => ({ topMin: minutesIntoDay(x.start_at, day), botMin: minutesIntoDay(x.end_at, day) });
  // Only blocks intersecting THIS day are obstacles — a range fetch can include an
  // adjacent-day row, which maps to negative / >MINUTES_PER_DAY minutes and would
  // otherwise be a phantom wall near midnight (matches clampGroupDelta's filter).
  const inDay = (n: Neighbour) => n.botMin > 0 && n.topMin < MINUTES_PER_DAY;
  let candidates: Block[];
  if (b.block_kind === 'timeblock') {
    candidates = timed.filter((x) => x.id !== b.id && x.parent_block_id !== b.id);
  } else if (b.parent_block_id != null) {
    candidates = timed.filter((x) => x.id !== b.id && x.parent_block_id === b.parent_block_id);
  } else {
    candidates = timed.filter((x) => x.id !== b.id && x.block_kind !== 'timeblock' && x.parent_block_id == null);
  }
  return candidates.map(toMin).filter(inDay);
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ── Shared block interaction: drag/resize gesture + a click→options popover ─────
// A move gesture under this pixel threshold is treated as a click (opens the menu).
// 8 px absorbs normal trackpad/touch tremor without masking intentional drags.
const CLICK_PX = 8;

/**
 * Drag/resize state + a pointer handler. `onClick` fires for a near-zero move.
 *
 * The block's live top/height are tracked as a **minute delta** (`dMin`), not a
 * pixel delta: the segmented axis is not to scale across a collapsed bar, so the
 * gesture derives its minute delta from pointer *positions* via `dragDeltaMin`
 * (`state`/`gridY` supplied by the caller). Downstream drag math (snap, collision
 * clamp, group move) is already minute-space, so it is unchanged — only the px→min
 * hop at the pointer seam differs from the old linear grid.
 *
 * A 'move' gesture can be owned by the caller for group-aware behavior: `onMoveLive`
 * fires on every pointermove (live group ghost), `onMoveEnd` on pointerup (clear the
 * ghost), and `onMoveCommit` replaces the default single-block PATCH. Resize always
 * uses the default `resolveGesture` + `commitDrag` path.
 */
function useBlockDrag(opts: {
  block: () => Block; day: string; locked: () => boolean;
  baseTop: () => number; baseHeight: () => number;
  state: () => AxisState;
  /** grid-relative Y (px) for a clientY — the origin for segmented delta math. */
  gridY: (clientY: number) => number;
  onClick: (x: number, y: number) => void;
  onMoveLive?: (dMin: number, ev: PointerEvent) => void;
  onMoveEnd?: () => void;
  onMoveCommit?: (dMin: number, ev: PointerEvent) => void;
  neighbours?: () => Neighbour[];
  clampLiveDMin?: (mode: GestureMode, dMin: number, ev: PointerEvent) => number;
}) {
  // The live gesture carries a MINUTE delta (already position-derived + clamped).
  const [drag, setDrag] = createSignal<{ mode: GestureMode; dMin: number } | null>(null);
  const liveTop = () => {
    const g = drag();
    if (!g) return opts.baseTop();
    return g.mode === 'resize-bottom' ? opts.baseTop() : opts.baseTop() + g.dMin;
  };
  const liveHeight = () => {
    const g = drag();
    if (!g) return opts.baseHeight();
    if (g.mode === 'move') return opts.baseHeight();
    if (g.mode === 'resize-top') return opts.baseHeight() - g.dMin;
    return opts.baseHeight() + g.dMin;
  };
  function startGesture(mode: GestureMode, e: PointerEvent) {
    // Do NOT bail early for locked blocks — click detection must still work so the
    // entity card can open. Locking only suppresses drag state and commits.
    e.preventDefault();
    e.stopPropagation();
    const startClientY = e.clientY;
    const startGridY = opts.gridY(startClientY); // origin for the segmented inverse
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    // Convert a raw pixel delta to a segmented minute delta from the gesture origin.
    const toDMin = (rawPx: number) => dragDeltaMin(startGridY, rawPx, opts.state(), PX_PER_MIN);
    const onMove = (ev: PointerEvent) => {
      if (opts.locked()) return; // no drag visual for locked blocks
      const rawDMin = toDMin(ev.clientY - startClientY);
      // Live preview is collision-clamped so the chip/group visibly stops at the wall
      // while dragging; the pointer-up commit still snaps+clamps via resolveGesture.
      const dMin = opts.clampLiveDMin ? opts.clampLiveDMin(mode, rawDMin, ev) : rawDMin;
      setDrag({ mode, dMin });
      if (mode === 'move') opts.onMoveLive?.(dMin, ev);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture?.(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const rawPx = ev.clientY - startClientY; // RAW pixel delta: click detection
      const dMin = toDMin(rawPx);              // segmented minute delta: commit (clamps itself)
      if (!opts.locked()) { setDrag(null); if (mode === 'move') opts.onMoveEnd?.(); }
      if (mode === 'move' && Math.abs(rawPx) < CLICK_PX) { opts.onClick(ev.clientX, ev.clientY); return; }
      if (opts.locked()) return; // no drag commit for locked blocks
      if (mode === 'move' && opts.onMoveCommit) { opts.onMoveCommit(dMin, ev); return; }
      // Resize (and any non-grouped move): clamp against neighbours so an edge can't
      // be dragged into an adjacent block. `resolveGesture` reads a px delta and snaps
      // via minsOf; feeding `dMin * PX_PER_MIN` makes minsOf recover exactly `dMin`.
      const resolved = resolveGesture(opts.block(), opts.day, mode, dMin * PX_PER_MIN, opts.neighbours?.() ?? []);
      void commitDrag(opts.block(), resolved, { onError: (m) => showToast(m, 'error') });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    if (!opts.locked()) setDrag({ mode, dMin: 0 }); // only show drag state for unlocked blocks
  }
  return { drag, liveTop, liveHeight, startGesture };
}

// ── Time gutter (hour labels) ─────────────────────────────────────────────────
// Only hours in an EXPANDED region (plus the boundary hours 07:00 / 21:00, which sit
// on an expanded edge) draw a label; a collapsed region shows only its expander bar.
function visibleHours(state: AxisState): number[] {
  return Array.from({ length: 24 }, (_, h) => h).filter((h) => {
    const m = h * 60;
    if (m === TOP_COLLAPSE_END || m === BOTTOM_COLLAPSE_START) return true;
    return visibleExtent(m, m + 1, state) !== null;
  });
}

function TimeGutter(props: { state: () => AxisState }) {
  return (
    <div class="relative" style={{ height: `${axisHeightPx(props.state(), PX_PER_MIN)}px` }}>
      <For each={visibleHours(props.state())}>
        {(h) => (
          <div
            class="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground font-mono tabular-nums"
            style={{ top: `${axisYOf(h * 60, props.state(), PX_PER_MIN)}px` }}
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

function HourLines(props: { state: () => AxisState }) {
  return (
    <For each={visibleHours(props.state())}>
      {(h) => (
        <div class="absolute left-0 right-0 border-t border-border/40" style={{ top: `${axisYOf(h * 60, props.state(), PX_PER_MIN)}px` }} />
      )}
    </For>
  );
}

// ── Now line: ticks every minute; hidden when "now" is inside a collapsed region ──
function NowLine(props: { day: string; now: string; state: () => AxisState }) {
  const mins = () => minutesIntoDay(props.now, props.day);
  // Only visible when "now" lands on an expanded portion of the axis.
  const visible = () => {
    const m = mins();
    if (m < 0 || m > MINUTES_PER_DAY) return false;
    return visibleExtent(m, m + 1, props.state()) !== null;
  };
  return (
    <Show when={visible()}>
      <div class="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${axisYOf(mins(), props.state(), PX_PER_MIN)}px` }}>
        <div class="h-px bg-ring shadow-[0_0_6px_rgba(88,235,191,.5)]" />
        <div class="absolute -left-1 -top-[3px] w-[7px] h-[7px] rounded-full bg-ring" />
      </div>
    </Show>
  );
}

// ── Expander bar for a collapsed/expanded night region ────────────────────────
// A thin clickable bar per collapsible region. Collapsed → "▸ label" (fills its thin
// segment); expanded → "▾" (a slim strip at the region's top edge so it never eats
// the revealed hours). Positioned via the segment's own top/height. Spans the grid
// column only (left of it are the gutter + direction lane).
function ExpanderBar(props: { region: 'top' | 'bottom'; label: string; state: () => AxisState; onToggle: () => void }) {
  const seg = () => {
    const segs = segments(props.state(), PX_PER_MIN);
    return props.region === 'top' ? segs[0] : segs[2];
  };
  const expanded = () => (props.region === 'top' ? props.state().topExpanded : props.state().bottomExpanded);
  return (
    <button
      type="button"
      aria-expanded={expanded()}
      title={expanded() ? `Collapse ${props.label}` : `Expand ${props.label}`}
      class="absolute left-0 right-0 z-30 flex items-center gap-1 px-1.5 text-[10px] text-muted-foreground bg-card/95 hover:bg-muted/60 border-y border-border/60 transition-colors overflow-hidden"
      style={{ top: `${seg().topPx}px`, height: expanded() ? '16px' : `${seg().heightPx}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
    >
      <Show when={expanded()} fallback={<ChevronRight size={11} class="flex-shrink-0" />}>
        <ChevronDown size={11} class="flex-shrink-0" />
      </Show>
      <span class="truncate">{props.label}</span>
    </button>
  );
}

/** Handlers the Plan-as-container gestures need from the Planner (group ghost + commits).
 * Deltas are MINUTE deltas (segmented-axis native), not pixels. */
interface GroupCtx {
  extraMin: (id: string) => number;                              // optimistic group-ghost offset (minutes)
  onMoveLive: (anchor: Block, dMin: number, ev: PointerEvent) => void;
  onMoveEnd: () => void;
  onMoveCommit: (anchor: Block, dMin: number, ev: PointerEvent) => void;
}

// ── Plan container outline (a timed Time-Block: ★ solid 3pt) — interactive ─────
function ContainerOutline(props: { block: Block; day: string; state: () => AxisState; gridY: (y: number) => number; group: GroupCtx; onDelete: (b: Block) => void }) {
  const b = () => props.block;
  const baseTop = () => minutesIntoDay(b().start_at, props.day);
  const baseHeight = () => Math.max(minutesIntoDay(b().end_at, props.day) - baseTop(), 0);
  const locked = () => isImmovable(b());
  const { drag, liveTop, liveHeight, startGesture } = useBlockDrag({
    // Click (a near-zero drag) on the label expands the Time-Block into the entity card.
    block: b, day: props.day, locked, baseTop, baseHeight, state: props.state, gridY: props.gridY,
    onClick: () => setActiveBlock(b().id),
    onMoveLive: (dMin, ev) => props.group.onMoveLive(b(), dMin, ev),
    onMoveEnd: () => props.group.onMoveEnd(),
    onMoveCommit: (dMin, ev) => props.group.onMoveCommit(b(), dMin, ev),
    neighbours: () => neighboursFor(b(), props.day, blocks() ?? []),
    clampLiveDMin: (mode, dMin, ev) => clampLiveDMinFor(b(), props.day, blocks() ?? [], mode, dMin, ev),
  });
  const topMin = () => liveTop() + props.group.extraMin(b().id);
  // Project the live [top, top+height) extent onto the segmented axis. Null → the
  // block sits wholly inside a collapsed region (hidden until expanded).
  const ext = () => segmentExtentPx(topMin(), topMin() + liveHeight(), props.state(), PX_PER_MIN);

  // 0069: the Time-Block category colour — stamped category colour wins, else the tag
  // hash (the same helper the chips use), so the column matches the rest of the planner.
  const fill = () => blockColorVar(b(), categoryPrefs()?.prefs);
  return (
    <Show when={ext()}>
      {(e) => (
    <div
      class="absolute left-0.5 right-0.5 rounded-lg border-2 select-none touch-none pointer-events-none"
      classList={{ 'z-0': !drag(), 'z-[25] shadow-lg': !!drag() }}
      style={{ top: `${e().topPx}px`, height: `${Math.max(e().heightPx, 24)}px`, 'border-color': fill() }}
      title={`${b().title} · Time Block — drag the label to move the whole group`}
    >
      {/* Solid category label cell (left) — name + secondary tags, white text. It IS
          the drag handle: dragging it moves the Time Block + its tasks as a group.
          The × button provides one-tap delete without needing to open the entity card. */}
      <div
        class="group/label absolute top-0 bottom-0 left-0 rounded-l-md overflow-hidden px-2 py-1 flex flex-col gap-0.5 pointer-events-auto"
        classList={{ 'cursor-grab': !locked(), 'cursor-default': locked() }}
        style={{ width: `${CAT_WIDTH_PX}px`, 'background-color': fill(), color: `color-mix(in oklch, ${fill()} 30%, black)` }}
        onPointerDown={(ev) => startGesture('move', ev)}
      >
        <div class="flex items-start gap-1 text-[11px] font-medium leading-tight">
          <Star size={9} class="flex-shrink-0 mt-0.5" />
          <span class="break-words min-w-0 flex-1">{b().title}</span>
          <button
            type="button"
            title="Remove Time Block"
            class="flex-shrink-0 opacity-0 group-hover/label:opacity-70 hover:!opacity-100 transition-opacity ml-0.5 -mr-0.5 -mt-0.5 rounded"
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => { ev.stopPropagation(); props.onDelete(b()); }}
          ><X size={10} /></button>
        </div>
        <Show when={e().heightPx >= 34}>
          <div class="flex flex-wrap items-center gap-x-1 text-[10px] leading-none opacity-90">
            {/* 0069: the grouping label is the #tag OR the Time Block Category name. */}
            <Show when={blockTagLabel(b())}>{(lbl) => <span class="truncate">{lbl()}</span>}</Show>
            <For each={b().secondary_tags ?? []}>{(s) => <span class="truncate">#{s}</span>}</For>
          </div>
        </Show>
      </div>
      {/* Resize handles live in the task region (right of the label) so they don't
          fight the label's move-drag. */}
      <Show when={!locked()}>
        <div class="absolute top-0 z-10 cursor-ns-resize pointer-events-auto" style={{ left: `${CAT_WIDTH_PX}px`, right: '0', height: `${HANDLE_PX}px` }} onPointerDown={(ev) => startGesture('resize-top', ev)} />
        <div class="absolute bottom-0 z-10 cursor-ns-resize pointer-events-auto" style={{ left: `${CAT_WIDTH_PX}px`, right: '0', height: `${HANDLE_PX}px` }} onPointerDown={(ev) => startGesture('resize-bottom', ev)} />
      </Show>
    </div>
      )}
    </Show>
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
      <Show when={blockTagLabel(props.block)}>{(lbl) => <span class="text-primary flex-shrink-0">{lbl()}</span>}</Show>
    </span>
  );
}

// ── A draggable planner chip (name · tag · start–end, texture, next-up marker) ──
function PlannerChip(props: { placed: Placed; day: string; state: () => AxisState; gridY: (y: number) => number; isNextUp: boolean; nested: boolean; updateMode: boolean; group: GroupCtx }) {
  const b = () => props.placed.block;
  const task = () => taskOf(b().task_id);
  // Linked subtasks of this chip's task (excludes thrown-away). Drives the count badge.
  const subCount = () => { const t = task(); return t ? (tasks() ?? []).filter((x) => x.parent_id === t.id && x.status !== 'cancelled').length : 0; };
  const pat = () => patternForTask(b().task_id);
  const tag = () => task()?.tags?.[0] ?? b().tag ?? undefined;
  // 0069: a block's colour — stamped category colour wins, else the tag hash (forward-only).
  const color = () => blockColorVar(b(), categoryPrefs()?.prefs);
  const conflict = () => props.placed.cols > 1;
  const done = () => ['completed', 'skipped'].includes(b().status);
  const completed = () => b().status === 'completed';
  const locked = () => isImmovable(b());

  // Quick-complete (Update mode): a tap toggles done. The completed chip wears a
  // tag-coloured diagonal hatch + a one-shot glow (set on the act of completing).
  const [glow, setGlow] = createSignal(false);
  async function setDone(next: boolean) {
    const blk = b();
    try {
      // One PATCH: the server mirrors a task-linked block's done-state onto the task
      // (and emits task:updated), so there's no non-atomic client dual write.
      await api.blocks.update(blk.id, { status: next ? 'completed' : 'planned' });
      if (next) setGlow(true);
      refetchBlocks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Drag/resize via the shared hook; a click (near-zero drag) expands the entity into
  // the card — a task chip focuses its task, a non-task block focuses the block.
  const { drag, liveTop, liveHeight, startGesture } = useBlockDrag({
    block: b, day: props.day, locked, state: props.state, gridY: props.gridY,
    baseTop: () => props.placed.top, baseHeight: () => props.placed.height,
    onClick: () => { const tid = b().task_id; if (tid != null) setActiveTask(tid); else setActiveBlock(b().id); },
    onMoveLive: (dMin, ev) => props.group.onMoveLive(b(), dMin, ev),
    onMoveEnd: () => props.group.onMoveEnd(),
    onMoveCommit: (dMin, ev) => props.group.onMoveCommit(b(), dMin, ev),
    neighbours: () => neighboursFor(b(), props.day, blocks() ?? []),
    clampLiveDMin: (mode, dMin, ev) => clampLiveDMinFor(b(), props.day, blocks() ?? [], mode, dMin, ev),
  });
  const topMin = () => liveTop() + props.group.extraMin(b().id);
  // Project onto the segmented axis; null → wholly inside a collapsed region (hidden).
  const ext = () => segmentExtentPx(topMin(), topMin() + liveHeight(), props.state(), PX_PER_MIN);
  // Nested chips sit in their Time-Block's task region (right of the category cell);
  // loose chips tile across the full width.
  const frame = () => chipFrame(props.placed.col, props.placed.cols, props.nested);

  const selectedBlock = () => isSelected({ kind: 'block', id: b().id });
  return (
    <Show when={ext()}>
      {(e) => (
    <div
      class="absolute z-10 rounded-md overflow-hidden border bg-card text-[11px] leading-tight select-none touch-none transition-shadow"
      classList={{
        'opacity-40': b().status === 'skipped',
        'opacity-70': completed(),
        'anim-done-glow': glow(),
        'border-l-[3px] border-l-primary border-border': !props.isNextUp,
        'border-l-[3px] border-l-primary border-primary ring-2 ring-primary/70': props.isNextUp,
        'cursor-grab': !locked() && !props.updateMode,
        'cursor-pointer': props.updateMode,
        'cursor-default': locked() && !props.updateMode,
        'z-30 cursor-grabbing shadow-lg': !!drag(),
        'ring-2 ring-chart-1 ring-offset-1 ring-offset-card': selectedBlock(),
      }}
      style={{
        top: `${e().topPx}px`,
        height: `${Math.max(e().heightPx, 18)}px`,
        left: frame().left,
        width: frame().width,
        ...(completed() ? doneHatchStyle(tag()) : {}),
        ...(glow() ? { '--done-glow': `color-mix(in srgb, ${color()} 55%, transparent)` } : {}),
      }}
      title={`${b().title}${tag() ? ` · #${tag()}` : ''} · ${fmtTime(b().start_at)}–${fmtTime(b().end_at)}${props.nested ? ' · in a Plan (drag moves the group; Alt-drag to pull out)' : ''}`}
      onAnimationEnd={() => setGlow(false)}
      onPointerDown={(ev) => {
        if (props.updateMode) return; // Update mode: a tap toggles done (onClick) — no drag.
        // Cmd/Ctrl-click toggles multi-select (Phase F) — don't start a drag.
        if ((ev.metaKey || ev.ctrlKey) && b().task_id != null) {
          ev.preventDefault(); ev.stopPropagation();
          toggleSelection({ kind: 'block', id: b().id });
          return;
        }
        startGesture('move', ev);
      }}
      onClick={() => {
        if (props.updateMode) { void setDone(!completed()); return; }
        // Locked chips don't drag, so the click lands here: expand the entity card.
        if (locked()) { const tid = b().task_id; if (tid != null) setActiveTask(tid); else setActiveBlock(b().id); }
      }}
    >
      {/* Pattern texture (type shape + tag-seeded variation) — a low-contrast whisper. */}
      <Show when={pat()}>
        {(p) => <div style={textureStyle(p().type?.icon_shape, p().pattern.tag ?? tag() ?? null)} />}
      </Show>

      {/* Update-mode checkbox (top-left) — the explicit affordance; tapping the
          chip body anywhere toggles too. */}
      <Show when={props.updateMode}>
        <button
          class="absolute top-1 left-1 z-20 w-4 h-4 rounded-[4px] border flex items-center justify-center"
          classList={{ 'bg-card border-muted-foreground': !completed(), 'border-transparent': completed() }}
          style={completed() ? { background: color() } : {}}
          title={completed() ? 'Mark not done' : 'Mark done'}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => { ev.stopPropagation(); void setDone(!completed()); }}
        >
          <Show when={completed()}><Check size={11} class="text-background" /></Show>
        </button>
      </Show>

      <Show when={!locked() && !props.updateMode}>
        <div class="absolute top-0 left-0 right-0 z-10 cursor-ns-resize" style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(ev) => startGesture('resize-top', ev)} />
      </Show>

      <div class="relative px-1.5 py-0.5" classList={{ 'pl-6': props.updateMode }}>
        <div class="flex items-center gap-1 font-medium text-foreground truncate">
          <Show when={props.isNextUp}><Play size={9} class="text-primary flex-shrink-0 fill-primary" /></Show>
          <Show when={b().is_locked}><Lock size={9} class="text-muted-foreground flex-shrink-0" /></Show>
          <Show when={props.nested}><Star size={8} class="text-primary/60 flex-shrink-0" /></Show>
          <span class="truncate">{b().title}</span>
          <Show when={subCount() > 0}>
            <span class="flex-shrink-0 inline-flex items-center gap-0.5 text-[9px] text-muted-foreground" title={`${subCount()} subtask${subCount() === 1 ? '' : 's'}`}>
              <ListChecks size={9} /> {subCount()}
            </span>
          </Show>
          <Show when={conflict()}>
            <AlertTriangle size={10} class="text-destructive flex-shrink-0 ml-auto" />
          </Show>
        </div>
        <Show when={e().heightPx >= 30}>
          <div class="flex items-center gap-1.5 text-muted-foreground truncate">
            <Show when={tag()}>{(t) => <span class="text-primary truncate">#{t()}</span>}</Show>
            <span class="tabular-nums">{fmtTime(b().start_at)}–{fmtTime(b().end_at)}</span>
          </div>
        </Show>
      </div>

      <Show when={!locked() && !props.updateMode}>
        <div class="absolute bottom-0 left-0 right-0 z-10 cursor-ns-resize" style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(ev) => startGesture('resize-bottom', ev)} />
      </Show>

    </div>
      )}
    </Show>
  );
}

// ── Delete-a-Plan confirm: keep the member tasks (detach) or remove them too ────
function DeletePlanDialog(props: { plan: Block; childCount: number; onClose: () => void }) {
  async function run(children: boolean) {
    try {
      await api.blocks.delete(props.plan.id, children ? { children: 'delete' } : undefined);
      refetchBlocks();
      showToast(children ? 'Plan and its tasks removed' : 'Plan removed — tasks kept', 'default');
      props.onClose();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div class="px-4 py-3 border-b border-border">
          <span class="text-sm font-semibold text-foreground">Remove "{props.plan.title}"?</span>
        </div>
        <div class="p-4 flex flex-col gap-3">
          <p class="text-xs text-muted-foreground">
            This Plan contains {props.childCount} task{props.childCount === 1 ? '' : 's'}. Keep them on the day as
            loose blocks, or remove them along with the Plan?
          </p>
          <div class="flex flex-col gap-2">
            <button onClick={() => run(false)} class="btn-primary text-sm px-4 py-1.5 justify-center">Keep tasks</button>
            <button onClick={() => run(true)} class="btn-ghost text-sm px-4 py-1.5 justify-center text-destructive">Remove tasks too</button>
            <button onClick={props.onClose} class="btn-ghost text-sm px-4 py-1.5 justify-center">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The clamped MINUTE delta for a live drag preview — so the block (or whole group)
 * visibly stops at a neighbour's edge while dragging, not just on release. Mirrors the
 * commit's clamp scoping: a group move clamps by the group hull; a loose move / any
 * resize clamps per-edge against `neighboursFor`. Alt-drag (detach) clamps as a loose
 * block, matching the commit path. Input + output are already minute deltas (the
 * segmented px→min conversion happened at the pointer seam).
 */
function clampLiveDMinFor(b: Block, day: string, all: Block[], mode: GestureMode, dMin: number, ev: PointerEvent): number {
  const altDetach = mode === 'move' && b.parent_block_id != null && ev.altKey;
  if (mode === 'move' && !altDetach && (b.block_kind === 'timeblock' || b.parent_block_id != null)) {
    return clampGroupDelta(resolveGroup(all, b.id), all, day, dMin);
  }
  const n = altDetach ? neighboursFor({ ...b, parent_block_id: null }, day, all) : neighboursFor(b, day, all);
  return clampLiveDelta(b, day, mode, dMin, n);
}

export function Planner() {
  const day = () => selectedDay();
  // Now-line and next-up are today-relative — gated off other days.
  const isToday = () => day() === localISODate();
  const [updateMode, setUpdateMode] = createSignal(false);
  const [deletePlan, setDeletePlan] = createSignal<{ plan: Block; childCount: number } | null>(null);

  // Segmented day axis: the whole day renders at natural height with the two night
  // regions collapsed to expandable bars by default (both collapsed — matches the
  // calendar); this REPLACED the old 4/8/16h clipped zoom window so no hour is ever
  // unreachable. Collapse state is store-backed (not a local signal) so it hydrates
  // from + persists to view_prefs.planner (cross-device, migration 0111) — mirroring
  // the calendar's collapse persistence.
  const axisState = plannerAxisState;

  // A minute ticker so "next up" (and the now line) advance over the day.
  const [nowISO, setNowISO] = createSignal(new Date().toISOString());
  const tick = setInterval(() => setNowISO(new Date().toISOString()), 60_000);
  onCleanup(() => clearInterval(tick));

  // Concepts live off the minute grid (the header lane + horizon), never on it.
  const dayBlocks = () => (blocks() ?? []).filter((b) => b.block_type !== 'someday');
  // Plan containers on the timed grid (★ outline); all-day ones go to the header lane.
  const containers = () => dayBlocks().filter((b) => b.block_kind === 'timeblock' && !isAllDay(b));
  // Task/meeting/focus chips share the overlap layout; containers + break/buffer + all-day don't.
  const chips = () => dayBlocks().filter((b) => !['timeblock', 'break', 'buffer'].includes(b.block_kind) && !isAllDay(b));
  const nextUp = createMemo(() => pickNextUp(chips(), nowISO()));

  // Day-type availability windows → bands, shared by the Direction column and the
  // background hatch so the two never drift. Re-resolves on day change or any
  // day-type mutation (the patternBlocks store tick).
  const [dayWindows] = createResource(
    () => [day(), patternBlocks()] as const,
    async ([d]) => { const { key } = await api.dayTypes.resolve(d); return (await api.patternBlocks.forDay(key)).windows; },
  );
  // computeBands bakes in the LINEAR px scale (grid.ts yOf); the Planner reprojects
  // each band onto the segmented axis (below), so we only need its minute extents +
  // presentation fields here — top/height are recomputed per band.
  const bands = createMemo(() => computeBands(dayWindows() ?? {}, tags() ?? [], patternPrefs()?.prefs ?? {}));

  // Header lane (off the minute axis): all-day Plans/events ★ + today's Concepts ⬟.
  const allDayPlans = () => dayBlocks().filter(isAllDay);
  const todayConcepts = () => (concepts() ?? []).filter((c) => c.goal_start_date === day());
  const hasHeaderLane = () => allDayPlans().length > 0 || todayConcepts().length > 0;

  // A chip is nested when its Plan is a container currently drawn on the grid.
  const containerIds = createMemo(() => new Set(containers().map((c) => c.id)));
  const isNested = (b: Block) => b.parent_block_id != null && containerIds().has(b.parent_block_id);

  // Placement: loose chips tile across the full width; a container's own task chips
  // lay out (overlap) inside its task region. By the exclusivity rule a loose chip
  // never shares a row with a Time-Block, so the two sets don't visually collide.
  const looseChips = () => chips().filter((c) => !isNested(c));
  const placedLoose = createMemo(() => layoutBlocks(looseChips(), day()));
  const placedChildren = (cid: string) => layoutBlocks(chips().filter((c) => c.parent_block_id === cid), day());

  // ── Grouped movement (PR-C): a live group ghost + the gesture commits ──────────
  // `ghost` offsets every member EXCEPT the one under the pointer (it follows the
  // cursor via its own liveTop) during a drag; on commit it holds the whole group at
  // the snapped delta until the refetch lands, so nothing snaps back. Deltas are
  // MINUTES (segmented-axis native).
  const [ghost, setGhost] = createSignal<{ ids: Set<string>; dMin: number } | null>(null);
  const extraMin = (id: string) => { const g = ghost(); return g && g.ids.has(id) ? g.dMin : 0; };
  const isGroupAnchor = (b: Block) => b.block_kind === 'timeblock' || b.parent_block_id != null;

  function onMoveLive(anchor: Block, dMin: number, ev: PointerEvent) {
    // Alt-detaching a member → only the member moves (no group ghost).
    if (anchor.parent_block_id != null && ev.altKey) { setGhost(null); return; }
    if (!isGroupAnchor(anchor)) return;
    const members = resolveGroup(blocks() ?? [], anchor.id);
    if (members.length <= 1) return;
    setGhost({ ids: new Set(members.filter((m) => m.id !== anchor.id).map((m) => m.id)), dMin });
  }

  async function onMoveCommit(anchor: Block, dMin: number, ev: PointerEvent) {
    // resolveGesture reads a px delta and snaps via minsOf; dMin * PX_PER_MIN makes it
    // recover exactly `dMin` (already segmented-correct from the pointer seam).
    const dyPx = dMin * PX_PER_MIN;
    const deltaMin = Math.round(dMin / SNAP_MIN) * SNAP_MIN; // snapped group delta

    // Member + Alt → detach this one and move it alone. It becomes loose, so clamp it
    // against the loose obstacle set (as if it had no parent).
    if (anchor.parent_block_id != null && ev.altKey) {
      setGhost(null);
      const looseN = neighboursFor({ ...anchor, parent_block_id: null }, day(), blocks() ?? []);
      const resolved = resolveGesture(anchor, day(), 'move', dyPx, looseN);
      if (!resolved) return;
      try { await api.blocks.update(anchor.id, { ...resolved, parent_block_id: null }); refetchBlocks(); showToast('Detached from Time Block', 'default'); }
      catch (err) { showToast((err as Error).message, 'error'); }
      return;
    }

    // Plan container or member (non-Alt) → move the whole group atomically, clamped so
    // the group never overlaps a non-member block.
    if (isGroupAnchor(anchor)) {
      const members = resolveGroup(blocks() ?? [], anchor.id);
      const clamped = clampGroupDelta(members, blocks() ?? [], day(), deltaMin);
      if (clamped === 0) { setGhost(null); return; } // identity / fully blocked — no write
      setGhost({ ids: new Set(members.map((m) => m.id)), dMin: clamped }); // hold at clamped delta
      try { await api.blocks.moveGroup(anchor.id, clamped); refetchBlocks(); }
      catch (err) { showToast((err as Error).message, 'error'); }
      finally { setGhost(null); }
      return;
    }

    // Loose chip → plain move (clamped against other loose blocks); if dropped inside a
    // Plan's window, attach it (containers are attach targets, not clamp walls).
    setGhost(null);
    const resolved = resolveGesture(anchor, day(), 'move', dyPx, neighboursFor(anchor, day(), blocks() ?? []));
    if (!resolved) return;
    const container = containerAt(blocks() ?? [], Date.parse(resolved.start_at), anchor.id);
    try {
      await api.blocks.update(anchor.id, container ? { ...resolved, parent_block_id: container.id } : resolved);
      refetchBlocks();
      if (container) showToast(`Added to "${container.title}"`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const groupCtx: GroupCtx = { extraMin, onMoveLive, onMoveEnd: () => setGhost(null), onMoveCommit };

  // ── CON-5: write-capable Planner (click-to-create + drag-to-schedule) ──────────
  // The grid column element — the origin for drop/click Y → time math. Its top is the
  // grid's Y-zero (the top of the axis, i.e. 00:00 or the top collapse bar); `clientY -
  // rect.top` is a grid-relative pixel that maps to a minute via the segmented `minAt`.
  let gridEl: HTMLDivElement | undefined;
  const gridY = (clientY: number) => (gridEl ? clientY - gridEl.getBoundingClientRect().top : 0);

  // Grid Y (px) → snapped minute-of-day on the segmented axis, then → a span. The
  // shared snapToSlot rounds the (possibly fractional) minAt result before the
  // SNAP_MIN snap and never yields 24:00 (caps at the last slot, 23:45) — the same
  // guard the calendar's click-to-create uses.
  function minuteAtGridY(clientY: number): number {
    return snapToSlot(axisMinAt(gridY(clientY), axisState(), PX_PER_MIN), SNAP_MIN);
  }

  // AB3 — click-to-create: the promise the empty-state hint has been making. A
  // near-zero pointer move (< CLICK_PX, same threshold as the block gestures) on
  // EMPTY grid space opens the Add wizard prefilled at the clicked, snapped time;
  // the wizard's task path maps day+start onto scheduled_for/task_time, so Save
  // lands directly on the planner as a scheduled task. Chips, containers, expander
  // bars, and the entity card all swallow their own pointerdown, so only true empty
  // space arms this; real drags (≥ CLICK_PX) and flight-plan drops (whose
  // pointerdown starts off-grid) are untouched. Open-window rule (owner decision
  // 3): a snapped time inside an ACTIVE block's span is a no-op — no stacking a
  // new block onto an occupied slot. Update mode is exempt entirely: there a chip
  // tap (which does NOT stop propagation) means "toggle done", not "add".
  function clickToCreate(e: PointerEvent) {
    if (updateMode()) return;
    const startX = e.clientX, startY = e.clientY;
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', onUp);
      if (Math.abs(ev.clientX - startX) >= CLICK_PX || Math.abs(ev.clientY - startY) >= CLICK_PX) return;
      const minute = minuteAtGridY(ev.clientY);
      if (isSlotOccupied(dayBlocks(), day(), minute)) return;
      setElementModal({
        open: true, mode: 'add', kind: 'task',
        prefill: { day: day(), start: minuteToHHMM(minute) },
      });
    };
    window.addEventListener('pointerup', onUp);
  }

  // Create a Time Block at grid Y, optionally bound to a flight-plan task; attach it
  // if it lands inside a Plan's window (mirrors the loose-chip drop path). One POST
  // (+ one attach PATCH only when dropped into a container).
  async function createBlockAt(clientY: number, task?: { task_id: string; title: string; estimated_minutes: number | null }) {
    // spanAtY takes a LINEAR grid-y; hand it the snapped minute re-linearised so the
    // segmented click lands at the intended time.
    const startMin = minuteAtGridY(clientY);
    const span = spanAtY(day(), startMin * PX_PER_MIN, task?.estimated_minutes ?? DEFAULT_BLOCK_MIN);
    const tag = task ? taskOf(task.task_id)?.tags?.[0] : undefined;
    try {
      const { block } = await api.blocks.create({
        title: task?.title ?? 'New block',
        block_kind: task ? 'task' : 'timeblock',
        ...(task ? { task_id: task.task_id } : {}),
        ...(tag ? { tag } : {}),
        ...span,
      });
      const container = containerAt(blocks() ?? [], Date.parse(span.start_at), block.id);
      if (container) await api.blocks.update(block.id, { parent_block_id: container.id });
      if (task) { await api.flightPlan.remove(task.task_id); refetchFlightPlan(); }
      refetchBlocks();
      showToast(
        container ? `Added to "${container.title}"` : task ? `Scheduled "${task.title}"` : 'Block created',
        task || container ? 'success' : 'default',
      );
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Drop target: a flight-plan task dropped on the grid schedules it at that time.
  const gridDrop = useDropZone((payload, e) => {
    if (payload.kind !== 'flight-task') return;
    const it = (flightPlan() ?? []).find((i) => i.task_id === payload.id);
    if (it) void createBlockAt(e.clientY, it);
  });

  function requestDeletePlan(plan: Block) {
    const childCount = (blocks() ?? []).filter((b) => b.parent_block_id === plan.id).length;
    if (childCount === 0) {
      api.blocks.delete(plan.id).then(() => { refetchBlocks(); showToast('Plan removed', 'default'); })
        .catch((err) => showToast((err as Error).message, 'error'));
      return;
    }
    setDeletePlan({ plan, childCount });
  }

  // T-PLAN-1: clear the day's auto-placed blocks (server keeps locked, calendar
  // meetings, and habit/pattern placements — see POST /api/days/:date/clear).
  async function clearDay() {
    if (!confirm(`Clear auto-placed blocks for ${day()}? Locked, calendar, and habit blocks are kept.`)) return;
    try {
      const r = await api.blocks.clearDay(day());
      refetchBlocks();
      showToast(
        r.cleared ? `Cleared ${r.cleared} auto-placed block${r.cleared === 1 ? '' : 's'}` : 'Nothing auto-placed to clear',
        'default',
      );
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Bands reprojected onto the segmented axis (top/height in px, trimmed to visible;
  // dropped when wholly inside a collapsed region). Presentation fields pass through.
  const axisBands = createMemo((): Band[] => {
    const st = axisState();
    const out: Band[] = [];
    for (const b of bands()) {
      // b.top / b.height are LINEAR px (grid.ts scale) → back to minutes.
      const startMin = b.top / PX_PER_MIN;
      const endMin = (b.top + b.height) / PX_PER_MIN;
      const ext = segmentExtentPx(startMin, endMin, st, PX_PER_MIN);
      if (!ext) continue;
      // labelTop: reproject its linear px through the axis too, clamped into the band.
      const labelMin = b.labelTop / PX_PER_MIN;
      const labelExt = visibleExtent(labelMin, labelMin + 1, st);
      const labelTop = labelExt ? axisYOf(labelExt.startMin, st, PX_PER_MIN) : ext.topPx;
      out.push({ ...b, top: ext.topPx, height: ext.heightPx, labelTop });
    }
    return out;
  });

  // Someday Time Blocks (was Concepts) render on their goal day in the header lane;
  // clicking one opens a lightweight popover — Edit · Add to day · Delete (cockpit-v2
  // Phase 4, replacing the ConceptLane). Local so it closes over setEditBlock + refetch.
  function SomedayChip(props: { block: Block }) {
    const [open, setOpen] = createSignal(false);
    async function addToDay() {
      setOpen(false);
      try {
        await api.blocks.promote(props.block.id, new Date(selectedDay() + 'T00:00:00').toISOString(), { all_day: true });
        refetchConcepts(); refetchBlocks();
        showToast(`"${props.block.title}" added to ${selectedDay()}`, 'success');
      } catch (err) { showToast((err as Error).message, 'error'); }
    }
    async function del() {
      setOpen(false);
      try { await api.blocks.delete(props.block.id); refetchConcepts(); refetchBlocks(); showToast(`Deleted "${props.block.title}"`, 'default'); }
      catch (err) { showToast((err as Error).message, 'error'); }
    }
    return (
      <span class="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] bg-card max-w-[180px] border-2 border-dotted border-muted-foreground hover:border-primary transition-colors"
          title={props.block.title}
        >
          <Pentagon size={10} class="text-muted-foreground flex-shrink-0" />
          <span class="text-foreground truncate">{props.block.title}</span>
          <Show when={blockTagLabel(props.block)}>{(lbl) => <span class="text-primary flex-shrink-0">{lbl()}</span>}</Show>
        </button>
        <Show when={open()}>
          <div class="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div class="absolute top-full left-0 mt-1 z-30 w-56 rounded-lg border border-border bg-popover shadow-xl p-3">
            <div class="text-sm font-medium text-foreground truncate">{props.block.title}</div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Show when={blockTagLabel(props.block)}>{(lbl) => <span class="text-primary">{lbl()}</span>}</Show>
              <Show when={props.block.goal_start_date}>{(d) => <span>· goal {d()}</span>}</Show>
              <Show when={props.block.duration_minutes}>{(m) => <span>· {m()}m</span>}</Show>
            </div>
            <div class="mt-2 flex flex-col gap-1">
              <button onClick={() => { setOpen(false); editTimeBlock(props.block.id); }} class="btn-ghost text-xs px-2 py-1 justify-start"><Pencil size={12} /> Edit</button>
              <button onClick={addToDay} class="btn-secondary text-xs px-2 py-1 justify-start"><ArrowUpRight size={12} /> Add to day</button>
              <button onClick={del} class="btn-ghost text-xs px-2 py-1 justify-start hover:text-destructive"><Trash2 size={12} /> Delete</button>
            </div>
          </div>
        </Show>
      </span>
    );
  }

  return (
    <div class="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
      {/* Header — region label + actions (no zoom control: the whole day is shown). */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Planner</span>
          <span class="text-[10px] text-muted-foreground">full day</span>
        </div>
        <div class="flex items-center gap-3">
          {/* Multi-select → Routine: a one-click entry point for the Shift++ chord,
              shown once ≥2 task chips are selected (opens the same Create-Routine modal). */}
          <Show when={selection().size >= 2}>
            <button
              onClick={() => setRoutineModal({ open: true, name: '' })}
              class="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
              title={`Create a routine from the ${selection().size} selected tasks`}
            >
              <Repeat size={12} /> + Routine
            </button>
          </Show>
          {/* T-PLAN-1: clear this day's auto-placed blocks (keeps locked/calendar/habit). */}
          <button
            onClick={clearDay}
            class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
            title="Clear auto-placed blocks for this day (keeps locked, calendar, and habit blocks)"
          >
            <Eraser size={12} /> Clear
          </button>
          {/* Update mode — tap a task to mark it done (no need to have started it). */}
          <button
            onClick={() => setUpdateMode((v) => !v)}
            class="inline-flex items-center gap-1 text-xs transition-colors"
            classList={{ 'text-primary font-medium': updateMode(), 'text-muted-foreground hover:text-foreground': !updateMode() }}
            title={updateMode() ? 'Done updating' : 'Update — tap tasks to mark them done'}
          >
            <CheckCircle2 size={12} /> {updateMode() ? 'Done' : 'Update'}
          </button>
        </div>
      </div>

      {/* Header lane — all-day Plans + Concepts whose goal day is today (off the grid). */}
      <Show when={hasHeaderLane()}>
        <div class="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-border bg-card/60 flex-shrink-0">
          <span class="text-[9px] uppercase tracking-wide text-muted-foreground mr-0.5">all-day</span>
          <For each={allDayPlans()}>{(b) => <HeaderChip block={b} />}</For>
          <For each={todayConcepts()}>{(c) => <SomedayChip block={c} />}</For>
        </div>
      </Show>

      {/* The full-day segmented grid: natural height (day minus collapsed regions),
          no inner scroll. The page scrolls for everything else. */}
      <div class="relative">
        <div class="grid" style={{ 'grid-template-columns': '3.5rem 1.75rem 1fr' }}>
          <TimeGutter state={axisState} />
          {/* Direction column — rotated, per-direction-colored window names (segmented). */}
          <div class="border-l border-border/60"><DirectionColumn bands={axisBands} state={axisState} /></div>
          <div
            ref={gridEl}
            class="relative border-l border-border/60 transition-colors"
            classList={{ 'bg-primary/[0.04]': gridDrop.isOver() }}
            style={{ height: `${axisHeightPx(axisState(), PX_PER_MIN)}px` }}
            title="Click an empty slot to add · drop a flight-plan task to schedule it"
            onPointerDown={clickToCreate}
            onPointerUp={gridDrop.handlers.onPointerUp}
          >
            <PatternBlockOverlay bands={axisBands} />
            <HourLines state={axisState} />
            {/* Each Time-Block draws its container box (solid category label + box) and
                its own task chips, laid out inside the box's task region. */}
            <For each={containers()}>
              {(c) => (
                <>
                  <ContainerOutline block={c} day={day()} state={axisState} gridY={gridY} group={groupCtx} onDelete={requestDeletePlan} />
                  <For each={placedChildren(c.id)}>
                    {(p) => <PlannerChip placed={p} day={day()} state={axisState} gridY={gridY} isNextUp={p.block.id === nextUp()?.id} nested={true} updateMode={updateMode()} group={groupCtx} />}
                  </For>
                </>
              )}
            </For>
            {/* Loose chips tile across the full width (in the gaps between Time-Blocks). */}
            <For each={placedLoose()}>
              {(p) => <PlannerChip placed={p} day={day()} state={axisState} gridY={gridY} isNextUp={p.block.id === nextUp()?.id} nested={false} updateMode={updateMode()} group={groupCtx} />}
            </For>
            <Show when={isToday()}><NowLine day={day()} now={nowISO()} state={axisState} /></Show>
            {/* Expander bars over the two night regions (grid column only). */}
            <ExpanderBar region="top" label="12am – 7am" state={axisState} onToggle={togglePlannerTop} />
            <ExpanderBar region="bottom" label="9pm – 12am" state={axisState} onToggle={togglePlannerBottom} />
            {/* Expanded entity card — overlays the grid at the selected entity's slot. */}
            <PlannerEntityCard day={day()} state={axisState} onRequestDeletePlan={requestDeletePlan} />
            <Show when={chips().length === 0 && containers().length === 0}>
              <div class="absolute left-0 right-0 text-center text-sm text-muted-foreground px-4 pointer-events-none" style={{ top: `${axisYOf(9 * 60, axisState(), PX_PER_MIN)}px` }}>
                Nothing planned yet — <span class="text-primary font-medium">click an empty slot</span> to add a block,
                drag a flight-plan task onto a time, or stage items and hit
                <span class="text-primary font-medium"> Schedule</span>.
              </div>
            </Show>
          </div>
        </div>
      </div>
      <Show when={deletePlan()}>
        {(d) => <DeletePlanDialog plan={d().plan} childCount={d().childCount} onClose={() => setDeletePlan(null)} />}
      </Show>
    </div>
  );
}
