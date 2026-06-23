import { describe, it, expect, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { config } from '../src/lib/config.js';
import { seal, open, kekAvailable, _resetKekCache, type Sealed } from '../src/lib/crypto/index.js';
import { saveConnectionToken, loadConnectionToken } from '../src/services/connection-tokens.js';

/**
 * Phase I (PR4) — the AES-256-GCM connection-token store. Secrets never persist in
 * plaintext; any tamper or wrong key fails closed (throws).
 */

const KEK_A = Buffer.alloc(32, 1).toString('base64'); // valid 32-byte KEK
const KEK_B = Buffer.alloc(32, 2).toString('base64'); // a different valid KEK
const KEK_SHORT = Buffer.alloc(16, 1).toString('base64'); // wrong size

function withKek(b64: string | undefined): void {
  config.auth.kekB64 = b64;
  _resetKekCache();
}

afterEach(() => {
  withKek(undefined);
  sqlite.exec('DELETE FROM connection_tokens');
});

describe('lib/crypto — seal/open', () => {
  it('round-trips plaintext', () => {
    withKek(KEK_A);
    const sealed = seal('hello secret');
    expect(open(sealed)).toBe('hello secret');
  });

  it('uses a distinct IV (and ciphertext) per seal', () => {
    withKek(KEK_A);
    const a = seal('same');
    const b = seal('same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('throws when the ciphertext is tampered', () => {
    withKek(KEK_A);
    const s = seal('payload');
    const bad: Sealed = { ...s, ciphertext: Buffer.from(s.ciphertext) };
    bad.ciphertext[0] ^= 0xff;
    expect(() => open(bad)).toThrow();
  });

  it('throws when the auth tag is tampered', () => {
    withKek(KEK_A);
    const s = seal('payload');
    const bad: Sealed = { ...s, authTag: Buffer.from(s.authTag) };
    bad.authTag[0] ^= 0xff;
    expect(() => open(bad)).toThrow();
  });

  it('throws when decrypting under the wrong KEK', () => {
    withKek(KEK_A);
    const s = seal('payload');
    withKek(KEK_B);
    expect(() => open(s)).toThrow();
  });

  it('refuses an absent or wrong-size KEK', () => {
    withKek(undefined);
    expect(kekAvailable()).toBe(false);
    expect(() => seal('x')).toThrow(/required/);
    withKek(KEK_SHORT);
    expect(() => seal('x')).toThrow(/32 bytes/);
  });
});

describe('connection-token store — round trip', () => {
  it('seals on save and decrypts on load; DB holds no plaintext', () => {
    withKek(KEK_A);
    const token = { access: 'ACCESS-XYZ', refresh: 'REFRESH-XYZ', expiry: 12345 };
    saveConnectionToken(SYSTEM_OWNER, 'google', 'me@x.io', token);

    expect(JSON.parse(loadConnectionToken(SYSTEM_OWNER, 'google', 'me@x.io')!)).toEqual(token);

    // No plaintext access/refresh material in the stored ciphertext blob.
    const row = sqlite.prepare(`SELECT ciphertext FROM connection_tokens WHERE provider = 'google'`).get() as { ciphertext: Buffer };
    expect(row.ciphertext.toString('latin1')).not.toContain('ACCESS-XYZ');
    expect(row.ciphertext.toString('latin1')).not.toContain('REFRESH-XYZ');
  });

  it('upserts (one row per owner+provider+account)', () => {
    withKek(KEK_A);
    saveConnectionToken(SYSTEM_OWNER, 'google', 'me@x.io', { access: 'first' });
    saveConnectionToken(SYSTEM_OWNER, 'google', 'me@x.io', { access: 'second' });
    const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM connection_tokens WHERE provider = 'google'`).get() as { n: number }).n;
    expect(n).toBe(1);
    expect(JSON.parse(loadConnectionToken(SYSTEM_OWNER, 'google', 'me@x.io')!)).toEqual({ access: 'second' });
  });

  it('returns null for an unknown connection', () => {
    withKek(KEK_A);
    expect(loadConnectionToken(SYSTEM_OWNER, 'outlook', 'nobody@x.io')).toBeNull();
  });
});
