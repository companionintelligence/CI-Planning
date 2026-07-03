import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';

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
  is_locked: number;
  status: string;
}

/**
 * Fixed = never silently displaced: meetings (incl. external-event mirrors, which
 * are locked meeting blocks), user-locked blocks, and in-progress blocks.
 * Everything else — auto/manual task blocks, soft buffers (break/buffer) — is
 * movable. Mirrors auto-defense's computeProtected intent, generalized to any
 * subsequent entity rather than just the auto snapshot.
 */
function isFixed(r: Row): boolean {
  return r.block_kind === 'meeting' || r.is_locked === 1 || r.status === 'in_progress';
}

/**
 * Plan (and optionally apply) a "+minutes" extension of one block.
 *
 * @param blockId the block to extend
 * @param minutes positive minutes to add to its end
 * @param opts.commit when true AND the plan fits, apply the writes atomically
 */
export function extendBlock(
  blockId: string,
  minutes: number,
  opts: { commit?: boolean } = {},
  owner: string = currentOwnerId(),
): ExtendResult {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be a positive number');

  const block = sqlite
    .prepare(
      `SELECT id, task_id, title, start_at, end_at, block_kind, is_locked, status
         FROM time_blocks WHERE id = ? AND owner_id = ?`,
    )
    .get(blockId, owner) as Row | undefined;
  if (!block) throw new Error('block not found');

  const overflowMs = Math.round(minutes) * 60_000;
  const origEnd = Date.parse(block.end_at);
  const newEnd = origEnd + overflowMs;
  const newEndAt = new Date(newEnd).toISOString();

  // Entities that start at/after the block's ORIGINAL end, in time order — the
  // only ones an end-extension can run into. Completed/skipped/cancelled blocks
  // aren't obstacles (mirrors dayObstacles).
  const subsequent = sqlite
    .prepare(
      `SELECT id, task_id, title, start_at, end_at, block_kind, is_locked, status
         FROM time_blocks
        WHERE owner_id = ? AND id != ? AND start_at >= ?
          AND status NOT IN ('completed','skipped','cancelled')
        ORDER BY start_at ASC`,
    )
    .all(owner, blockId, block.end_at) as Row[];

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
    sqlite.transaction(() => {
      sqlite
        .prepare(`UPDATE time_blocks SET end_at = ?, last_moved_at = ? WHERE id = ? AND owner_id = ?`)
        .run(newEndAt, now, blockId, owner);
      const upd = sqlite.prepare(
        `UPDATE time_blocks SET start_at = ?, end_at = ?, last_moved_at = ? WHERE id = ? AND owner_id = ?`,
      );
      for (const m of movedSet) upd.run(m.after.start_at, m.after.end_at, now, m.block_id, owner);
    })();
    committed = true;
  }

  // When blocked, the moves computed before the obstacle would never apply —
  // report the obstacle, not a half-cascade.
  return { fits, committed, newEndAt, movedSet: fits ? movedSet : [], blockedBy };
}
