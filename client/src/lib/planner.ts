/**
 * Pure helpers for the PLANNER (Phase G, G6). The view (`Planner.tsx`) renders the
 * full day on the tz-safe grid math from `grid.ts` inside a windowed scroll
 * container; these functions decide the **next-up** item and where to scroll so it
 * sits pinned to the second slot. Kept pure + DOM-free so they're unit-testable in
 * the node vitest harness, like `grid.ts`/`drag.ts`.
 */
import { minutesIntoDay, PX_PER_MIN } from './grid.js';

/** Default visible window: 8 hours tall (design §6); a control expands it to 24h. */
export const VISIBLE_HOURS = 8;

/** One "slot" of context kept above the next-up item, so it reads as row 2. */
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
 * The scrollTop (px) that pins a next-up item to the second slot: keep `SLOT_MIN`
 * minutes of context above it, clamped at the top of the day. `nextUpStartMin` is
 * minutes-into-day of the next-up block's start.
 */
export function nextUpScrollTopPx(nextUpStartMin: number, slotMin = SLOT_MIN): number {
  return Math.max(0, (nextUpStartMin - slotMin) * PX_PER_MIN);
}

/** Convenience: scrollTop for a next-up block, computed in the column's local day. */
export function scrollTopForBlock(block: TimedLike | undefined, day: string): number {
  if (!block) return 0;
  return nextUpScrollTopPx(minutesIntoDay(block.start_at, day));
}
