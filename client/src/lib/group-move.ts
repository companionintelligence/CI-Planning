/**
 * Grouped-movement math for Plan containers (PR-C).
 *
 * A Plan and its member task blocks move together by one minute delta. New instants
 * are produced ONLY via `instantFor` — the exact inverse of `minutesIntoDay` — so a
 * group move has no tz drift and a delta of 0 round-trips to byte-identical instants.
 * Because `instantFor`/`minutesIntoDay` anchor the whole day on one local midnight,
 * `shiftBlock(b, day, d)` equals `bMs + d·60000` exactly, matching the server's pure
 * elapsed-ms `move-group` shift byte-for-byte (DST included).
 *
 * These functions are pure (no DOM, no signals) so they're unit-tested in isolation;
 * the Planner wires them to pointer gestures + the optimistic override map.
 */
import { minutesIntoDay, instantFor, MINUTES_PER_DAY } from './grid.js';
import { clampMoveDelta, type Neighbour } from './drag.js';
import { isAllDay } from './overlay.js';
import type { Block } from './api.js';

export interface Move { start_at: string; end_at: string }

/** Shift one block's [start, end] by `deltaMin`, rebuilt via instantFor. delta 0 = identity. */
export function shiftBlock(block: Pick<Block, 'start_at' | 'end_at'>, day: string, deltaMin: number): Move {
  return {
    start_at: instantFor(day, minutesIntoDay(block.start_at, day) + deltaMin),
    end_at: instantFor(day, minutesIntoDay(block.end_at, day) + deltaMin),
  };
}

/** Apply `deltaMin` to every member, keyed by block id — the optimistic group preview. */
export function applyGroupDelta(members: Block[], day: string, deltaMin: number): Record<string, Move> {
  const out: Record<string, Move> = {};
  for (const m of members) out[m.id] = shiftBlock(m, day, deltaMin);
  return out;
}

/**
 * Resolve a group's members from a flat block list given an anchor id — the Plan
 * container OR any member. Returns the parent container + all its children. A loose
 * block (no parent, not a container) is its own singleton group.
 */
export function resolveGroup(blocks: Block[], anchorId: string): Block[] {
  const anchor = blocks.find((b) => b.id === anchorId);
  if (!anchor) return [];
  const parentId = anchor.block_kind === 'timeblock' ? anchor.id : anchor.parent_block_id ?? anchor.id;
  return blocks.filter((b) => b.id === parentId || b.parent_block_id === parentId);
}

/**
 * Clamp a whole-group move (`deltaMin`) so the group, treated as one rigid body, never
 * increases its overlap with any NON-member block. The group's hull `[min start, max
 * end]` is clamped against the obstacle set exactly like a single block (reusing
 * `clampMoveDelta`), so internal member-to-member offsets are preserved and only the
 * leading/trailing edge is tested against outsiders. Pure + tz-safe (minute space).
 *
 * Obstacles = timed (non-all-day, non-someday) blocks that are not members, reduced to
 * their day-minute extent and filtered to those intersecting the day.
 */
export function clampGroupDelta(members: Block[], allBlocks: Block[], day: string, deltaMin: number): number {
  if (deltaMin === 0 || members.length === 0) return deltaMin;
  const memberIds = new Set(members.map((m) => m.id));
  let groupTop = Infinity;
  let groupBot = -Infinity;
  for (const m of members) {
    groupTop = Math.min(groupTop, minutesIntoDay(m.start_at, day));
    groupBot = Math.max(groupBot, minutesIntoDay(m.end_at, day));
  }
  const obstacles: Neighbour[] = allBlocks
    .filter((b) => !memberIds.has(b.id) && !isAllDay(b) && b.block_type !== 'someday')
    .map((b) => ({ topMin: minutesIntoDay(b.start_at, day), botMin: minutesIntoDay(b.end_at, day) }))
    .filter((n) => n.botMin > 0 && n.topMin < MINUTES_PER_DAY); // only blocks intersecting this day
  return clampMoveDelta(groupTop, groupBot, deltaMin, obstacles);
}

/**
 * The Plan whose window contains `startMs` (a dropped task's new start), if any —
 * drives attach-on-drop. Tag-agnostic: dropping into a Plan's window attaches it.
 * Ignores `excludeId` (the block being dropped) and only considers Plan containers.
 */
export function containerAt(blocks: Block[], startMs: number, excludeId?: string): Block | undefined {
  return blocks.find((b) => {
    if (b.id === excludeId || b.block_kind !== 'timeblock') return false;
    const s = Date.parse(b.start_at), e = Date.parse(b.end_at);
    return startMs >= s && startMs < e;
  });
}
