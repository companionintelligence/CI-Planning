import type { Database } from 'better-sqlite3';

export const id = '0103_owner_reset_columns';

/**
 * V (password reset for local sign-in) — two additive `owners` columns:
 *
 *   - `backup_email`  — the fallback reset destination. `owners.email` (the primary,
 *     predating U) is tried first; `backup_email` is used when it is absent. Set by
 *     the owner in Settings (V5). NULL until then.
 *   - `session_epoch` — the auth epoch that makes the STATELESS session cookie
 *     revocable. U2's session is a signed cookie carrying the owner id and NOTHING
 *     to invalidate server-side, so a password reset could not otherwise sign other
 *     devices out. The cookie now carries `${ownerId}.${epoch}`; verifySession
 *     rejects a cookie whose epoch != this column. Bumping it on password reset
 *     (V4) instantly invalidates every existing cookie for the owner (there is no
 *     per-device choice — a reset always signs out everywhere) — the user then signs
 *     in again to mint a fresh session cookie.
 *     NOT NULL DEFAULT 0 so every existing owner (incl. the sentinel) starts at epoch 0
 *     and their live cookies (epoch-less, read as 0) keep validating across the upgrade.
 *
 * Purely additive; no data change to existing rows. Idempotent + historical-replay
 * safe (migrate.test.ts replays the full set on a legacy-shaped owners table), guarding
 * on the column already existing — same pattern as 0101.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(owners)`).all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('session_epoch')) return; // already migrated — re-run safety.

  db.exec(`
    ALTER TABLE owners ADD COLUMN backup_email  TEXT;
    ALTER TABLE owners ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
  `);
}
