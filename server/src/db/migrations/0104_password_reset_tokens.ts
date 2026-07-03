import type { Database } from 'better-sqlite3';

export const id = '0104_password_reset_tokens';

/**
 * V (password reset) — single-use, expiring reset tokens.
 *
 * Same lifecycle as `auth_states` (0102) / `oauth_states` (0058): one short-lived row
 * per outstanding reset, single-use, expiring — but it binds an OWNER (a reset is
 * always for a known account), so `owner_id` is NOT NULL with an ON DELETE CASCADE FK.
 *
 * `token_hash` is `sha256(raw)` — the raw token lives only in the emailed link, never
 * at rest (a DB read must not yield a usable reset token). This is a deliberate
 * hardening over the CI-Portal reference, which stores its reset token unhashed.
 * `used_at` marks single-use consumption; expired/used rows are pruned opportunistically
 * by the reset-request path (like auth_states). Indexes: `token_hash` for the O(1)
 * consume lookup, `owner_id` for the "invalidate this owner's other tokens" sweep.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_reset_tokens_owner ON password_reset_tokens(owner_id);
    CREATE INDEX IF NOT EXISTS ix_reset_tokens_hash  ON password_reset_tokens(token_hash);
  `);
}
