import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sqlite } from '../../db/index.js';
import { config } from '../config.js';

export interface SealedToken {
  iv: string;       // hex 12-byte AES-GCM nonce
  authTag: string;  // hex 16-byte GCM tag
  ciphertext: string; // hex encrypted payload
}

/**
 * AES-256-GCM encrypt. kek must be 32 bytes (from CP_KEK_B64).
 * Returns all fields as hex so they are safe to store as TEXT columns.
 */
export function seal(plain: string, kek: Buffer): SealedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * AES-256-GCM decrypt. Throws if the auth tag does not match (tamper / wrong key).
 */
export function open(sealed: SealedToken, kek: Buffer): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    kek,
    Buffer.from(sealed.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** Decode a base64 KEK and assert it is exactly 32 bytes (AES-256). */
function decodeKek(b64: string | undefined, label: string): Buffer {
  if (!b64) throw new Error(`${label} is required for the connection-token store`);
  const key = Buffer.from(b64, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`${label} must decode to exactly 32 bytes (got ${key.byteLength})`);
  }
  return key;
}

/**
 * Load a KEK.
 *  - No arg → the CURRENT KEK from CP_KEK_B64 (unchanged behavior; existing no-arg
 *    callers in connectors/base.ts keep working identically).
 *  - With a version → the historical key from CP_KEK_B64_V{n}. If {n} is the current
 *    version (config.kek.currentVersion), falls back to CP_KEK_B64 so the active key
 *    need only be supplied once.
 * Throws if the resolved env var is absent or its decoded length is wrong.
 */
export function loadKek(version?: number): Buffer {
  if (version === undefined) {
    return decodeKek(process.env.CP_KEK_B64, 'CP_KEK_B64');
  }
  const versioned = process.env[`CP_KEK_B64_V${version}`];
  if (versioned) return decodeKek(versioned, `CP_KEK_B64_V${version}`);
  // Current version may live in plain CP_KEK_B64 (the common single-key deployment).
  if (version === config.kek.currentVersion) {
    return decodeKek(process.env.CP_KEK_B64, 'CP_KEK_B64');
  }
  throw new Error(`CP_KEK_B64_V${version} is required to open key_version=${version} rows`);
}

/**
 * Rotate every connection_tokens row to a new KEK version, atomically.
 *
 * For each row not already at `newVersion`, open() it with its historical key
 * (loadKek(row.key_version)) and re-seal() under the new key with a FRESH IV, then
 * UPDATE iv/auth_tag/ciphertext and bump key_version. Runs in ONE better-sqlite3
 * transaction (all-or-nothing). Idempotent: rows already at newVersion are skipped,
 * so a second call rotates 0.
 *
 * Refuses (throws BEFORE any write) if the new key is not 32 bytes, or if newVersion
 * is not strictly greater than the current max key_version (no in-place / downgrade).
 *
 * @param newKeyB64 optional base64 new key; defaults to CP_KEK_B64_V{newVersion}.
 */
export function rotateKek(newVersion: number, newKeyB64?: string): { rotated: number } {
  const b64 = newKeyB64 ?? process.env[`CP_KEK_B64_V${newVersion}`];
  // Validate the new key length up front — refuse with no writes on a bad key.
  const newKey = decodeKek(b64, `CP_KEK_B64_V${newVersion}`);

  const maxRow = sqlite
    .prepare('SELECT MAX(key_version) AS maxV FROM connection_tokens')
    .get() as { maxV: number | null };
  const maxVersion = maxRow.maxV ?? 0;
  if (newVersion <= maxVersion) {
    throw new Error(
      `rotateKek: newVersion (${newVersion}) must be greater than the existing max key_version (${maxVersion})`,
    );
  }

  const rows = sqlite
    .prepare(
      'SELECT id, iv, auth_tag, ciphertext, key_version FROM connection_tokens WHERE key_version <> ?',
    )
    .all(newVersion) as Array<{
      id: string;
      iv: string;
      auth_tag: string;
      ciphertext: string;
      key_version: number;
    }>;

  const update = sqlite.prepare(
    `UPDATE connection_tokens
     SET iv = ?, auth_tag = ?, ciphertext = ?, key_version = ?,
         updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     WHERE id = ?`,
  );

  const tx = sqlite.transaction(() => {
    let rotated = 0;
    for (const row of rows) {
      const plain = open(
        { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
        loadKek(row.key_version),
      );
      const sealed = seal(plain, newKey);
      update.run(sealed.iv, sealed.authTag, sealed.ciphertext, newVersion, row.id);
      rotated++;
    }
    return rotated;
  });

  return { rotated: tx() };
}
