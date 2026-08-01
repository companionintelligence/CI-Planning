/**
 * Which `possible_tasks` sources are USER-REVIEWED rather than auto-promoted.
 *
 * Since AF-3 every producer batch auto-promotes its possibles straight into real tasks
 * and the Inbox was retired. Email is the exception: an inbox is other people's agenda,
 * so a message that merely *mentions* a commitment must not silently become one. Email
 * possibles therefore stay `pending` until the owner approves them.
 *
 * This predicate is deliberately the ONE place that decision lives, and it is applied at
 * the auto-promote DECISION points (`promoteAllPending`, `promotePossibles`,
 * `dedupePossibles`) rather than at the producers. Gating the producer would not work:
 * `promotePossibles` is an unconditional straggler sweeper run by `nightly_grooming` and
 * `promote_possibles`, so suggestions left pending by ingest would be promoted anyway at
 * 02:00 — the feature would appear to work for a day and then quietly stop.
 *
 * Enforcing it by construction here also makes the change provably inert for every other
 * producer: gcal, text and memory rows are not review-gated, so they take the identical
 * code path they always did.
 */

/** Source kinds whose possibles require explicit owner approval before becoming tasks. */
export const REVIEW_SOURCE_KINDS = ['gmail'] as const;

export type ReviewSourceKind = (typeof REVIEW_SOURCE_KINDS)[number];

/**
 * True when a possible of this source must wait for the owner.
 *
 * A null/undefined `source_kind` is NOT review-gated: the column is nullable and legacy
 * rows carry NULL, which the `claimLegacy` sweep depends on continuing to promote.
 */
export function requiresReview(sourceKind: string | null | undefined): boolean {
  return sourceKind != null && (REVIEW_SOURCE_KINDS as readonly string[]).includes(sourceKind);
}

/**
 * SQL fragment excluding review-gated rows, for the auto-promote/dedupe selects.
 *
 * NULL-SAFE BY CONSTRUCTION: `NULL NOT IN (…)` evaluates to NULL, not true, so a bare
 * `NOT IN` would silently drop every legacy NULL-source row from the sweeper. The
 * explicit `IS NULL` arm is what keeps those rows being promoted.
 */
export const EXCLUDE_REVIEWED_SQL = `(source_kind IS NULL OR source_kind NOT IN (${REVIEW_SOURCE_KINDS.map(() => '?').join(',')}))`;

/** SQL fragment selecting ONLY review-gated rows. NULL source is not review-gated. */
export const ONLY_REVIEWED_SQL = `(source_kind IN (${REVIEW_SOURCE_KINDS.map(() => '?').join(',')}))`;

/** Bind parameters for either fragment above. */
export const REVIEW_SOURCE_PARAMS: readonly string[] = REVIEW_SOURCE_KINDS;
