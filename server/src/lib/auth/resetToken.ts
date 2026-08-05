import { randomBytes, createHash } from 'node:crypto';
import { store } from '../../db/store.js';
import { newId } from '../ids.js';
import { config } from '../config.js';

/**
 * Password-reset token service (V). Single-use, expiring, hashed-at-rest — the same
 * lifecycle as `auth_states` (0102) / `oauth_states` (0058), stored in
 * `password_reset_tokens` (0104).
 *
 * The RAW token is a 32-byte base64url string that lives ONLY in the emailed link.
 * We persist `sha256(raw)`, never the raw value, so a database read cannot yield a
 * usable reset token (a deliberate hardening over the CI-Portal reference, which
 * stores its token unhashed). Consumption is single-use and, on success, invalidates
 * every other outstanding token for that owner.
 */

/** sha256 of the raw token, hex — the at-rest form + the lookup key. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Mint a reset token for `ownerId`. Returns the RAW token (put it in the email link);
 * only its hash is stored. Any earlier outstanding tokens for this owner are dropped
 * first, so a fresh request always supersedes stale ones. Opportunistically prunes
 * globally-expired rows (they're never consumed, so they must not accumulate).
 *
 * `ttlMs` defaults to the reset lifetime (60 min); Phase AG account invites pass a
 * longer one — an invite waits in an inbox, a reset is used within minutes.
 */
export async function issueResetToken(ownerId: string, ttlMs: number = config.auth.resetTokenTtlMs): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();

  await store().transaction(async () => {
    await store().prepare(`DELETE FROM password_reset_tokens WHERE expires_at <= ?`).run(new Date(now).toISOString());
    // Supersede this owner's prior tokens so only the newest link works.
    await store().prepare(`DELETE FROM password_reset_tokens WHERE owner_id = ?`).run(ownerId);
    await store()
      .prepare(
        `INSERT INTO password_reset_tokens (id, owner_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .run(newId(), ownerId, hashToken(raw), expiresAt);
  });
  return raw;
}

/**
 * Validate + consume a raw reset token. Returns the owner id on success, or null if the
 * token is unknown, already used, or expired. Single-use: marks the row `used_at` and
 * deletes every other outstanding token for the owner (so a reset can't be replayed and
 * no sibling link stays live). All in one transaction.
 */
export async function consumeResetToken(raw: string): Promise<string | null> {
  const tokenHash = hashToken(raw);
  return store().transaction(async (): Promise<string | null> => {
    const row = await store()
      .prepare(
        `SELECT id, owner_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
      )
      .get<{ id: string; owner_id: string; expires_at: string; used_at: string | null }>(tokenHash);
    if (!row) return null;
    if (row.used_at) return null;
    if (new Date(row.expires_at) <= new Date()) return null;

    await store().prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
    // Invalidate any siblings so only this reset takes effect.
    await store().prepare(`DELETE FROM password_reset_tokens WHERE owner_id = ? AND id <> ?`).run(row.owner_id, row.id);
    return row.owner_id;
  });
}
