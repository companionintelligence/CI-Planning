import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { stampRow } from '../sync/apply.js';
import { HOLDS_SLOT_SQL } from './mobility.js';

/**
 * Phase Z · Z3 (Time-Sense) — "Keep working" block extension (§1.1a).
 *
 * The deliberate opposite of reactive `reflow`: reflow is silent, structural, and
 * re-places the whole movable day from the frozen plan; extendBlock is
 * user-initiated, MINIMAL, and confirmed. It grows one block's end and, only if
 * that collides, pushes the fewest following entities by the smallest amount,
 * stopping the instant a gap absorbs the shift — a local ripple, never a
 * whole-day reshuffle. A fixed entity (meeting / external-event mirror /
 * user-locked / in-progress) is never silently displaced: the cascade escalates
 * to `blockedBy` instead.
 *
 * Two-phase by design (spec §1.1a): a caller first computes the plan (commit
 * off) to learn whether it fits silently, needs a confirmed move, or is blocked;
 * then applies it (commit on). Purely deterministic — no LLM, no reflow.
 */

export interface ExtendMove {
  block_id: string;
  task_id: string | null;
  title: string;
  before: { start_at: string; end_at: string };
  after: { start_at: string; end_at: string };
}

export interface ExtendResult {
  /** The extension is possible — silently (movedSet empty) or via the moves. */
  fits: boolean;
  /** Writes were applied (only when commit && fits). */
  committed: boolean;
  /** The extended block's end (proposed, or applied when committed). */
  newEndAt: string;
  /** Entities that must move for the extension to fit. Empty = silent fit. */
  movedSet: ExtendMove[];
  /** The fixed entity the cascade can't absorb — extension impossible as-is. */
  blockedBy: { block_id: string; title: string; start_at: string } | null;
}

interface Row {
  id: string;
  task_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  block_kind: string;
  block_type: string | null;
  is_locked: number;
  status: string;
  is_running: number;
}

/**
 * Fixed = never silently displaced: meetings (incl. external-event mirrors, which
 * are locked meeting blocks), user-locked blocks, actively-timed blocks, and
 * user-drawn Plan containers (`block_kind='timeblock'`). Only loose task blocks
 * are movable. Plan containers are treated as fixed rather than pushed because a
 * container carries child blocks that must move *with* it (move-group semantics);
 * shoving a container independently would shear its children out of it. So an
 * extension that runs into a Plan escalates to blockedBy instead — the obstacle
 * query below only surfaces top-level blocks, so children never appear here.
 *
 * "Actively-timed" is derived from a running `time_entries` row (ended_at IS NULL),
 * NOT `time_blocks.status='in_progress'` — the latter is never written (in_progress
 * is a task-only status), so the clock, not the block row, is the source of truth
 * for what's running (per M's convention).
 */
// #392 edge CLOSED: block_kind is free-form TEXT on the write path by design
// (block.graphql), so an API caller can create 'focus'/'habit' blocks even though no
// UI does. Those are protected work sessions, so they're fixed here — 'Keep working'
// escalates to blockedBy rather than silently shoving a focus/habit block. 'break' and
// 'buffer' are intentionally NOT fixed: they're loose padding and stay movable (and the
// obstacle query below doesn't surface them anyway).
function isFixed(r: Row): boolean {
  return (
    r.block_kind === 'meeting' ||
    r.block_kind === 'timeblock' ||
    r.block_kind === 'focus' ||
    r.block_kind === 'habit' ||
    r.is_locked === 1 ||
    r.is_running === 1 ||
    r.status === 'in_progress'
  );
}

/**
 * Plan (and optionally apply) a "+minutes" extension of one block.
 *
 * @param blockId the block to extend
 * @param minutes positive minutes to add to its end
 * @param opts.commit when true AND the plan fits, apply the writes atomically
 */
