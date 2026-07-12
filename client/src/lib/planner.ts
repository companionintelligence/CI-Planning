/**
 * Pure helpers for the PLANNER (Phase G, G6). The view (`Planner.tsx`) renders the
 * WHOLE day on the piecewise **segmented day axis** (`day-axis.ts`) — the quiet
 * night hours (00:00–07:00, 21:00–24:00) collapse to thin, expandable bars so the
 * entire day is always reachable with no inner scroll and no zoom control (this
 * replaced the old 4/8/16h clipped zoom window). These functions decide the
 * **next-up** item and provide the segmented coordinate helpers the view needs
 * (band projection, drag-delta conversion across a collapsed bar). Kept pure +
 * DOM-free so they're unit-testable in the node vitest harness, like
 * `grid.ts`/`drag.ts`/`day-axis.ts`.
 */
import { type AxisState, minAt, yOf, visibleExtent } from './day-axis.js';

/** One "slot" of context — retained for callers that still reason about a lead-in. */
export const SLOT_MIN = 60;

/** The minimal shape the next-up pick needs from a block. */
export interface TimedLike {
  start_at: string;
  end_at: string;
  status: string;
}

const DONE = new Set(['completed', 'skipped', 'cancelled']);

/**
 * The "next up" item: the earliest still-actionable block whose end is in the
 * future. Done/skipped/cancelled blocks are ignored. Returns `undefined` when the
 * day is empty or fully behind us. Input order doesn't matter — it sorts by start.
 */
export function pickNextUp<T extends TimedLike>(items: T[], nowISO: string): T | undefined {
  const now = Date.parse(nowISO);
  return items
    .filter((b) => !DONE.has(b.status) && Date.parse(b.end_at) > now)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))[0];
}

/**
 * Project a linear [startMin, endMin) minute extent onto the SEGMENTED axis,
 * returning `{ topPx, heightPx }` — or `null` when the extent lies entirely inside
 * a currently-collapsed region (so the caller hides it until that region expands).
 * A boundary-spanning extent is trimmed to its visible portion via `visibleExtent`,
 * so it never bleeds into a thin bar. The single seam the Planner uses to place
 * blocks, band overlays, and the direction column on the collapsible axis.
 */
export function segmentExtentPx(
  startMin: number,
  endMin: number,
  state: AxisState,
  pxPerMin: number,
): { topPx: number; heightPx: number } | null {
  const ext = visibleExtent(startMin, endMin, state);
  if (!ext) return null;
  const topPx = yOf(ext.startMin, state, pxPerMin);
  const heightPx = yOf(ext.endMin, state, pxPerMin) - topPx;
  return { topPx, heightPx };
}

/**
 * AF-11 — the tag a task-bound block created from the grid inherits: the task's
 * PRIMARY (level-1) tag. Post-split, `task.tags` is level-1 only — i.e. the single
 * direction — so `tags[0]` IS the direction (pre-split it could be whichever flat
 * tag sorted first). Intentions live in `secondary_tags` and are deliberately not
 * inherited onto the block's tag mirror. Returns undefined for an unknown or
 * direction-less task (the block is created untagged).
 */
export function inheritedBlockTag(task: { tags?: string[] } | undefined): string | undefined {
  return task?.tags?.[0];
}

/**
 * The SNAPPED-FREE minute delta of a drag on the segmented axis. A pixel delta
 * `dyPx` cannot be divided by `pxPerMin` to get minutes once a night region is
 * collapsed (the thin bar is not to scale), so we derive the delta from the two
 * pointer *positions* instead: `minAt(startY + dyPx) - minAt(startY)`. Inside a
 * single expanded region this equals the old `dyPx / pxPerMin` exactly; across a
 * collapse boundary `minAt` clamps to the region's expanded edge, so the delta maps
 * sanely (the block can't be dragged into hidden time). Pure + tested; the caller
 * still runs the result through the existing snap + collision clamp.
 */
export function dragDeltaMin(startY: number, dyPx: number, state: AxisState, pxPerMin: number): number {
  return minAt(startY + dyPx, state, pxPerMin) - minAt(startY, state, pxPerMin);
}
