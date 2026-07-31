import type { Database } from 'better-sqlite3';

export const id = '0144_triality_confidence';

/**
 * Per-pick confidence on the Triality impression log (docs/triality-v2-design.md §4,
 * wave v2.2) — derived, deterministic, REPORTED, and never fed back into ranking.
 *
 * Stamped at SHOW TIME because confidence is a statement about the situation the pick
 * was made in, and that situation is not recoverable later: the vector is never
 * persisted, so a backfill would reconstruct TODAY's vector and stamp it on a 60-day-old
 * row — a fabricated reading. NULL therefore means "shown before v2.2", permanently.
 * Every reader must EXCLUDE those rows from confidence aggregates rather than call them
 * a `guess`: pre-v2.2 rows skew toward the feature's earliest period, so coercing them
 * would bias the very comparison the calibration tile exists to make.
 *
 * ONE JSON column, not two. The band is the only field anything groups by, but the
 * calibration reader must run collapseImpressions BEFORE it counts anything, so the
 * bucketing happens in JS regardless and SQLite never sees a GROUP BY — a separate band
 * column would buy no read and cost a denormalization invariant.
 *
 * DELIBERATELY NOT inside the existing `scores` column. parseScores
 * (services/triality-learning.ts) iterates only COMPONENTS and ignores unknown keys, so
 * a confidence smuggled in there would be inert TODAY — but inert by accident, not by
 * contract, and one widened COMPONENTS list later it would be evidence. A separate
 * column makes "v2.2 leaves the learning corpus untouched" a schema fact, not a promise.
 *
 * No index. Both existing readers already range-scan (owner_id, shown_at) against an
 * index on (owner_id, local_date), and this adds a third — but that is a pre-existing,
 * behavior-neutral, unmeasured cost unrelated to this feature, and a wave whose core
 * promise is being provably minimal is not where it belongs.
 *
 * Values are enforced in code, not CHECK constraints (repo convention).
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(triality_log)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'confidence')) {
    db.exec(`ALTER TABLE triality_log ADD COLUMN confidence TEXT`);
  }
}
