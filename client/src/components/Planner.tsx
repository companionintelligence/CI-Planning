import { For, Show, createMemo, createSignal, createResource, onCleanup, onMount, createEffect } from 'solid-js';
import { Lock, AlertTriangle, Play, Star, Pentagon, Pencil, Trash2, Repeat, Check, CheckCircle2, ArrowUpRight, Eraser, X } from 'lucide-solid';
import { api, type Block } from '../lib/api.js';
import { PX_PER_MIN, DAY_HEIGHT_PX, MINUTES_PER_DAY, minutesIntoDay, yOf, minsOf } from '../lib/grid.js';
import { HANDLE_PX, type GestureMode, type Neighbour, isImmovable, resolveGesture, commitDrag, clampLiveDelta } from '../lib/drag.js';
import { resolveGroup, containerAt, clampGroupDelta } from '../lib/group-move.js';
import { spanAtY } from '../lib/place.js';
import { useDropZone, dragPayload } from '../lib/draggable.js';
import { isSelected, toggleSelection, setActiveTask, setActiveBlock, selection, setRoutineModal } from '../stores/selection.js';
import { layoutBlocks } from './CalendarGrid.js';
import { blocks, concepts, flightPlan, taskOf, patternForTask, setElementModal, refetchBlocks, refetchFlightPlan, refetchConcepts, showToast, selectedDay, tags, categoryPrefs, patternPrefs, patternBlocks } from '../stores/index.js';
import { isAllDay } from '../lib/overlay.js';
import { textureStyle, blockColorVar, doneHatchStyle } from '../lib/textures.js';
import { displayTag } from '../lib/tag-tax.js';
import { pickNextUp, scrollTopForBlock, SLOT_MIN, VISIBLE_HOURS } from '../lib/planner.js';
import { computeBands } from '../lib/day-windows.js';
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
 * The PLANNER (Phase G, G6): the hour-by-hour view of TODAY. 8h visible by default,
 * expandable to the full 24h; the **next-up** item is pinned to the second slot and
 * the view auto-scrolls there. Items show **name · tag · start–end**; Time-Blocks
 * render as labelled outlines; pattern instances carry their type texture; chips
 * drag-to-reorder (one tz-safe PATCH); overlaps are **allowed but flagged**.
 *
 * Plan-as-container (PR-C): a Plan + the task blocks scheduled into it move together.
 * Dragging the Plan — or any member — shifts the whole group by one minute delta
 * (atomic `move-group`); members render nested under their Plan; Alt-dragging a
 * member detaches just it; dropping a loose chip into a Plan's window attaches it.
 *
 * Write-capable (CON-5): clicking an empty slot creates a Time Block at that time,
 * and a flight-plan task dragged onto the grid is scheduled there (drop-Y → time via
 * `place.ts`/`grid.ts`, then `api.blocks.create` + `flightPlan.remove`); a drop inside
 * a Plan's window attaches via `parent_block_id`. Authoring is no longer wizard-only.
 *
 * Built on the shared grid math (`grid.ts`), the overlap layout (`layoutBlocks`),
 * the drag gesture (`drag.ts`), the pure group math (`group-move.ts`), and the shared
 * pointer-DnD (`draggable.ts`) — so there is no tz drift between a chip's pixel
 * position and its stored instant.
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

/**
 * The clamped pixel delta for a live drag preview — so the block (or whole group)
 * visibly stops at a neighbour's edge while dragging, not just on release. Mirrors the
 * commit's clamp scoping: a group move clamps by the group hull; a loose move / any
 * resize clamps per-edge against `neighboursFor`. Alt-drag (detach) clamps as a loose
 * block, matching the commit path.
 */
