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

  if (mode === 'move') {
    newTop = topMin + dMin;
    newBot = botMin + dMin;
  } else if (mode === 'resize-top') {
    // Drag the top edge; clamp so it can't reach within MIN_DURATION of the bottom.
    newTop = Math.min(topMin + dMin, botMin - MIN_DURATION_MIN);
  } else {
    // resize-bottom: clamp so it can't reach within MIN_DURATION of the top.
    newBot = Math.max(botMin + dMin, topMin + MIN_DURATION_MIN);
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

// ── Optimistic override map ────────────────────────────────────────────────────
// During/after a gesture the chip shows the dragged-to times immediately; the
// authoritative row arrives later on the `block:updated` SSE refetch and
// supersedes the override (cleared, idempotently, by block id).

const [overrides, setOverrides] = createSignal<Record<number, ResolvedGesture>>({});
export { overrides };

/** Apply (or replace) the optimistic override for a block. */
export function setOverride(id: number, patch: ResolvedGesture): void {
  setOverrides((prev) => ({ ...prev, [id]: patch }));
}

/** Clear a block's override. Idempotent: clearing an absent id is a no-op. */
export function clearOverride(id: number): void {
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
  update?: (id: number, body: Partial<Block>) => Promise<unknown>;
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
