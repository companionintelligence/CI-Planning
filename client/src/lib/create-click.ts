/**
 * Phase AB · AB3 — click-to-create slot math, shared by the Calendar grid and the
 * Planner. Pure + framework-free so the snap and the open-window rule are
 * unit-testable in the node env (no jsdom).
 *
 * The open-window rule (owner decision 3, docs/AB-natural-scheduling.md): a click
 * whose SNAPPED time falls inside any active block's span is a no-op for create —
 * any free hour of the day is allowed (no workday restriction), but you can't
 * stack a new block onto an occupied slot by clicking. Block chips keep their own
 * open/edit tap behaviour (they swallow pointerdown before the grid sees it);
 * this guard catches the snap landing inside a span anyway — e.g. a click just
 * above a chip snapping back into it, or a click in an overlap cluster's empty
 * column.
 */
import type { Block } from './api.js';
import { minutesIntoDay, MINUTES_PER_DAY } from './grid.js';
import { isAllDay } from './overlay.js';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Snap a (possibly fractional) minute-of-day to its slot: round before flooring
 * so we don't bias earlier, clamp into the day, and cap at the LAST valid slot
 * (23:45 for 15-min slots) — the axis inverse can return 1440 at the bottom
 * edge, which would render as 24:00 and roll to the next day.
 */
export function snapToSlot(mins: number, snapMin = 15): number {
  const snapped = Math.floor(Math.round(mins) / snapMin) * snapMin;
  return Math.min(Math.max(snapped, 0), MINUTES_PER_DAY - snapMin);
}

/** Minute-of-day → "HH:MM" (the wizard-prefill / onCreateAt wire format). */
export const minuteToHHMM = (mins: number): string =>
  `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/** Done-ish statuses no longer occupy their span — their slot is open again.
 *  Mirrors the server's block DONE_STATUSES (engine/blocks-place.ts): a 'missed' or
 *  'done' block is finished, so its slot is free for click-to-create. */
const INACTIVE_STATUSES = new Set(['completed', 'done', 'cancelled', 'skipped', 'missed']);

/**
 * Does `minute` (of `day`) fall inside any ACTIVE block's [start, end) span?
 * Only timed, on-grid blocks occupy: all-day blocks live in the header lane and
 * someday concepts have no span, so neither closes a slot. Half-open interval —
 * clicking exactly at a block's end minute is a free slot.
 */
export function isSlotOccupied(blocks: readonly Block[], day: string, minute: number): boolean {
  return blocks.some((b) => {
    if (INACTIVE_STATUSES.has(b.status)) return false;
    if (isAllDay(b) || b.block_type === 'someday') return false;
    if (!b.start_at || !b.end_at) return false;
    const start = minutesIntoDay(b.start_at, day);
    const end = minutesIntoDay(b.end_at, day);
    return minute >= start && minute < end;
  });
}