export async function extendBlock(
  blockId: string,
  minutes: number,
  opts: { commit?: boolean } = {},
  owner: string = currentOwnerId(),
): Promise<ExtendResult> {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number');

  const block = await store()
    .prepare(
      `SELECT id, task_id, title, start_at, end_at, block_kind, block_type, is_locked, status, 0 AS is_running
         FROM time_blocks WHERE id = ? AND owner_id = ?`,
    )
    .get<Row>(blockId, owner);
  if (!block) throw new Error('block not found');

  const overflowMs = Math.round(minutes) * 60_000;
  const origEnd = Date.parse(block.end_at);
  const newEnd = origEnd + overflowMs;
  const newEndAt = new Date(newEnd).toISOString();

  // Top-level timeline entities starting at/after this block's ORIGINAL end, in
  // order — the only things an end-extension can run into. Scoped to real
  // obstacles (mirrors dayObstacles): locked, meetings, live task blocks, focus/habit
  // sessions (protected work, #392), and Time Blocks that hold their slot. break/buffer
  // padding is deliberately omitted — it stays loose. `parent_block_id IS NULL` excludes
  // child blocks — they live inside a container (itself fixed here) and must never be
  // pushed independently. Completed/skipped/cancelled blocks aren't timeline obstacles.
  //
  // The container arm is `HOLDS_SLOT_SQL` (engine/mobility.ts) — the same rung
  // dayObstacles uses, so "mirrors dayObstacles" is now enforced rather than asserted.
  // It kept Someday Plans out, as the old hand-written clause did, and also drops
  // all-day rows and unrendered recurrence templates.
  const subsequent = await store()
    .prepare(
      `SELECT id, task_id, title, start_at, end_at, block_kind, block_type, is_locked, status,
              (EXISTS (SELECT 1 FROM time_entries te WHERE te.block_id = time_blocks.id AND te.ended_at IS NULL)) AS is_running
         FROM time_blocks
        WHERE owner_id = ? AND id != ? AND parent_block_id IS NULL AND start_at >= ?
          AND status NOT IN ('completed','skipped','cancelled')
          AND (
               is_locked = 1
            OR block_kind = 'meeting'
            OR block_kind = 'task'
            OR block_kind = 'focus'
            OR block_kind = 'habit'
            OR (${HOLDS_SLOT_SQL})
          )
        ORDER BY start_at ASC`,
    )
    .all<Row>(owner, blockId, block.end_at);

  const movedSet: ExtendMove[] = [];
  let blockedBy: ExtendResult['blockedBy'] = null;
  let frontier = newEnd; // the earliest a following entity may now start

  for (const e of subsequent) {
    const start = Date.parse(e.start_at);
    if (start >= frontier) break; // a gap absorbs the shift — stop the cascade
    if (isFixed(e)) {
      blockedBy = { block_id: e.id, title: e.title, start_at: e.start_at };
      break; // a fixed entity is never silently displaced
    }
    const dur = Date.parse(e.end_at) - start;
    const after = frontier;
    const afterEnd = after + dur;
    movedSet.push({
      block_id: e.id,
      task_id: e.task_id,
      title: e.title,
      before: { start_at: e.start_at, end_at: e.end_at },
      after: { start_at: new Date(after).toISOString(), end_at: new Date(afterEnd).toISOString() },
    });
    frontier = afterEnd; // push the residual forward
  }

  const fits = blockedBy === null;

  let committed = false;
  if (fits && opts.commit) {
    const now = new Date().toISOString();
    await store().transaction(async () => {
      // Phase L: an extend is an owner edit, so both the anchor and everything its
      // cascade displaces must stamp — otherwise a queued op holding the pre-extend
      // times wins LWW and the whole shift unwinds. Gated on the owner-scoped UPDATE
      // landing: stampRow keys on id alone (see cascadeArchiveToDescendants).
      // `last_moved_at` needs no stamp — it isn't in the sync allowlist.
      const anchor = await store()
        .prepare(`UPDATE time_blocks SET end_at = ?, last_moved_at = ? WHERE id = ? AND owner_id = ?`)
        .run(newEndAt, now, blockId, owner);
      if (anchor.changes > 0) await stampRow('block', blockId, ['endAt']);
      const upd = store().prepare(
        `UPDATE time_blocks SET start_at = ?, end_at = ?, last_moved_at = ? WHERE id = ? AND owner_id = ?`,
      );
      for (const m of movedSet) {
        const info = await upd.run(m.after.start_at, m.after.end_at, now, m.block_id, owner);
        if (info.changes > 0) await stampRow('block', m.block_id, ['startAt', 'endAt']);
      }
    });
    committed = true;
  }

  // When blocked, the moves computed before the obstacle would never apply —
  // report the obstacle, not a half-cascade.
  return { fits, committed, newEndAt, movedSet: fits ? movedSet : [], blockedBy };
}
