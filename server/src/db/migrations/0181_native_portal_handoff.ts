import type { Database } from 'better-sqlite3';

export const id = '0181_native_portal_handoff';

/** Native Portal login returns to the app with a short-lived PKCE-bound handoff code. */
export function up(db: Database): void {
  db.exec(`
    ALTER TABLE auth_states ADD COLUMN native_code_challenge TEXT;

    CREATE TABLE IF NOT EXISTS native_auth_handoffs (
      ticket_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      code_challenge TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_native_auth_handoffs_expiry
      ON native_auth_handoffs(expires_at);
  `);
}
