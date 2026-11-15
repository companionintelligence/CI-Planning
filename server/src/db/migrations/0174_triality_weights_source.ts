import type { Database } from 'better-sqlite3';

export const id = '0174_triality_weights_source';

/**
 * Which weights ranked a Triality suggestion, stamped on the impression log.
 *
 * Learning changes the per-slot weights, and `triality_log` is the evidence the learning reads,
 * but the log never said which weights were in force when a suggestion was shown. So acceptance
 * could not be split into "ranked on the shipped defaults" and "ranked on learned weights", and
 * no change in acceptance could be attributed to the learning (or ruled out as unrelated to it).
 *
 * Values, enforced in code rather than a CHECK constraint (repo convention):
 *   'learned'          a `triality_weights` row for that slot was read and used;
 *   'defaults'         there was no row, so the shipped §5 defaults ranked it;
 *   'defaults_invalid' a row existed but was corrupt or outside its bounds, so the defaults
 *                      ranked it (getWeights' fallback), which is not the same as having none.
 * NULL means the pick was shown before this stamp existed, or the weights were injected by a
 * test, and it is not reconstructable: weights are re-learned weekly and the old row is gone.
 * Readers must leave NULL out of any split rather than call it `defaults`, the same rule the
 * `confidence` column (0144) set: pre-stamp rows cluster in the feature's earliest period.
 *
 * Stamped at show time, per pick, from the slot the pick filled. Never fed back into ranking.
 * No index: no reader scans on it. SQLite-only (the Postgres baseline stops at 0147).
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(triality_log)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'weights_source')) {
    db.exec(`ALTER TABLE triality_log ADD COLUMN weights_source TEXT`);
  }
}