function clampLiveDyFor(b: Block, day: string, all: Block[], mode: GestureMode, dyPx: number, ev: PointerEvent): number {
  const dMin = dyPx / PX_PER_MIN;
  const altDetach = mode === 'move' && b.parent_block_id != null && ev.altKey;
  if (mode === 'move' && !altDetach && (b.block_kind === 'timeblock' || b.parent_block_id != null)) {
    return clampGroupDelta(resolveGroup(all, b.id), all, day, dMin) * PX_PER_MIN;
  }
  const n = altDetach ? neighboursFor({ ...b, parent_block_id: null }, day, all) : neighboursFor(b, day, all);
  return clampLiveDelta(b, day, mode, dMin, n) * PX_PER_MIN;
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
 * A 'move' gesture can be owned by the caller for group-aware behavior: `onMoveLive`
 * fires on every pointermove (live group ghost), `onMoveEnd` on pointerup (clear the
 * ghost), and `onMoveCommit` replaces the default single-block PATCH. Resize always
 * uses the default `resolveGesture` + `commitDrag` path.
 */
function useBlockDrag(opts: {
  block: () => Block; day: string; locked: () => boolean;
  baseTop: () => number; baseHeight: () => number;
  onClick: (x: number, y: number) => void;
  onMoveLive?: (dy: number, ev: PointerEvent) => void;
  onMoveEnd?: () => void;
  onMoveCommit?: (dy: number, ev: PointerEvent) => void;
  neighbours?: () => Neighbour[];
  clampLiveDy?: (mode: GestureMode, dyPx: number, ev: PointerEvent) => number;
}) {
  const [drag, setDrag] = createSignal<{ mode: GestureMode; dy: number } | null>(null);
  const liveTop = () => {
    const g = drag();
    if (!g) return opts.baseTop();
    const dMin = g.dy / PX_PER_MIN;
    return g.mode === 'resize-bottom' ? opts.baseTop() : opts.baseTop() + dMin;
  };
  const liveHeight = () => {
    const g = drag();
    if (!g) return opts.baseHeight();
    const dMin = g.dy / PX_PER_MIN;
    if (g.mode === 'move') return opts.baseHeight();
    if (g.mode === 'resize-top') return opts.baseHeight() - dMin;
    return opts.baseHeight() + dMin;
  };
  function startGesture(mode: GestureMode, e: PointerEvent) {
    // Do NOT bail early for locked blocks — click detection must still work so the
    // entity card can open. Locking only suppresses drag state and commits.
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (opts.locked()) return; // no drag visual for locked blocks
      const raw = ev.clientY - startY;
      // Live preview is collision-clamped so the chip/group visibly stops at the wall
      // while dragging; the pointer-up commit still snaps+clamps via resolveGesture.
      const dy = opts.clampLiveDy ? opts.clampLiveDy(mode, raw, ev) : raw;
      setDrag({ mode, dy });
      if (mode === 'move') opts.onMoveLive?.(dy, ev);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture?.(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const dy = ev.clientY - startY; // RAW delta: click detection + commit (which clamps itself)
      if (!opts.locked()) { setDrag(null); if (mode === 'move') opts.onMoveEnd?.(); }
      if (mode === 'move' && Math.abs(dy) < CLICK_PX) { opts.onClick(ev.clientX, ev.clientY); return; }
      if (opts.locked()) return; // no drag commit for locked blocks
      if (mode === 'move' && opts.onMoveCommit) { opts.onMoveCommit(dy, ev); return; }
      // Resize (and any non-grouped move): clamp against neighbours so an edge can't
      // be dragged into an adjacent block.
      const resolved = resolveGesture(opts.block(), opts.day, mode, dy, opts.neighbours?.() ?? []);
      void commitDrag(opts.block(), resolved, { onError: (m) => showToast(m, 'error') });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    if (!opts.locked()) setDrag({ mode, dy: 0 }); // only show drag state for unlocked blocks
  }
  return { drag, liveTop, liveHeight, startGesture };
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

/** Handlers the Plan-as-container gestures need from the Planner (group ghost + commits). */
interface GroupCtx {
  extraMin: (id: string) => number;                         // optimistic group-ghost offset (minutes)
  onMoveLive: (anchor: Block, dy: number, ev: PointerEvent) => void;
  onMoveEnd: () => void;
  onMoveCommit: (anchor: Block, dy: number, ev: PointerEvent) => void;
}

// ── Plan container outline (a timed Time-Block: ★ solid 3pt) — interactive ─────
function ContainerOutline(props: { block: Block; day: string; group: GroupCtx; onDelete: (b: Block) => void }) {
  const b = () => props.block;
  const baseTop = () => minutesIntoDay(b().start_at, props.day);
  const baseHeight = () => Math.max(minutesIntoDay(b().end_at, props.day) - baseTop(), 0);
  const locked = () => isImmovable(b());
  const { drag, liveTop, liveHeight, startGesture } = useBlockDrag({
    // Click (a near-zero drag) on the label expands the Time-Block into the entity card.
    block: b, day: props.day, locked, baseTop, baseHeight, onClick: () => setActiveBlock(b().id),
    onMoveLive: (dy, ev) => props.group.onMoveLive(b(), dy, ev),
    onMoveEnd: () => props.group.onMoveEnd(),
    onMoveCommit: (dy, ev) => props.group.onMoveCommit(b(), dy, ev),
    neighbours: () => neighboursFor(b(), props.day, blocks() ?? []),
    clampLiveDy: (mode, dyPx, ev) => clampLiveDyFor(b(), props.day, blocks() ?? [], mode, dyPx, ev),
  });
  const top = () => liveTop() + props.group.extraMin(b().id);

  // 0069: the Time-Block category colour — stamped category colour wins, else the tag
  // hash (the same helper the chips use), so the column matches the rest of the planner.
  const fill = () => blockColorVar(b(), categoryPrefs()?.prefs);
  const heightPx = () => Math.max(yOf(liveHeight()), 24);
  return (
    <div
      class="absolute left-0.5 right-0.5 rounded-lg border-2 select-none touch-none pointer-events-none"
      classList={{ 'z-0': !drag(), 'z-[25] shadow-lg': !!drag() }}
      style={{ top: `${yOf(top())}px`, height: `${heightPx()}px`, 'border-color': fill() }}
      title={`${b().title} · Time Block — drag the label to move the whole group`}
    >
      {/* Solid category label cell (left) — name + secondary tags, white text. It IS
          the drag handle: dragging it moves the Time Block + its tasks as a group.
          The × button provides one-tap delete without needing to open the entity card. */}
      <div
        class="group/label absolute top-0 bottom-0 left-0 rounded-l-md overflow-hidden px-2 py-1 flex flex-col gap-0.5 pointer-events-auto"
        classList={{ 'cursor-grab': !locked(), 'cursor-default': locked() }}
        style={{ width: `${CAT_WIDTH_PX}px`, 'background-color': fill(), color: `color-mix(in oklch, ${fill()} 30%, black)` }}
        onPointerDown={(e) => startGesture('move', e)}
      >
        <div class="flex items-start gap-1 text-[11px] font-medium leading-tight">
          <Star size={9} class="flex-shrink-0 mt-0.5" />
          <span class="break-words min-w-0 flex-1">{b().title}</span>
          <button
            type="button"
            title="Remove Time Block"
            class="flex-shrink-0 opacity-0 group-hover/label:opacity-70 hover:!opacity-100 transition-opacity ml-0.5 -mr-0.5 -mt-0.5 rounded"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); props.onDelete(b()); }}
          ><X size={10} /></button>
        </div>
        <Show when={heightPx() >= 34}>
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
        <div class="absolute top-0 z-10 cursor-ns-resize pointer-events-auto" style={{ left: `${CAT_WIDTH_PX}px`, right: '0', height: `${HANDLE_PX}px` }} onPointerDown={(e) => startGesture('resize-top', e)} />
        <div class="absolute bottom-0 z-10 cursor-ns-resize pointer-events-auto" style={{ left: `${CAT_WIDTH_PX}px`, right: '0', height: `${HANDLE_PX}px` }} onPointerDown={(e) => startGesture('resize-bottom', e)} />
      </Show>
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
      <Show when={blockTagLabel(props.block)}>{(lbl) => <span class="text-primary flex-shrink-0">{lbl()}</span>}</Show>
    </span>
  );
}

