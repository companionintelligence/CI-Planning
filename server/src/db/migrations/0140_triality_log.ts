import type { Database } from 'better-sqlite3';

export const id = '0140_triality_log';

/**
 * Append-only Triality outcome log (docs/triality-design.md §7): one row per
 * suggestion SHOWN, stamped at most once more when the owner reacts
 * (opened | staged | dismissed). Every row persists the full per-component
 * score breakdown as JSON — that is deliberate, not logging zeal: the log
 * doubles as the learning corpus (§6b), and weight calibration can only be
 * evidence-based if the evidence of WHY a pick ranked survives verbatim.
 *
 * `slot` ('habitual'|'contextual'|'novel') and `outcome`
 * ('shown'|'opened'|'staged'|'dismissed') are enforced in code, not CHECK
 * constraints (repo convention). Nothing prunes this table in production —
 * rows are ~small and the trend is the point (the calibration_history
 * rationale, 0138); tests must clear it via resetDb.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triality_log (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      shown_at    TEXT NOT NULL,
      local_date  TEXT NOT NULL,           -- 'YYYY-MM-DD' (owner-local day it was shown)
      slot        TEXT NOT NULL,
      action_kind TEXT NOT NULL,           -- 'task' | 'routine' | 'flight' | 'template'
      action_ref  TEXT NOT NULL,
      scores      TEXT NOT NULL,           -- JSON {F,H,Q,N,C,total,ternary:[..]}
      outcome     TEXT NOT NULL DEFAULT 'shown',
      outcome_at  TEXT
    );
    -- The learning + metrics read: one owner's rows over a date window.
    CREATE INDEX IF NOT EXISTS ix_triality_log_owner_date
      ON triality_log(owner_id, local_date);
  `);
}
