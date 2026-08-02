import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { store } from '../../db/store.js';
import { newId } from '../ids.js';
import { httpError } from '../http-error.js';
import type { VerifiedClaims } from './types.js';

/**
 * Minimal standalone API-key store (D4) for the public Docker image — one scoped
 * key, SHA-256 at rest, NOT a session/CSRF/refresh system. The full key is shown
 * once at issuance; only `prefix` (for an indexed candidate lookup) and `key_hash`
 * persist, so a stolen DB never yields a usable key.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Issue a new key and persist its hash. Returns the raw key — surfaced ONCE, never re-derivable. */
export async function issueApiKey(ownerId: string, scopes: string[], ttlDays?: number): Promise<string> {
  const raw = randomBytes(32).toString('hex'); // 64 hex chars of entropy
  const key = `cpk_${raw}`;
  const prefix = key.slice(0, 5); // 'cpk_' + 1 char → 5-char indexed lookup
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 864e5).toISOString() : null;
  await store()
    .prepare(
      `INSERT INTO api_keys (id, owner_id, prefix, key_hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), ownerId, prefix, sha256(key), JSON.stringify(scopes), expiresAt);
  return key;
}

interface ApiKeyRow {
  id: string;
  owner_id: string;
  key_hash: string;
  scopes: string;
  expires_at: string | null;
}

/** Resolve a presented key to its owner + scopes, or throw 401. Constant-time hash compare. */
export async function verifyApiKey(presented: string): Promise<VerifiedClaims> {
  const prefix = presented.slice(0, 5);
  const rows = await store()
    .prepare(
      `SELECT id, owner_id, key_hash, scopes, expires_at
         FROM api_keys WHERE prefix = ? AND revoked_at IS NULL`,
    )
    .all<ApiKeyRow>(prefix);

  // SHA-256 hex is fixed-length, so timingSafeEqual is safe; iterate all candidates
  // (no early return on the first mismatch) to keep the compare data-independent.
  const want = Buffer.from(sha256(presented));
  const row = rows.find((r) => {
    const have = Buffer.from(r.key_hash);
    return have.length === want.length && timingSafeEqual(have, want);
  });
  if (!row) throw httpError(401, 'invalid api key');
  if (row.expires_at && row.expires_at < new Date().toISOString()) throw httpError(401, 'expired');

  // Best-effort touch — a failed bookkeeping write must never block an accepted request.
  try {
    await store().prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
  } catch {
    /* ignore */
  }

  return { ownerId: row.owner_id, scopes: JSON.parse(row.scopes) as string[] };
}