// ── A draggable planner chip (name · tag · start–end, texture, next-up marker) ──
function PlannerChip(props: { placed: Placed; day: string; isNextUp: boolean; nested: boolean; updateMode: boolean; group: GroupCtx }) {
  const b = () => props.placed.block;
  const task = () => taskOf(b().task_id);
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
    block: b, day: props.day, locked,
    baseTop: () => props.placed.top, baseHeight: () => props.placed.height,
    onClick: () => { const tid = b().task_id; if (tid != null) setActiveTask(tid); else setActiveBlock(b().id); },
    onMoveLive: (dy, ev) => props.group.onMoveLive(b(), dy, ev),
    onMoveEnd: () => props.group.onMoveEnd(),
    onMoveCommit: (dy, ev) => props.group.onMoveCommit(b(), dy, ev),
    neighbours: () => neighboursFor(b(), props.day, blocks() ?? []),
    clampLiveDy: (mode, dyPx, ev) => clampLiveDyFor(b(), props.day, blocks() ?? [], mode, dyPx, ev),
  });
  const top = () => liveTop() + props.group.extraMin(b().id);
  const heightPx = () => Math.max(yOf(liveHeight()), 18);
  // Nested chips sit in their Time-Block's task region (right of the category cell);
  // loose chips tile across the full width.
  const frame = () => chipFrame(props.placed.col, props.placed.cols, props.nested);

  const selectedBlock = () => isSelected({ kind: 'block', id: b().id });
  return (
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
        top: `${yOf(top())}px`,
        height: `${heightPx()}px`,
        left: frame().left,
        width: frame().width,
        ...(completed() ? doneHatchStyle(tag()) : {}),
        ...(glow() ? { '--done-glow': `color-mix(in srgb, ${color()} 55%, transparent)` } : {}),
      }}
      title={`${b().title}${tag() ? ` · #${tag()}` : ''} · ${fmtTime(b().start_at)}–${fmtTime(b().end_at)}${props.nested ? ' · in a Plan (drag moves the group; Alt-drag to pull out)' : ''}`}
      onAnimationEnd={() => setGlow(false)}
      onPointerDown={(e) => {
        if (props.updateMode) return; // Update mode: a tap toggles done (onClick) — no drag.
        // Cmd/Ctrl-click toggles multi-select (Phase F) — don't start a drag.
        if ((e.metaKey || e.ctrlKey) && b().task_id != null) {
          e.preventDefault(); e.stopPropagation();
          toggleSelection({ kind: 'block', id: b().id });
          return;
        }
        startGesture('move', e);
      }}
      onClick={(e) => {
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
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); void setDone(!completed()); }}
        >
          <Show when={completed()}><Check size={11} class="text-background" /></Show>
        </button>
      </Show>

      <Show when={!locked() && !props.updateMode}>
        <div class="absolute top-0 left-0 right-0 z-10 cursor-ns-resize" style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(e) => startGesture('resize-top', e)} />
      </Show>

      <div class="relative px-1.5 py-0.5" classList={{ 'pl-6': props.updateMode }}>
        <div class="flex items-center gap-1 font-medium text-foreground truncate">
          <Show when={props.isNextUp}><Play size={9} class="text-primary flex-shrink-0 fill-primary" /></Show>
          <Show when={b().is_locked}><Lock size={9} class="text-muted-foreground flex-shrink-0" /></Show>
          <Show when={props.nested}><Star size={8} class="text-primary/60 flex-shrink-0" /></Show>
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

      <Show when={!locked() && !props.updateMode}>
        <div class="absolute bottom-0 left-0 right-0 z-10 cursor-ns-resize" style={{ height: `${HANDLE_PX}px` }}
          onPointerDown={(e) => startGesture('resize-bottom', e)} />
      </Show>

    </div>
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

