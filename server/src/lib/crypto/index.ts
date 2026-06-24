import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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

/**
 * Load the KEK from the base64 env value already wired in config.ts.
 * Call once at startup; cache the result — never re-read per request.
 * Throws if the env var is absent or the decoded length is wrong.
 */
export function loadKek(): Buffer {
  const b64 = process.env.CP_KEK_B64;
  if (!b64) throw new Error('CP_KEK_B64 is required for the connection-token store');
  const key = Buffer.from(b64, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`CP_KEK_B64 must decode to exactly 32 bytes (got ${key.byteLength})`);
  }
  return key;
}
