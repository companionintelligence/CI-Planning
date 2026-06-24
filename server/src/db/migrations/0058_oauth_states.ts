import type { Database } from 'better-sqlite3';

export const id = '0058_oauth_states';

/**
 * Wave 0 (WP1) — OAuth authorization-code/PKCE state store + connection lifecycle.
 *
 * oauth_states: one short-lived row per in-flight authorize redirect. `state` is the
 * CSRF nonce echoed back on the callback (UNIQUE + indexed for the lookup);
 * `code_verifier` is the PKCE verifier the callback exchanges for tokens. Rows are
 * single-use and expire (`expires_at`); the callback deletes the matched row.
 *
 * connection_tokens.status: 'active' | 'revoked' | 'error' — lets a revoked/failed
 * connection be retained (for audit / re-auth) without deleting the encrypted row.
 * Additive + idempotent (the column-add is PRAGMA-guarded).
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      id            TEXT PRIMARY KEY,
      owner_id      TEXT NOT NULL REFERENCES owners(id),
      provider      TEXT NOT NULL DEFAULT 'google',
      state         TEXT NOT NULL UNIQUE,           -- CSRF nonce echoed on the callback
      code_verifier TEXT NOT NULL,                  -- PKCE verifier (exchanged for tokens)
      nonce         TEXT,                           -- optional OIDC nonce
      redirect_uri  TEXT,
      scopes        TEXT,                            -- JSON string[] of requested scopes
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_oauth_states_state ON oauth_states(state);
  `);

  if (!hasColumn(db, 'connection_tokens', 'status')) {
    db.exec(`ALTER TABLE connection_tokens ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`);
  }
}
