import type { Database } from 'better-sqlite3';

export const id = '0172_signup_codes';

/**
 * B2 (invite-code local sign-up, 2026-10-21) — single-use, expiring invite codes an
 * operator mints in Settings → Accounts so a stranger can create their OWN local
 * account at /signup (Companion Memory's `signup_code` model). Keeps the 2026-07-12
 * ruling: the operator never sees or sets anyone's password — the code only admits
 * the person to the sign-up form; the password is theirs.
 *
 * Same lifecycle as `password_reset_tokens` (0104): `code_hash` is `sha256(raw)` —
 * the raw code is shown to the operator ONCE at mint time and never stored, so a DB
 * read cannot yield a usable code. `used_at`/`used_by` record single-use consumption
 * (the claim is one guarded UPDATE, so two sign-ups racing on one code can only ever
 * mint one account); `revoked_at` lets an operator withdraw a code before it is used;
 * `expires_at` is a 7-day TTL (an invite waits in an inbox, like an invite link).
 *
 * Both owner FKs are ON DELETE SET NULL: a code must survive the deletion of the
 * operator who minted it (the audit value is in the row, not the operator) and
 * `deleteOwner` must not be blocked by a sign-up record pointing at the account
 * being removed. `code_hash` UNIQUE doubles as the lookup index.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signup_codes (
      id         TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL UNIQUE,     -- sha256(raw); the raw code is shown once, never stored
      note       TEXT,                     -- operator's free-text label ("for Sam")
      created_by TEXT REFERENCES owners(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL,
      used_at    TEXT,                     -- single-use consumption stamp
      used_by    TEXT REFERENCES owners(id) ON DELETE SET NULL,
      revoked_at TEXT                      -- operator withdrew it before use
    );
  `);
}
