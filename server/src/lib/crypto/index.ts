import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * The ONE place that touches the KEK (Phase I PR4). Connector tokens (Phase J) are
 * sealed with AES-256-GCM under a key-encryption key loaded from CP_KEK_B64 (env)
 * or the Hub keystore. Per-record 12-byte IV; the 16-byte GCM tag authenticates,
 * so `open` THROWS on any tamper.
 *
 * D6 coupling — the one unavoidable seam: CI-Server's connection-token algorithm
 * and params (AES-256-GCM, 12-byte IV, 16-byte tag) are confirmed against the
 * published, versioned contract at BUILD time and matched here. If they ever
 * diverge, ONLY this file changes — never reverse-engineer a running binary.
 */

export interface Sealed {
  iv: Buffer; // 12-byte GCM nonce, unique per record
  ciphertext: Buffer;
  authTag: Buffer; // 16-byte GCM tag
}

// Cached by the base64 string so a rotated/swapped KEK (and the tests) take effect
// without a restart; validated to 32 bytes (AES-256) on (re)load.
let cached: { b64: string; key: Buffer } | null = null;

function kek(): Buffer {
  const b64 = config.auth.kekB64;
  if (!b64) throw new Error('CP_KEK_B64 is required for the connection-token store');
  if (!cached || cached.b64 !== b64) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('CP_KEK_B64 must decode to 32 bytes (AES-256)');
    cached = { b64, key };
  }
  return cached.key;
}

/** True when a usable 32-byte KEK is configured — for a boot-time assertion in connector mode. */
export function kekAvailable(): boolean {
  try {
    kek();
    return true;
  } catch {
    return false;
  }
}

export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek(), iv);
  const ciphertext = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv, ciphertext, authTag: c.getAuthTag() };
}

export function open({ iv, ciphertext, authTag }: Sealed): string {
  const d = createDecipheriv('aes-256-gcm', kek(), iv);
  d.setAuthTag(authTag); // any tamper (ciphertext, tag, IV, or wrong KEK) makes final() throw
  return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
}

/** Test-only: drop the memoized KEK so a new CP_KEK_B64 takes effect. */
export function _resetKekCache(): void {
  cached = null;
}