export function Planner() {
  const day = () => selectedDay();
  // Now-line, next-up pin, and auto-scroll are today-relative — gated off other days.
  const isToday = () => day() === localISODate();
  // Visible window height: 4 / 8 / 16 hours (cockpit-v2 Phase 2). The grid is always
  // the full day tall and scrolls, so any block stays reachable at any window size.
  const [windowHours, setWindowHours] = createSignal(VISIBLE_HOURS);
  const visiblePx = () => windowHours() * 60 * PX_PER_MIN;
  const [updateMode, setUpdateMode] = createSignal(false);
  const [deletePlan, setDeletePlan] = createSignal<{ plan: Block; childCount: number } | null>(null);

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
  const bands = createMemo(() => computeBands(dayWindows() ?? {}, tags() ?? [], patternPrefs()?.prefs ?? {}));
  // T-PLAN-2: the day's earliest grid block — the scroll anchor (1h of lead-in above it).
  const firstChip = createMemo(() => {
    const cs = chips();
    return cs.length ? [...cs].sort((a, b) => a.start_at.localeCompare(b.start_at))[0] : undefined;
  });

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
  // the snapped delta until the refetch lands, so nothing snaps back.
  const [ghost, setGhost] = createSignal<{ ids: Set<string>; dy: number } | null>(null);
  const extraMin = (id: string) => { const g = ghost(); return g && g.ids.has(id) ? g.dy / PX_PER_MIN : 0; };
  const isGroupAnchor = (b: Block) => b.block_kind === 'timeblock' || b.parent_block_id != null;

  function onMoveLive(anchor: Block, dy: number, ev: PointerEvent) {
    // Alt-detaching a member → only the member moves (no group ghost).
    if (anchor.parent_block_id != null && ev.altKey) { setGhost(null); return; }
    if (!isGroupAnchor(anchor)) return;
    const members = resolveGroup(blocks() ?? [], anchor.id);
    if (members.length <= 1) return;
    setGhost({ ids: new Set(members.filter((m) => m.id !== anchor.id).map((m) => m.id)), dy });
  }

  async function onMoveCommit(anchor: Block, dy: number, ev: PointerEvent) {
    const deltaMin = minsOf(dy);

    // Member + Alt → detach this one and move it alone. It becomes loose, so clamp it
    // against the loose obstacle set (as if it had no parent).
    if (anchor.parent_block_id != null && ev.altKey) {
      setGhost(null);
      const looseN = neighboursFor({ ...anchor, parent_block_id: null }, day(), blocks() ?? []);
      const resolved = resolveGesture(anchor, day(), 'move', dy, looseN);
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
      setGhost({ ids: new Set(members.map((m) => m.id)), dy: clamped * PX_PER_MIN }); // hold at clamped delta
      try { await api.blocks.moveGroup(anchor.id, clamped); refetchBlocks(); }
      catch (err) { showToast((err as Error).message, 'error'); }
      finally { setGhost(null); }
      return;
    }

    // Loose chip → plain move (clamped against other loose blocks); if dropped inside a
    // Plan's window, attach it (containers are attach targets, not clamp walls).
    setGhost(null);
    const resolved = resolveGesture(anchor, day(), 'move', dy, neighboursFor(anchor, day(), blocks() ?? []));
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
  // column's midnight, so `clientY - rect.top` is pixels-into-day at any scroll offset.
  let gridEl: HTMLDivElement | undefined;
  const gridY = (clientY: number) => (gridEl ? clientY - gridEl.getBoundingClientRect().top : 0);

  // Create a Time Block at grid Y, optionally bound to a flight-plan task; attach it
  // if it lands inside a Plan's window (mirrors the loose-chip drop path). One POST
  // (+ one attach PATCH only when dropped into a container).
  async function createBlockAt(clientY: number, task?: { task_id: string; title: string; estimated_minutes: number | null }) {
    const span = spanAtY(day(), gridY(clientY), task?.estimated_minutes ?? DEFAULT_BLOCK_MIN);
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

  let scroller: HTMLDivElement | undefined;
  // Open each day scrolled to exactly 1h before its FIRST pattern direction (the
  // earliest availability window) — one hour of lead-in, no more, no less. Falls back
  // to the first block, then the day top, when the day has no direction windows.
  const firstDirectionTop = createMemo(() => {
    const bs = bands();
    return bs.length ? Math.min(...bs.map((b) => b.top)) : null;
  });
  const anchorChip = () => (isToday() ? nextUp() ?? firstChip() : firstChip());
  const SLOT_PX = SLOT_MIN * PX_PER_MIN; // 1h of lead-in above the anchor
  const repin = () => {
    if (!scroller) return;
    const dirTop = firstDirectionTop();
    scroller.scrollTop = dirTop != null ? Math.max(0, dirTop - SLOT_PX) : scrollTopForBlock(anchorChip(), day());
  };
  onMount(repin);
  // Pin ONCE per (day, zoom) — never on a blocks refetch. A committed action (delete,
  // complete, drag, auto-reflow) refetches blocks, which previously re-ran this effect
  // and yanked the scroll back to the top of the day; gating on the day+zoom key stops
  // that. Reading firstChip()/firstDirectionTop() re-runs it once the day's blocks AND
  // direction windows have landed; the loading gates hold it until both are ready.
  let pinnedKey = '';
  createEffect(() => {
    const key = `${day()}:${windowHours()}`;
    firstChip(); firstDirectionTop();
    if (key === pinnedKey || blocks.loading || dayWindows.loading) return;
    pinnedKey = key;
    queueMicrotask(repin);
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
      {/* Header — region label + the 8h⇄24h expand control */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <div class="flex items-center gap-2">
          <span class="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Planner</span>
          <span class="text-[10px] text-muted-foreground">{windowHours()}h · scroll for more</span>
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
          <div class="inline-flex items-center rounded-md border border-border overflow-hidden text-xs" title="Visible hours">
            <For each={[4, 8, 16]}>
              {(h) => (
                <button
                  onClick={() => setWindowHours(h)}
                  class="px-2 py-0.5 transition-colors"
                  classList={{ 'text-foreground underline': windowHours() === h, 'text-muted-foreground hover:text-foreground': windowHours() !== h }}
                >
                  {h}h
                </button>
              )}
            </For>
          </div>
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

      {/* Windowed scroller: 8h tall by default, full 24h when expanded. */}
      <div
        ref={scroller}
        class="overflow-y-auto overflow-x-hidden relative"
        style={{ height: `${visiblePx()}px` }}
      >
        <div class="grid" style={{ 'grid-template-columns': '3.5rem 1.75rem 1fr' }}>
          <TimeGutter />
          {/* Direction column — rotated, per-direction-colored window names. */}
          <div class="border-l border-border/60"><DirectionColumn bands={bands} /></div>
          <div
            ref={gridEl}
            class="relative border-l border-border/60 transition-colors"
            classList={{ 'bg-primary/[0.04]': gridDrop.isOver() }}
            style={{ height: `${DAY_HEIGHT_PX}px` }}
            title="Drop a flight-plan task to schedule it"
            onPointerUp={gridDrop.handlers.onPointerUp}
          >
            <PatternBlockOverlay bands={bands} />
            <HourLines />
            {/* Each Time-Block draws its container box (solid category label + box) and
                its own task chips, laid out inside the box's task region. */}
            <For each={containers()}>
              {(c) => (
                <>
                  <ContainerOutline block={c} day={day()} group={groupCtx} onDelete={requestDeletePlan} />
                  <For each={placedChildren(c.id)}>
                    {(p) => <PlannerChip placed={p} day={day()} isNextUp={p.block.id === nextUp()?.id} nested={true} updateMode={updateMode()} group={groupCtx} />}
                  </For>
                </>
              )}
            </For>
            {/* Loose chips tile across the full width (in the gaps between Time-Blocks). */}
            <For each={placedLoose()}>
              {(p) => <PlannerChip placed={p} day={day()} isNextUp={p.block.id === nextUp()?.id} nested={false} updateMode={updateMode()} group={groupCtx} />}
            </For>
            <Show when={isToday()}><NowLine day={day()} now={nowISO()} /></Show>
            {/* Expanded entity card — overlays the grid at the selected entity's slot. */}
            <PlannerEntityCard day={day()} onRequestDeletePlan={requestDeletePlan} />
            <Show when={chips().length === 0 && containers().length === 0}>
              <div class="absolute left-0 right-0 top-24 text-center text-sm text-muted-foreground px-4 pointer-events-none">
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
