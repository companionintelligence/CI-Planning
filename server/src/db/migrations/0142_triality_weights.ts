import type { Database } from 'better-sqlite3';

export const id = '0142_triality_weights';

/**
 * Learned Triality slot weights (docs/triality-design.md §6b) — the
 * `estimate_calibration` shape applied to suggestion ranking: a REGENERABLE
 * rollup, replaced wholesale per owner by the weekly `calibrate_triality` job.
 *
 * Why regenerable is right here (and why nothing is appended): the durable
 * evidence already lives in `triality_log`, which is append-only and never
 * pruned. That log IS the learning history, so these rows are pure derived
 * state — recomputable from scratch at any time, and safely deletable. Deleting
 * an owner's rows is exactly the "reset learning" affordance
 * (DELETE /api/triality/weights): the log survives, so the adaptation can be
 * re-earned rather than lost.
 *
 * A slot with fewer than the floor's worth of decided outcomes gets NO row —
 * absence means "scoring on the §5 defaults", which is why the engine's
 * getWeights seam treats a missing row as the default rather than as zero.
 *
 * `slot` ('habitual'|'contextual'|'novel') is enforced in code, not by a CHECK
 * constraint (repo convention). Not mirrored in schema.ts: like
 * calibration_history (0138), this table is read/written through raw SQL only.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triality_weights (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      slot          TEXT    NOT NULL,
      weights       TEXT    NOT NULL,          -- JSON {F,H,Q,N,C}
      sample_count  INTEGER NOT NULL DEFAULT 0,
      computed_date TEXT    NOT NULL,          -- 'YYYY-MM-DD' (owner-local day of the run)
      PRIMARY KEY (owner_id, slot)
    );
  `);
}
