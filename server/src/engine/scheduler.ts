/**
 * Shared day-packing primitives — the gap math every placement path reuses
 * (`buildGaps`, `pickGap`, `splitIntoSessions`, `dayObstacles`) plus the `Gap`
 * shape and `MS_PER_MIN`.
 *
 * The legacy backlog-packing `runScheduler` that once lived here was removed (Phase
 * AE hardening): it was unrouted — no cron or handler called it — and its day-clear
 * had no `block_kind`/`source_kind`/`is_locked` scoping, so re-wiring it would have
 * deleted routine and container blocks. The user-driven engine (`placeFlightPlan` /
 * reflow, which build on the helpers below) fully superseded it.
 */
import { store } from '../db/store.js';
import { PLACED_TIMEBLOCK_SQL } from './mobility.js';

/** A free window in the day, with a moving cursor as blocks are packed in. */
export interface Gap {
  start: number;
  end: number;
  cursor: number;
}

export const MS_PER_MIN = 60_000;
// Don't carve a focus block shorter than this — sub-quarter-hour slivers aren't useful.
const MIN_SESSION_MS = 15 * MS_PER_MIN;

/** Split a duration into focus-sized sessions; the final session may be shorter. */
export function splitIntoSessions(totalMs: number, maxFocusMs: number): number[] {
  const out: number[] = [];
  let rem = totalMs;
  while (rem > 0) {
    const slice = Math.min(rem, maxFocusMs);
    out.push(slice);
    rem -= slice;
  }
  return out.length ? out : [Math.min(totalMs, maxFocusMs)];
}

/**
 * Choose where a session of `wantMs` goes. Prefers a gap that fits it fully
 * (best-fit: least leftover, to reduce fragmentation); otherwise falls back to
 * the largest remaining gap and truncates the session to fit. Scans *all* gaps,
 * so smaller tasks backfill holes a bigger task skipped.
 */
export function pickGap(gaps: Gap[], wantMs: number): { gap: Gap; len: number } | null {
  let fit: Gap | null = null;
  let fitLeftover = Infinity;
  let largest: Gap | null = null;
  let largestFree = 0;

  for (const g of gaps) {
    const free = g.end - g.cursor;
    if (free <= 0) continue;
    if (free >= wantMs && free - wantMs < fitLeftover) {
      fit = g;
      fitLeftover = free - wantMs;
    }
    if (free > largestFree) {
      largest = g;
      largestFree = free;
    }
  }

  if (fit) return { gap: fit, len: wantMs };
  if (largest && largestFree >= MIN_SESSION_MS) return { gap: largest, len: largestFree };
  return null;
}

/**
 * Fixed obstacles overlapping [windowStartMs, windowEndMs] that placement must
 * schedule around (PR-C+, Workstream A — the shared "don't double-book" rule).
 *
 * Always obstacles: locked blocks, meetings, and every non-completed *task*
 * block — so Auto/pattern placement never stacks on existing work (manual or
 * auto) and pass 1's placements survive into pass 2. With `includePlans`, Plan
 * containers are obstacles too (the workday fallback flows *around* the Plans
 * the user drew, leaving their windows to their own tag-matched tasks).
 *
 * Which containers those are is `PLACED_TIMEBLOCK_SQL` (engine/mobility.ts) — the
 * ladder's `holds` rung, not a hand-written copy of it. This clause used to read
 * `block_type = 'scheduled'`, a value only the Element wizard writes, so a Time Block
 * created anywhere else held no slot and the engine placed straight through it.
 *
 * `excludeBlockId` drops one row (the Plan being filled) so a Plan isn't an
 * obstacle to placing inside itself.
 */
export async function dayObstacles(
  owner: string,
  windowStartMs: number,
  windowEndMs: number,
  opts: { includePlans?: boolean; excludeBlockId?: string | null } = {}
): Promise<{ start: number; end: number }[]> {
  const windowStartISO = new Date(windowStartMs).toISOString();
  const windowEndISO = new Date(windowEndMs).toISOString();
  const rows = await store()
    .prepare(
      `SELECT id, start_at, end_at FROM time_blocks
        WHERE owner_id = ? AND start_at < ? AND end_at > ?
          AND (
               is_locked = 1
            OR block_kind = 'meeting'
            OR (block_kind = 'task' AND status NOT IN ('completed','skipped','cancelled'))
            OR (? = 1 AND ${PLACED_TIMEBLOCK_SQL})
          )`
    )
    .all(owner, windowEndISO, windowStartISO, opts.includePlans ? 1 : 0) as { id: string; start_at: string; end_at: string }[];
  return rows
    .filter((r) => r.id !== opts.excludeBlockId)
    .map((r) => ({ start: Date.parse(r.start_at), end: Date.parse(r.end_at) }));
}

/** Carve the workday into free windows between fixed events, with a break after each. */
export function buildGaps(
  dayStart: number,
  dayEnd: number,
  fixed: { start: number; end: number }[],
  breakMs: number
): Gap[] {
  const sorted = [...fixed].sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let cursor = dayStart;

  for (const ev of sorted) {
    const gapEnd = Math.min(ev.start, dayEnd);
    if (cursor < gapEnd) gaps.push({ start: cursor, end: gapEnd, cursor });
    cursor = Math.max(cursor, ev.end + breakMs);
  }
  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd, cursor });
  return gaps;
}
