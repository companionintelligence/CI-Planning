import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { seal, open } from '../lib/crypto/index.js';

/**
 * Encrypted connection-token store (Phase I PR4). The crypto lives entirely in
 * lib/crypto; this service is the only DB access. Phase J connectors call
 * save/load — the token JSON never touches the DB in plaintext.
 */

interface SealedRow {
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
}

/** Upsert a sealed token for (owner, provider, account). `token` may be a JSON object or string. */
export function saveConnectionToken(
  ownerId: string,
  provider: string,
  account: string,
  token: unknown,
): void {
  const plain = typeof token === 'string' ? token : JSON.stringify(token);
  const { iv, ciphertext, authTag } = seal(plain);
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(owner_id, provider, account) DO UPDATE SET
         iv = excluded.iv, auth_tag = excluded.auth_tag, ciphertext = excluded.ciphertext, key_version = 1`,
    )
    .run(newId(), ownerId, provider, account, iv, authTag, ciphertext);
}

/** Decrypt and return the stored token string, or null if none. Throws if the record was tampered. */
export function loadConnectionToken(ownerId: string, provider: string, account: string): string | null {
  const row = sqlite
    .prepare(`SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?`)
    .get(ownerId, provider, account) as SealedRow | undefined;
  if (!row) return null;
  return open({ iv: row.iv, ciphertext: row.ciphertext, authTag: row.auth_tag });
}
