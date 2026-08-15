import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import { ChevronRight, ChevronDown, Lock, NotebookPen, Star } from 'lucide-solid';
import type { Block, DayStar } from '../lib/api.js';
import { isPerfectDay, pipCount, STAR_GOLD } from '../lib/stars.js';
import {
  PX_PER_MIN,
  minutesIntoDay,
} from '../lib/grid.js';
import {
  type AxisState,
  TOP_COLLAPSE_END,
  BOTTOM_COLLAPSE_START,
  segments,
  axisHeightPx,
  yOf as axisYOf,
  minAt as axisMinAt,
  visibleExtent,
} from '../lib/day-axis.js';
import { setElementModal, calendarAxisState, toggleCalendarTop, toggleCalendarBottom, connectionPrefs, categoryPrefs, conflictedBlockIds } from '../stores/index.js';
import { setActiveBlock, setActiveEntity } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { isAllDay, isTimed, isTaskBlock, showsBlockLabel } from '../lib/overlay.js';
import { blockColorVar, connectionTextureStyle, type TextureStyle } from '../lib/textures.js';
import { snapToSlot, minuteToHHMM, isSlotOccupied } from '../lib/create-click.js';
import { localISODate, addDays } from '../lib/dates.js';

// Minimum visible chip height (px). Display-only clamp — the stored duration is
// never altered, position math still uses the true minutes.
const MIN_CHIP_PX = 18;

// A pointer move under this many px is treated as a click (open the add wizard).
const CLICK_PX = 5;

/**
 * Width (px) of a container's thick coloured left edge. This is the Calendar's
 * stand-in for the Planner's solid category label cell (`CAT_WIDTH_PX = 104`):
 * both are the container's label region, and in both views a member chip is framed
 * in the *task region* to the right of it. The Planner's literal 104px cannot be
 * reused here — a week column floors at 7rem, so a 104px inset would leave ~8px of
 * chip — but the geometry (label cell on the left, members tiling the remainder) is
 * the same one, at Calendar scale.
 */
const CONTAINER_EDGE_PX = 15;

/** Gutter (px) kept to the right of each chip so neighbours don't touch. */
const CHIP_GAP_PX = 2;

