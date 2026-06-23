import type { Database } from 'better-sqlite3';

export const id = '0046_audit_log';

/**
 * Phase R — Audit foundation.
 *
 * Append-only log: every mutating route writes one row after its DB write succeeds.
 * owner_id is TEXT (UUIDv7, since migration 0030). id is TEXT PK minted by uuid7().
 * actor: 'owner' (request-driven) | 'system' (cron job). No UPDATE/DELETE routes —
 * append-only by convention.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id       TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id),
      actor    TEXT NOT NULL,
      action   TEXT NOT NULL,
      entity   TEXT NOT NULL,
      at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_audit_owner_at ON audit_log(owner_id, at);
  `);
}
