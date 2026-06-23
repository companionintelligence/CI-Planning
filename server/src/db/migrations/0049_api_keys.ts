import type { Database } from 'better-sqlite3';

export const id = '0049_api_keys';

/**
 * Phase I (PR1) — minimal standalone API-key store (D4). One scoped key for the
 * public Docker image: SHA-256 at rest (`key_hash`, never the raw key), `prefix`
 * for an indexed candidate lookup, JSON `scopes`, optional expiry, soft-revoke.
 * NOT a session/CSRF/refresh system. Additive + idempotent.
 *
 * CON-1: ids are TEXT UUIDv7; `owner_id` references owners(id) (TEXT, not INTEGER —
 * the I spec predates CON-1).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL REFERENCES owners(id),
      prefix       TEXT NOT NULL,                 -- first 5 chars, for lookup + display
      key_hash     TEXT NOT NULL,                 -- SHA-256 hex of the full key
      scopes       TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
      expires_at   TEXT,                          -- ISO; NULL = non-expiring
      last_used_at TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_api_keys_prefix ON api_keys(prefix);
    CREATE INDEX IF NOT EXISTS ix_api_keys_owner ON api_keys(owner_id);
  `);
}