/** A block placed in the overlap layout: vertical extent + horizontal column slot. */
export interface Placed {
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

/** A Time-Block container drawn on the minute axis. Matches the server's rule —
 * `isValidParent` only accepts `block_kind = 'timeblock'` as a parent — and the
 * Planner's `containers()`, so all three agree on what "container" means. */
const isContainer = (b: Pick<Block, 'block_kind' | 'all_day'>): boolean =>
  b.block_kind === 'timeblock' && isTimed(b);

/** A day's blocks split into the top-level pass and each container's members. */
export interface Containment {
  /** Containers + loose blocks. This pass alone drives conflict highlighting. */
  top: Block[];
  /** Container block id → the member blocks nested inside it. */
  membersOf: Map<string, Block[]>;
}

/**
 * Split a day's blocks into containers-and-loose (top level) versus members.
 *
 * A block is a member when its `parent_block_id` names a container **drawn on this
 * day**; an orphan whose parent isn't here stays top-level so it still renders
 * rather than vanishing. This is the Planner's `isNested` rule
 * (`Planner.tsx:731` — parent id ∈ the day's container ids), lifted so the Calendar
 * can draw the same containment instead of tiling a member beside its own
 * container and ringing the pair as a conflict.
 */
export function splitContainment(blocks: Block[]): Containment {
  const containerIds = new Set(blocks.filter(isContainer).map((b) => b.id));
  const top: Block[] = [];
  const membersOf = new Map<string, Block[]>();
  for (const b of blocks) {
    const pid = b.parent_block_id;
    if (pid != null && isTimed(b) && containerIds.has(pid)) {
      const siblings = membersOf.get(pid);
      if (siblings) siblings.push(b);
      else membersOf.set(pid, [b]);
    } else {
      top.push(b);
    }
  }
  return { top, membersOf };
}

/**
 * Inline left/width for a chip: tiled across the day column when it's top-level, or
 * framed inside its container's task region when it's a member. The nested branch
 * mirrors the Planner's `chipFrame` (`Planner.tsx:96`) — origin past the label cell,
 * the remaining region split into the chip's own overlap columns — with the
 * container's share of the column standing in for the Planner's full width.
 */
export function chipFrame(p: Placed, container?: Placed): { left: string; width: string } {
  if (!container) {
    return {
      left: `${(p.col / p.cols) * 100}%`,
      width: `calc(${100 / p.cols}% - ${CHIP_GAP_PX}px)`,
    };
  }
  const outerPct = 100 / container.cols;                    // container's width, % of the column
  const originPct = (container.col / container.cols) * 100; // container's left, % of the column
  const region = `(${outerPct}% - ${CONTAINER_EDGE_PX}px)`; // task region, right of the label edge
  return {
    left: `calc(${originPct}% + ${CONTAINER_EDGE_PX}px + ${p.col / p.cols} * ${region})`,
    width: `calc(${region} / ${p.cols} - ${CHIP_GAP_PX}px)`,
  };
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function dayLabel(dayStr: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(dayStr + 'T12:00:00Z').toLocaleDateString('en-US', opts);
}

// ── Now line: ticks every minute, only in today's column ──────────────────────
// Routed through the piecewise axis. If "now" falls inside a collapsed region we
// hide the line — its true position is not on the visible axis until you expand.
function NowLine(props: { day: string; state: () => AxisState }) {
  const [mins, setMins] = createSignal(minutesIntoDay(new Date().toISOString(), props.day));
  const t = setInterval(
    () => setMins(minutesIntoDay(new Date().toISOString(), props.day)),
    60_000,
  );
  onCleanup(() => clearInterval(t));
  // Only show when "now" lands in an expanded portion of the axis.
  const visible = () => {
    const m = mins();
    if (m < 0 || m > 24 * 60) return false;
    return visibleExtent(m, m + 1, props.state()) !== null;
  };
  return (
    <Show when={visible()}>
      <div
        class="absolute left-0 right-0 z-20 pointer-events-none"
        style={{ top: `${axisYOf(mins(), props.state(), PX_PER_MIN)}px` }}
      >
        <div class="h-px bg-accent-hi shadow-[0_0_6px_rgba(88,235,191,.6)]" />
        <div class="absolute -left-1 -top-[3px] w-[7px] h-[7px] rounded-full bg-accent-hi" />
      </div>
    </Show>
  );
}

// ── Block chip (time-axis positioned) ─────────────────────────────────────────
// Wave-3 interaction model (owner): the calendar is a *read/inspect* surface, not a
// drag surface. Drag + resize are Planner-only now. Two render modes here:
//   • TASK chip  → keeps its title; a click opens the task editor.
//   • CONTAINER  → label hidden; a thick 15px colored left edge stands in for it,
//                  revealing the name on hover (native `title`).
//   • CONTAINER  → additionally drawn as an OUTLINE (transparent fill, 2px border),
//                  so its members read as sitting inside it rather than on top of it.
//   • MEMBER     → framed in its container's task region via `container`, and laid
//                  out against its siblings only, so it can never ring as a conflict
//                  with the container it belongs to.
function BlockChip(props: { placed: Placed; day: string; state: () => AxisState; container?: Placed }) {
  const b = () => props.placed.block;
  // A configured connection colour wins over the block-kind palette: the owner set it
  // precisely so events from THIS calendar are identifiable at a glance.
  // Same colour source as the Planner's chips (`blockColorVar`: frozen color_token →
  // live category → tag hash), so a block does not change colour between Today and
  // Calendar. A configured connection colour still wins: it is a deliberate per-calendar
  // choice. The old `kindColor` palette was Calendar-only, which is what made the two
  // views disagree.
  const color = () => connectionColor(b()) ?? blockColorVar(b(), categoryPrefs()?.prefs);
  const texture = () => connectionTextureFor(b());
  // Conflict = sharing a cluster in the pass this chip was laid out in. Top-level
  // chips cluster against containers and loose blocks; a member clusters against its
  // SIBLINGS only — so two tasks double-booked inside one Time Block still ring, but
  // a member overlapping its own container never does. A foreign block overlapping a
  // member also overlaps that member's container, so the collision still surfaces —
  // on the container, which is the honest place for it.
  const conflict = () => props.placed.cols > 1;
  const done = () => ['completed', 'skipped'].includes(b().status);
  const isTask = () => isTaskBlock(b());
  const container = () => isContainer(b());
  // Phase 7 — stranded by a day-type change: alert red, distinct from the amber
  // overlap ring. A block can be both; the day-type conflict is the louder one.
  const stranded = () => conflictedBlockIds().has(b().id);
  const frame = () => chipFrame(props.placed, props.container);
  // Labelling is decided separately from interaction: a synced meeting shows its name
  // but is not clickable (there is no task behind it to open).
  const labelled = () => showsBlockLabel(b());

  // Clamp the block's [start, end) extent to the currently-visible portion of the
  // piecewise axis. `null` ⇒ the block sits entirely inside a collapsed region →
  // hidden until that region expands. A block straddling a boundary is trimmed to
  // its expanded part so it never bleeds into a thin bar.
  const extent = () => visibleExtent(props.placed.top, props.placed.top + props.placed.height, props.state());
  const topPx = () => axisYOf(extent()!.startMin, props.state(), PX_PER_MIN);
  const heightPx = () => {
    const e = extent()!;
    return Math.max(axisYOf(e.endMin, props.state(), PX_PER_MIN) - axisYOf(e.startMin, props.state(), PX_PER_MIN), MIN_CHIP_PX);
  };

  // Task chips open the task editor; the block links to its task via task_id.
  // Drawer layout: clicking a chip SELECTS it — the details drawer describes it
  // (and links to the task); the editor stays reachable from the drawer/Planner.
  // Every chip is selectable, not just task chips: a meeting has details too.
  function selectBlock(e: MouseEvent | KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    setActiveBlock(b().id);
    revealDetails();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      selectBlock(e);
    }
  }

  return (
   <Show when={extent()}>
    <div
      class="absolute overflow-hidden text-[11px] leading-tight transition-colors select-none"
      classList={{
        'opacity-40': done(),
        'ring-1 ring-amber-400/70': conflict() && !stranded(),
        'ring-2 ring-destructive': stranded(),
        'cursor-pointer': true,
        // A container is an outline box wrapping its members — no card fill to paint
        // over them, a 2px edge to read as an enclosure. Same treatment as the
        // Planner's ContainerOutline, so a Time Block looks the same in both views.
        'rounded-lg border-2': container(),
        'rounded-md border bg-card': !container(),
      }}
      style={{
        top: `${topPx()}px`,
        height: `${heightPx()}px`,
        left: frame().left,
        width: frame().width,
        // Solid card ground with the block colour on the border — the same treatment
        // the Planner chips use on Today, so one block reads identically in both views.
        // Previously a ~15% alpha tint, which made the same colour look weaker here.
        'border-color': color(),
        // The thick edge STANDS IN for a missing label, so it applies only to chips
        // that render no title. Anything showing its name keeps the slim accent, which
        // also leaves the width for the text to read cleanly.
        // CONTAINER_EDGE_PX is the same width a member chip insets past, so the edge
        // and the task region beside it always line up.
        'border-left-width': labelled() ? '3px' : `${CONTAINER_EDGE_PX}px`,
      }}
      // The name always lives in the tooltip. For a container the thick left edge is
      // the affordance the owner asked for; the whole chip carries `title` so a hover
      // anywhere over that narrow container reveals its name reliably.
      title={`${b().title} · ${fmtTime(b().start_at)}–${fmtTime(b().end_at)}`}
      // Task chips are keyboard-accessible buttons; containers are decorative only.
      role={isTask() ? 'button' : undefined}
      tabIndex={isTask() ? 0 : undefined}
      // Swallow pointerdown on ANY chip so a click on a block never falls through to
      // the empty-space `clickToCreate` handler (which arms on the day column's
      // pointerdown). Tasks additionally open their editor on click or Enter/Space.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={selectBlock}
      onKeyDown={handleKeyDown}
    >
      {/* Per-connection stripe texture, under the label. Absolutely positioned so it
          tints the chip without disturbing its own background-color. */}
      <Show when={texture()}>
        <div aria-hidden="true" style={texture()} />
      </Show>
      {/* Tasks and meetings keep their label — a calendar of unlabeled entries is
          unusable. Anonymous containers render no body text; the thick colored left
          edge is the label. `relative` lifts it above the texture overlay. */}
      <Show when={labelled()}>
        <div class="relative px-1.5 py-0.5">
          <div class="flex items-center gap-1 font-medium text-slate-100 truncate">
            <Show when={b().is_locked}><Lock size={9} class="text-slate-400 flex-shrink-0" /></Show>
            <span class="truncate">{b().title}</span>
          </div>
          <Show when={heightPx() >= 30}>
            <div class="text-slate-400 truncate">{fmtTime(b().start_at)}</div>
          </Show>
        </div>
      </Show>
    </div>
   </Show>
  );
}

// ── All-day chip (pinned header lane; not on the minute axis) ──────────────────
function AllDayChip(props: { block: Block }) {
  const color = () => connectionColor(props.block) ?? blockColorVar(props.block, categoryPrefs()?.prefs);
  const texture = () => connectionTextureFor(props.block);
  const done = () => ['completed', 'skipped'].includes(props.block.status);
  return (
    <div
      class="relative overflow-hidden rounded px-1.5 py-0.5 text-[10px] leading-tight truncate border-l-2 bg-card"
      classList={{ 'opacity-40': done() }}
      style={{
        // Matches the timed chips and the Planner: no alpha tint on the fill.
        'border-left-color': color(),
      }}
      title={props.block.title}
    >
      <Show when={texture()}>
        <div aria-hidden="true" style={texture()} />
      </Show>
      <span class="relative text-slate-200">{props.block.title}</span>
    </div>
  );
}

// ── Per-connection styling ────────────────────────────────────────────────────
// A block mirrored from a connected calendar can carry an owner-chosen colour and
// stripe texture, keyed by `provider:account`. Both resolve to undefined for locally
// created blocks and for connections the owner hasn't configured, so the default look
// is untouched until a choice is made.

function connectionPrefOf(b: Block) {
  if (!b.source_provider || !b.source_account) return undefined;
  return connectionPrefs()?.prefs[`${b.source_provider}:${b.source_account}`];
}

function connectionColor(b: Block): string | undefined {
  const token = connectionPrefOf(b)?.color_token;
  return token ? `var(--${token})` : undefined;
}

function connectionTextureFor(b: Block): TextureStyle | undefined {
  const pref = connectionPrefOf(b);
  if (!pref) return undefined;
  return connectionTextureStyle(pref.texture, `var(--${pref.color_token})`);
}

// An hour label/line is drawn only when its minute lies in an EXPANDED region
// (a collapsed region shows nothing but its expander bar). Boundary hours 07:00
// and 21:00 always sit on an expanded edge, so they render.
function visibleHours(state: AxisState): number[] {
  return Array.from({ length: 24 }, (_, h) => h).filter((h) => {
    const m = h * 60;
    if (m === TOP_COLLAPSE_END || m === BOTTOM_COLLAPSE_START) return true;
    return visibleExtent(m, m + 1, state) !== null;
  });
}

// ── Time gutter (hour labels) ─────────────────────────────────────────────────
function TimeGutter(props: { state: () => AxisState; class?: string }) {
  return (
    <div class={`relative ${props.class ?? ''}`} style={{ height: `${axisHeightPx(props.state(), PX_PER_MIN)}px` }}>
      <For each={visibleHours(props.state())}>
        {(h) => (
          <div
            class="absolute right-1.5 -translate-y-1/2 text-[10px] text-slate-500 font-mono tabular-nums"
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

// ── Hour gridlines for a day column ───────────────────────────────────────────
function HourLines(props: { state: () => AxisState }) {
  return (
    <For each={visibleHours(props.state())}>
      {(h) => (
        <div
          class="absolute left-0 right-0 border-t border-surface-700/50"
          style={{ top: `${axisYOf(h * 60, props.state(), PX_PER_MIN)}px` }}
        />
      )}
    </For>
  );
}

// ── Expander bar for a collapsed/expanded region ──────────────────────────────
// One thin clickable bar per collapsible region, spanning the full width of the
// time grid (gutter + all day columns). Collapsed → "▸ label"; expanded → "▾".
// Positioned absolutely at the region's segment top so it overlays the (empty)
// collapsed band or sits flush at the region's expanded edge.
function ExpanderBar(props: {
  region: 'top' | 'bottom';
  label: string;
  state: () => AxisState;
  onToggle: () => void;
}) {
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
      class="absolute left-0 right-0 z-10 flex items-center gap-1 px-1.5 text-[10px] text-slate-400 bg-surface-800/95 hover:bg-surface-700/70 border-y border-surface-700/60 transition-colors overflow-hidden"
      style={{
        top: `${seg().topPx}px`,
        // A collapsed bar fills its whole (thin) segment; an expanded region's bar
        // is a slim strip at the top so it never eats the newly-revealed hours.
        height: expanded() ? '16px' : `${seg().heightPx}px`,
      }}
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

interface Props {
  /** 'day' | 'week' → time-axis grid over `days`; 'month' → 6×7 cell renderer. */
  view: 'day' | 'week' | 'month';
  /** Visible local days (YYYY-MM-DD). Day=1, Week=7, Month=42. */
  days: string[];
  /** Blocks already fetched for the visible range, grouped by local day. */
  blocksByDay: () => Record<string, Block[]>;
  /** Click an empty slot → open the Add Element wizard at (day, HH:MM). */
  onCreateAt?: (day: string, hhmm: string) => void;
  /** Phase O · O1 — local dates (YYYY-MM-DD) that have a day note; renders a dot. */
  notedDays?: () => Set<string>;
  /** Click a date's note dot → open that day's note. */
  onOpenNote?: (day: string) => void;
  /** Phase O · O3 — per-date star tally (month view heatmap). date → DayStar. */
  starsByDay?: () => Record<string, DayStar>;
  /** Wave-3 item 5 — the currently selected date (drives the day-type picker), or null. */
  selectedDate?: () => string | null;
  /** Wave-3 item 5 — select a date (week header / month cell number) to set its day type. */
  onSelectDate?: (day: string) => void;
}

export function CalendarGrid(props: Props) {
  const today = () => localISODate();

  // Every day column has a floor, so a narrow viewport SCROLLS the week instead of
  // squeezing it. Seven `1fr` columns in a 360px viewport resolve to ~35px each, which
  // is narrower than one word: every chip degraded to a single letter ("W…", "D", "1.")
  // and the week was unreadable on a phone. 7rem is the width at which a chip shows a
  // readable fragment plus its start time.
  //
  // Desktop is untouched: `1fr` beats the 7rem floor at any width above ~840px, which is
  // every desktop layout this grid ships in, so `minmax()` resolves to exactly what
  // `1fr` did. Day view keeps a plain `1fr` — one column can always have the full width.
  const DAY_COL_MIN = '7rem';
  const gridCols = () =>
    props.days.length > 1
      ? `3.5rem repeat(${props.days.length}, minmax(${DAY_COL_MIN}, 1fr))`
      : `3.5rem repeat(${props.days.length}, 1fr)`;

  // The tracks alone overflowing is not enough: a block-level grid inside the
  // overflow-auto port is still only as WIDE as the port, and `position: sticky` cannot
  // hold outside its own containing block — the gutter scrolled away with the content
  // until this was added. An explicit min-width the same size as the track floor makes
  // the grid box match its tracks. Stated in `calc` rather than `min-content`/`max-content`
  // so a long all-day chip title can never widen a column beyond the floor.
  const gridMinW = () =>
    props.days.length > 1 ? `calc(3.5rem + ${props.days.length} * ${DAY_COL_MIN})` : undefined;

  // The hour axis and the header's empty corner stick to the left edge of the scroll
  // port, so scrolling across the week never leaves you looking at unlabelled columns —
  // the failure mode that made the committed week frame unreadable in the first place.
  // z-[5] keeps the gutter above the day columns (which are `relative`, z auto) and
  // below the full-width ExpanderBar at z-10, whose chevron sits over the gutter.
  const STICKY_GUTTER = 'sticky left-0 z-[5] bg-surface-800';

  // Wave-3 item 6 — collapse the quiet night hours. The piecewise day axis is driven
  // by a shared store signal (0111) so the collapse state PERSISTS cross-device and
  // stays in lockstep across all week columns; default = BOTH collapsed. Calendar
  // view only — the Planner keeps the plain linear axis.
  const axisState = calendarAxisState;

  // Click-to-create on empty grid space. BlockChip gestures stopPropagation, so only
  // empty space reaches here. A near-zero pointer move = a click; map Y → time via the
  // piecewise axis (a click on a collapsed bar clamps to that region's expanded edge),
  // then snap to 15 min.
  function clickToCreate(e: PointerEvent, day: string) {
    if (!props.onCreateAt) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', onUp);
      if (Math.abs(ev.clientX - startX) >= CLICK_PX || Math.abs(ev.clientY - startY) >= CLICK_PX) return;
      // snapToSlot rounds the (possibly fractional) minute before the 15-min snap
      // so we don't bias earlier, and caps at the last valid slot 23:45 — axisMinAt
      // can return 1440 at the bottom edge, which would roll to the next day.
      const snapped = snapToSlot(axisMinAt(ev.clientY - rect.top, axisState(), PX_PER_MIN));
      // AB3 open-window rule: a snapped time inside an ACTIVE block's span is a
      // no-op — chips swallow their own pointerdown (tap-to-edit is untouched), so
      // this catches the snap landing back inside a span from nearby empty space.
      if (isSlotOccupied(props.blocksByDay()[day] ?? [], day, snapped)) return;
      props.onCreateAt!(day, minuteToHHMM(snapped));
    };
    window.addEventListener('pointerup', onUp);
  }

  // Time-axis views (day + week) share the same renderer.
  //
  // The port needs an explicit MAX-HEIGHT, not just `overflow-auto`. Without one the
  // grid is as tall as its content, so nothing ever scrolls inside the port — the
  // whole card scrolls up the *page* instead, and `sticky top-0` on the day-of-week
  // header pins it to the top of a box that is itself leaving the screen. Scrolling
  // to the afternoon in week view therefore left seven unlabelled columns: the exact
  // vertical twin of the horizontal failure STICKY_GUTTER above was added to fix.
  // Capping the port makes it the scrollport, so the header actually stays put.
  const TimeAxis = () => (
    <div class="overflow-auto rounded-xl border border-surface-700 bg-surface-800 max-h-[calc(100vh-13rem)]">
      {/* Day-of-week header */}
      <div
        class="grid sticky top-0 z-30 bg-surface-800/95 backdrop-blur border-b border-surface-700"
        style={{ 'grid-template-columns': gridCols(), 'min-width': gridMinW() }}
      >
        <div class={STICKY_GUTTER} />
        <For each={props.days}>
          {(day) => (
            <div
              class="py-2 text-center border-l border-surface-700/60"
              classList={{ 'text-accent-light': day === today() }}
            >
              {/* Wave-3 item 5: the day name+number is a button — click to select this
                  date and set its day type. It lives in the header lane, not the time
                  grid, so it never competes with the empty-slot add-task handler. */}
              <button
                type="button"
                aria-pressed={props.selectedDate?.() === day}
                title={props.onSelectDate ? 'Select this date to set its day type' : undefined}
                class="mx-auto flex flex-col items-center rounded-md px-2 py-0.5 transition-colors"
                classList={{
                  'cursor-pointer hover:bg-surface-700/60': !!props.onSelectDate,
                  'ring-1 ring-accent bg-accent/10': props.selectedDate?.() === day,
                }}
                onClick={() => {
                  props.onSelectDate?.(day);
                  // Additive: the drawer's Day panel opens alongside the existing
                  // day-type flow, matching the mockup's day-header selection.
                  setActiveEntity('day', day);
                  revealDetails();
                }}
              >
                <div class="text-[10px] uppercase tracking-wide text-slate-500">
                  {dayLabel(day, { weekday: 'short' })}
                </div>
                <div class="text-sm font-semibold" classList={{ 'text-slate-200': day !== today() }}>
                  {dayLabel(day, { day: 'numeric' })}
                </div>
              </button>
              <Show when={props.notedDays?.().has(day)}>
                <button
                  class="text-slate-400 hover:text-accent-light transition-colors mt-0.5"
                  title="This day has a note"
                  onClick={() => props.onOpenNote?.(day)}
                >
                  <NotebookPen size={11} />
                </button>
              </Show>
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
          style={{ 'grid-template-columns': gridCols(), 'min-width': gridMinW() }}
        >
          <div class={`${STICKY_GUTTER} flex items-start justify-end pr-1.5 pt-1 text-[9px] uppercase tracking-wide text-slate-500`}>
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

      {/* Time grid. The whole grid is `position: relative` so the two full-width
          expander bars can overlay across the gutter + every day column. */}
      <div
        class="grid relative"
        style={{ 'grid-template-columns': gridCols(), 'min-width': gridMinW() }}
      >
        <TimeGutter state={axisState} class={STICKY_GUTTER} />
        <For each={props.days}>
          {(day) => {
            // Two passes, as the Planner does it: containers + loose blocks tile the
            // column, then each container's members lay out (and overlap-cluster)
            // inside that container alone. Before this split a member was swept into
            // its own container's cluster, tiled beside it, and — since `cols > 1` is
            // the conflict signal — ringed amber as if nested were a collision.
            const split = createMemo(() => splitContainment(props.blocksByDay()[day] ?? []));
            const placed = createMemo(() => layoutBlocks(split().top, day));
            const nested = createMemo(() =>
              placed().flatMap((c) => {
                const members = split().membersOf.get(c.block.id);
                if (!members?.length) return [];
                return layoutBlocks(members, day).map((m) => ({ placed: m, container: c }));
              }),
            );
            return (
              <div
                class="relative border-l border-surface-700/60"
                classList={{ 'cursor-pointer': !!props.onCreateAt }}
                style={{ height: `${axisHeightPx(axisState(), PX_PER_MIN)}px` }}
                title={props.onCreateAt ? 'Click an empty slot to add' : undefined}
                onPointerDown={(e) => clickToCreate(e, day)}
              >
                <HourLines state={axisState} />
                <For each={placed()}>
                  {(p) => <BlockChip placed={p} day={day} state={axisState} />}
                </For>
                {/* Members render after their containers so they paint inside the
                    outline rather than under it. */}
                <For each={nested()}>
                  {(n) => <BlockChip placed={n.placed} day={day} state={axisState} container={n.container} />}
                </For>
                <Show when={day === today()}>
                  <NowLine day={day} state={axisState} />
                </Show>
              </div>
            );
          }}
        </For>
        {/* Full-width expander bars, positioned over both night regions. */}
        <ExpanderBar
          region="top"
          label="12am – 7am"
          state={axisState}
          onToggle={() => toggleCalendarTop()}
        />
        <ExpanderBar
          region="bottom"
          label="9pm – 12am"
          state={axisState}
          onToggle={() => toggleCalendarBottom()}
        />
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
            // Phase O · O3 — the star heatmap for this cell.
            const stars = () => props.starsByDay?.()[day];
            const perfect = () => { const s = stars(); return !!s && isPerfectDay(s.total); };
            return (
              <div
                class="min-h-[6rem] p-1.5 border-l border-t border-surface-700/40 first:border-l-0"
                classList={{
                  'opacity-45': !inMonth(),
                  'border-t-0': i() < 7,
                  'cursor-pointer': !!props.onCreateAt,
                  'ring-1 ring-inset ring-accent': props.selectedDate?.() === day,
                }}
                // Perfect day (5/5): tint the whole cell gold — the heatmap payoff.
                style={perfect() ? { 'background-color': `${STAR_GOLD}1a`, 'border-color': `${STAR_GOLD}66` } : undefined}
                title={props.onCreateAt ? 'Click to add' : undefined}
                onClick={() => props.onCreateAt?.(day, '09:00')}
              >
                <div class="flex items-center justify-between mb-1">
                  {/* Wave-3 item 5: the date number selects this date (to set its day
                      type). stopPropagation keeps the cell's empty-space add-task click
                      from also firing. */}
                  <button
                    type="button"
                    aria-pressed={props.selectedDate?.() === day}
                    title={props.onSelectDate ? 'Select this date to set its day type' : undefined}
                    class="text-xs font-mono tabular-nums rounded transition-colors"
                    classList={{
                      'text-slate-400': inMonth() && !isToday(),
                      'text-slate-600': !inMonth(),
                      'inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-surface-950 font-semibold': isToday(),
                      'hover:bg-surface-700/60': !!props.onSelectDate && !isToday(),
                    }}
                    onClick={(e) => {
                      // Only intercept the click when selection is wired; otherwise let it
                      // bubble to the cell so onCreateAt (add-task) still fires as before.
                      if (!props.onSelectDate) return;
                      e.stopPropagation();
                      props.onSelectDate(day);
                    }}
                  >
                    {dayLabel(day, { day: 'numeric' })}
                  </button>
                  <div class="flex items-center gap-1">
                    {/* Star heatmap: a perfect day collapses to one glowing star; else up to 5 gold pips. */}
                    <Show
                      when={stars() && stars()!.total > 0}
                    >
                      <Show
                        when={perfect()}
                        fallback={
                          <span class="flex items-center gap-[1px]" title={`${stars()!.total} of 5 stars`}>
                            <For each={Array.from({ length: pipCount(stars()!.total) })}>
                              {() => <span class="w-1 h-1 rounded-full" style={{ 'background-color': STAR_GOLD }} />}
                            </For>
                          </span>
                        }
                      >
                        <span title="Perfect day — 5 of 5 stars" class="drop-shadow-[0_0_4px_rgba(244,211,94,0.8)]">
                          <Star size={12} color={STAR_GOLD} fill={STAR_GOLD} />
                        </span>
                      </Show>
                    </Show>
                    <Show when={props.notedDays?.().has(day)}>
                      <button
                        class="text-slate-400 hover:text-accent-light transition-colors"
                        title="This day has a note"
                        onClick={(e) => { e.stopPropagation(); props.onOpenNote?.(day); }}
                      >
                        <NotebookPen size={11} />
                      </button>
                    </Show>
                    <Show when={dayBlocks().length > 0}>
                      <span class="text-[10px] text-slate-500">{dayBlocks().length}</span>
                    </Show>
                  </div>
                </div>
                <div class="flex flex-col gap-0.5">
                  <For each={dayBlocks().slice(0, MAX_CHIPS)}>
                    {(b) => (
                      <div
                        class="text-[10px] leading-tight truncate rounded px-1 py-0.5 bg-card"
                        style={{
                          'border-left': `2px solid ${blockColorVar(b, categoryPrefs()?.prefs)}`,
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
