import type { Database } from 'better-sqlite3';

export const id = '0051_connection_tokens';

/**
 * Phase I (PR4) — encrypted connection-token store. One row per (owner, provider,
 * account); the OAuth token JSON is AES-256-GCM-sealed (lib/crypto) so the DB never
 * holds plaintext credentials. The connectors that WRITE these arrive in Phase J;
 * this migration ships the store they target. `key_version` supports KEK rotation
 * (re-seal on read). Additive + idempotent.
 *
 * CON-1: id + owner_id are TEXT. iv/auth_tag/ciphertext are BLOB.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_tokens (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      provider    TEXT NOT NULL,                 -- 'google' | 'outlook' | …
      account     TEXT NOT NULL,
      iv          BLOB NOT NULL,                 -- 12-byte GCM nonce, per record
      auth_tag    BLOB NOT NULL,                 -- 16-byte GCM tag
      ciphertext  BLOB NOT NULL,                 -- enc(JSON { access, refresh, expiry })
      key_version INTEGER NOT NULL DEFAULT 1,    -- for KEK rotation
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, provider, account)
    );
    CREATE INDEX IF NOT EXISTS ix_connection_tokens_owner ON connection_tokens(owner_id);
  `);
}
