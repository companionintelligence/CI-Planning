import type { Database } from 'better-sqlite3';

export const id = '0050_connection_tokens';

/**
 * Phase J (PR1) — encrypted OAuth token store. One row per (owner, provider, account)
 * triple; the token JSON is AES-256-GCM encrypted via lib/crypto (KEK from CP_KEK_B64).
 * key_version lets a KEK rotation re-encrypt rows without downtime.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_tokens (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      provider    TEXT NOT NULL,  -- 'google' | 'outlook' | 'icloud'
      account     TEXT NOT NULL,  -- provider account identifier (email / username)
      iv          TEXT NOT NULL,  -- hex 12-byte AES-GCM nonce
      auth_tag    TEXT NOT NULL,  -- hex 16-byte GCM auth tag
      ciphertext  TEXT NOT NULL,  -- hex encrypted token JSON
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, provider, account)
    );
    CREATE INDEX IF NOT EXISTS ix_connection_tokens_owner ON connection_tokens(owner_id);
  `);
}
