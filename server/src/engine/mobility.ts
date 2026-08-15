/**
 * The mobility ladder (Focus × Time Blocks, Phase 6).
 *
 * How readily the engine may move a scheduled block, owner-confirmed as decisions 2
 * and 3: **tasks move first, Time Blocks hold their slots.**
 *
 *   never moves    ── L00 synced calendar event (locked at ingest, Phase 1)
 *                  ── anything the owner locked (is_locked)
 *   holds its slot ── L02 Time Blocks (reflow shuffles tasks AROUND them; the owner
 *                     may still move one by hand, and its members ride along —
 *                     `moveBlockGroup`)
 *   moves last     ── manual task blocks (a deliberate placement)
 *   moves first    ── auto-placed task blocks (agent output; today's reflow already
 *                     moves only these)
 *
 * This phase is FORMALISATION, not a behaviour change: the ladder was already the
 * engine's shape, spread across five near-identical WHERE clauses. The risk with
 * five copies is drift — one gets a new condition and the others silently disagree,
 * and "which blocks may reflow" stops being a fact anyone can look up.
 *
 * So the predicate lives here once, in two forms that must stay in lockstep:
 * the SQL fragments the queries embed, and the in-memory twins. `mobility.test.ts`
 * asserts the two agree over a matrix of block shapes, which is what actually stops
 * them drifting — a shared constant alone would not catch a hand-edited query.
 */

/** Rungs of the ladder, loosest first. */
export type MobilityTier = 'auto' | 'manual' | 'holds' | 'fixed';

/**
 * Reflow order: a LOWER rank is given up first when something has to move.
 * Exposed so a scheduler can sort candidates rather than re-deriving the ordering.
 */
export const MOBILITY_RANK: Readonly<Record<MobilityTier, number>> = Object.freeze({
  auto: 0,
  manual: 1,
  holds: 2,
  fixed: 3,
});

/** The block columns the ladder reads. Structural, so callers can pass rows or API dicts. */
export interface MobilityInput {
  block_kind?: string | null;
  is_auto?: boolean | number | null;
  is_locked?: boolean | number | null;
  source_kind?: string | null;
}

const truthy = (v: boolean | number | null | undefined): boolean => v === true || v === 1;

/**
 * Which rung a block sits on.
 *
 * A synced calendar event resolves to `fixed` through `is_locked`, which Phase 1
 * guarantees for every inbound mirror (stamped at ingest, backfilled by 0148, and
 * un-unlockable through the service). The `meeting` guard alongside it is the same
 * belt-and-braces the client's `isImmovable` keeps — defence in depth if a mirror
 * ever lands unlocked. It cannot widen the reflow candidate set: a meeting is never
 * `is_auto=1 AND block_kind='task'` in the first place.
 */
export function mobility(b: MobilityInput): MobilityTier {
  if (truthy(b.is_locked) || b.block_kind === 'meeting') return 'fixed';
  if (b.block_kind === 'timeblock') return 'holds';
  if (isAutoPlaced(b)) return 'auto';
  return 'manual';
}

/**
 * An agent's own auto placement — the engine's output, and the only thing it may
 * reclaim. The in-memory twin of `AUTO_PLACED_SQL`.
 *
 * Note this ignores `is_locked` on purpose: auto-defense selects locked auto blocks
 * too, then protects them in memory (a pinned auto block holds its slot AND its
 * task). Use `isReflowCandidate` for "may the engine move this".
 */
export function isAutoPlaced(b: MobilityInput): boolean {
  return truthy(b.is_auto) && b.block_kind === 'task' && b.source_kind === 'agent';
}

/** May reflow move this block? Equivalent to sitting on the loosest rung. */
export function isReflowCandidate(b: MobilityInput): boolean {
  return mobility(b) === 'auto';
}

/**
 * SQL for "an agent's own auto placement". Embedded by the queries that select auto
 * blocks and then decide protection in memory (auto-defense).
 *
 * A bare fragment, no owner scoping and no leading AND — every call site is already
 * owner-scoped and composes this into a longer WHERE.
 */
export const AUTO_PLACED_SQL = `is_auto = 1 AND block_kind = 'task' AND source_kind = 'agent'`;

/**
 * SQL for "reflow may move this": an auto placement the owner has not pinned.
 * Embedded by the clear/re-place paths (autoplan's `clearPriorAuto`,
 * `clearPriorAutoInWindow`, and `clearDayAutoBlocks`).
 */
export const REFLOW_CANDIDATE_SQL = `${AUTO_PLACED_SQL} AND is_locked = 0`;
