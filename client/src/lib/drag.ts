/**
 * Drag-to-move + edge-resize gesture logic for the calendar grid (Phase F PR-2).
 *
 * The *pure* parts (gesture resolution, the optimistic override map) live here so
 * they're unit-testable in the node vitest harness without a DOM. The component
 * (`CalendarGrid.tsx`) wires pointer events to `resolveGesture` + `commitDrag`.
 *
 * No-tz-drift is structural: new instants are *only* ever produced by
 * `instantFor` (the exact inverse of `minutesIntoDay`), never by wall-clock string
 * arithmetic. A 0-distance drag therefore PATCHes a byte-identical instant.
 */

import { createSignal } from 'solid-js';
import { SNAP_MIN, minutesIntoDay, instantFor, minsOf } from './grid.js';
import type { Block } from './api.js';
import { api } from './api.js';

/** What part of a chip a pointer-down landed on. */
export type GestureMode = 'move' | 'resize-top' | 'resize-bottom';

/** A resolved gesture: the new times to persist, or null if the gesture is rejected. */
export interface ResolvedGesture {
  start_at: string;
  end_at: string;
}

/** Height (px) of the top/bottom resize handles on a chip. */
export const HANDLE_PX = 6;

/** Minimum block duration (minutes). Resize clamps to this; it never inverts. */
export const MIN_DURATION_MIN = SNAP_MIN;

/** A neighbouring block reduced to its day-minute extent — the clamp input. */
export interface Neighbour { topMin: number; botMin: number }

/**
 * Clamp a rigid move (`deltaMin`) so the block `[topMin, botMin]` never *increases*
 * its overlap with any neighbour ("don't worsen" policy). Pure, in minute space.
 *
 * A neighbour the block doesn't currently touch is a hard wall (it can't be entered).
 * A neighbour it already overlaps doesn't block movement that keeps/reduces the
 * overlap, but a shift that would deepen it is forbidden (clamped to 0). Returns the
 * clamped signed delta in the requested direction.
 */
export function clampMoveDelta(topMin: number, botMin: number, deltaMin: number, neighbours: Neighbour[]): number {
  if (deltaMin === 0 || neighbours.length === 0) return deltaMin;
  if (deltaMin > 0) {
    // Moving DOWN (later): the bottom edge leads.
    let cap = deltaMin;
    for (const n of neighbours) {
      if (botMin <= n.topMin) cap = Math.min(cap, n.topMin - botMin);          // wall: block sits entirely above n
      else if (topMin >= n.botMin) continue;                                    // n is above the block — irrelevant going down
      else if (botMin < n.botMin && topMin < n.topMin) cap = 0;                 // already overlapping & would deepen
    }
    return Math.max(0, cap);
  }
  // Moving UP (earlier): the top edge leads.
  let cap = -deltaMin; // positive magnitude
  for (const n of neighbours) {
    if (topMin >= n.botMin) cap = Math.min(cap, topMin - n.botMin);            // wall: block sits entirely below n
    else if (botMin <= n.topMin) continue;                                      // n is below the block — irrelevant going up
    else if (topMin > n.topMin && botMin > n.botMin) cap = 0;                   // already overlapping & would deepen
  }
  return -Math.max(0, cap);
}

/** Clamp a resize-bottom (`newBot`) so extending DOWN never increases overlap. */
function clampResizeBottom(topMin: number, botMin: number, newBot: number, neighbours: Neighbour[]): number {
  if (newBot <= botMin || neighbours.length === 0) return newBot; // shrinking never worsens
  let ceil = newBot;
  for (const n of neighbours) {
    if (botMin <= n.topMin) ceil = Math.min(ceil, n.topMin);       // wall below
    else if (topMin >= n.botMin) continue;                          // n above — irrelevant
    else if (botMin < n.botMin) ceil = Math.min(ceil, botMin);     // already overlapping → no further extension
  }
  return Math.min(newBot, ceil);
}

/** Clamp a resize-top (`newTop`) so extending UP never increases overlap. */
function clampResizeTop(topMin: number, botMin: number, newTop: number, neighbours: Neighbour[]): number {
  if (newTop >= topMin || neighbours.length === 0) return newTop; // shrinking never worsens
  let floor = newTop;
  for (const n of neighbours) {
    if (topMin >= n.botMin) floor = Math.max(floor, n.botMin);     // wall above
    else if (botMin <= n.topMin) continue;                          // n below — irrelevant
    else if (topMin > n.topMin) floor = Math.max(floor, topMin);   // already overlapping → no further extension
  }
  return Math.max(newTop, floor);
}

/**
 * A block is immovable when locked or when it is an externally-owned meeting.
 * Such a block must never start a gesture and never emit a PATCH.
 */
export function isImmovable(block: Pick<Block, 'is_locked' | 'block_kind'>): boolean {
  return !!block.is_locked || block.block_kind === 'meeting';
}

/**
 * Resolve a pointer gesture into the new `{start_at, end_at}` to persist.
 *
 * `dyPx` is the total vertical pixel delta from pointer-down to the current/up
 * position. The delta is converted to a *snapped minute* delta via the same
 * `minsOf` used everywhere, then applied to the gesture's edge(s). The result is
 * rebuilt with `instantFor` so it is the exact inverse of the chip's position —
 * a 0px move yields the block's original instants byte-for-byte.
 *
 * Returns `null` for immovable blocks (locked / meeting): the caller must not
 * PATCH. Resize clamps to `MIN_DURATION_MIN` and never inverts the block.
 */
export function resolveGesture(
  block: Block,
  day: string,
  mode: GestureMode,
  dyPx: number,
  neighbours: Neighbour[] = [],
): ResolvedGesture | null {
  if (isImmovable(block)) return null;

  // Current edges as local minutes-into-day (real elapsed ms — DST-safe).
  const topMin = minutesIntoDay(block.start_at, day);
  const botMin = minutesIntoDay(block.end_at, day);

  // Snap the pixel delta to a minute delta. minsOf(yOf(0)) === 0, so a 0px drag
  // is a 0-minute delta and round-trips to the identical instant.
  const dMin = minsOf(dyPxToY(dyPx));

  let newTop = topMin;
  let newBot = botMin;

  // The collision clamp runs in the same snapped minute space and composes with the
  // MIN_DURATION / no-invert clamps. `neighbours` default [] → behaviour-identical to
  // before, so existing callers/tests are byte-for-byte unchanged.
  if (mode === 'move') {
    const cd = clampMoveDelta(topMin, botMin, dMin, neighbours);
    newTop = topMin + cd;
    newBot = botMin + cd;
  } else if (mode === 'resize-top') {
    // Drag the top edge; clamp so it can't reach within MIN_DURATION of the bottom,
    // then clamp against a neighbour above (never crossing into it).
    newTop = Math.min(topMin + dMin, botMin - MIN_DURATION_MIN);
    newTop = clampResizeTop(topMin, botMin, newTop, neighbours);
  } else {
    // resize-bottom: clamp so it can't reach within MIN_DURATION of the top, then
    // clamp against a neighbour below.
    newBot = Math.max(botMin + dMin, topMin + MIN_DURATION_MIN);
    newBot = clampResizeBottom(topMin, botMin, newBot, neighbours);
  }

  return {
    start_at: instantFor(day, newTop),
    end_at: instantFor(day, newBot),
  };
}

/**
 * The pixel delta is already in y-space (1px = 1px); `minsOf` expects a y value.
 * Kept as a named hop so the units are explicit at the call site.
 */
function dyPxToY(dyPx: number): number {
  return dyPx;
}

/**
 * The clamped minute delta for a LIVE gesture preview — the same per-mode clamp as
 * `resolveGesture` (min-duration, no-invert, neighbour collision) but WITHOUT grid
 * snapping, so the chip follows the cursor smoothly yet still visibly stops at a
 * neighbour's edge *during* the drag. Returns the signed minute delta to apply to the
 * dragged edge(s). The pointer-up commit still goes through `resolveGesture` (snap →
 * clamp), so the committed result lands on the grid; this only drives the preview.
 */
export function clampLiveDelta(
  block: Block,
  day: string,
  mode: GestureMode,
  dMin: number,
  neighbours: Neighbour[] = [],
): number {
  const topMin = minutesIntoDay(block.start_at, day);
  const botMin = minutesIntoDay(block.end_at, day);
  if (mode === 'move') return clampMoveDelta(topMin, botMin, dMin, neighbours);
  if (mode === 'resize-top') {
    let newTop = Math.min(topMin + dMin, botMin - MIN_DURATION_MIN);
    newTop = clampResizeTop(topMin, botMin, newTop, neighbours);
    return newTop - topMin; // clamped top-edge delta
  }
  let newBot = Math.max(botMin + dMin, topMin + MIN_DURATION_MIN);
  newBot = clampResizeBottom(topMin, botMin, newBot, neighbours);
  return newBot - botMin; // clamped bottom-edge delta
}

// ── Optimistic override map ────────────────────────────────────────────────────
// During/after a gesture the chip shows the dragged-to times immediately; the
// authoritative row arrives later on the `block:updated` SSE refetch and
// supersedes the override (cleared, idempotently, by block id).

const [overrides, setOverrides] = createSignal<Record<string, ResolvedGesture>>({});
export { overrides };

/** Apply (or replace) the optimistic override for a block. */
export function setOverride(id: string, patch: ResolvedGesture): void {
  setOverrides((prev) => ({ ...prev, [id]: patch }));
}

/** Clear a block's override. Idempotent: clearing an absent id is a no-op. */
export function clearOverride(id: string): void {
  setOverrides((prev) => {
    if (!(id in prev)) return prev;
    const next = { ...prev };
    delete next[id];
    return next;
  });
}

/** The block as the user should see it right now: authoritative row + any override. */
export function effectiveBlock(block: Block): Block {
  const o = overrides()[block.id];
  return o ? { ...block, start_at: o.start_at, end_at: o.end_at } : block;
}

// ── The commit loop (drag → optimistic → PATCH → SSE / rollback) ───────────────

export interface CommitDeps {
  /** PATCH the block; defaults to the real API. Injectable for tests. */
  update?: (id: string, body: Partial<Block>) => Promise<unknown>;
  /** Surface an error (toast); injectable for tests. */
  onError?: (message: string) => void;
}

/**
 * Commit a resolved gesture: set the optimistic override, emit exactly ONE PATCH,
 * and roll the override back (with an error toast) if the PATCH fails. On success
 * the override stands until the `block:updated` SSE refetch supersedes it.
 *
 * Returns `false` without any PATCH for immovable blocks or a resolved gesture of
 * `null`. Returns `true` once the PATCH resolves (or has been rolled back).
 */
export async function commitDrag(
  block: Block,
  resolved: ResolvedGesture | null,
  deps: CommitDeps = {},
): Promise<boolean> {
  if (isImmovable(block) || !resolved) return false;

  const update = deps.update ?? ((id, body) => api.blocks.update(id, body));

  setOverride(block.id, resolved);
  try {
    await update(block.id, { start_at: resolved.start_at, end_at: resolved.end_at });
    return true;
  } catch (err) {
    clearOverride(block.id);
    deps.onError?.((err as Error).message);
    return true;
  }
}
