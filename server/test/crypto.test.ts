import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { seal, open, loadKek, rotateKek } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

// 32-byte AES-256 keys, base64-encoded, for the KEK env vars.
const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');
const KEY_V3 = randomBytes(32).toString('base64');

// Snapshot + restore the KEK env this file mutates (shared process across files).
const SAVED = {
  CP_KEK_B64: process.env.CP_KEK_B64,
  CP_KEK_B64_V1: process.env.CP_KEK_B64_V1,
  CP_KEK_B64_V2: process.env.CP_KEK_B64_V2,
  CP_KEK_B64_V3: process.env.CP_KEK_B64_V3,
};

function restore(key: keyof typeof SAVED) {
  if (SAVED[key] === undefined) delete process.env[key];
  else process.env[key] = SAVED[key];
}

function seedToken(account: string, plaintext: string, keyB64: string, keyVersion: number) {
  const sealed = seal(plaintext, Buffer.from(keyB64, 'base64'));
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
    )
    .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext, keyVersion);
}

function tokenRow(account: string) {
  return sqlite
    .prepare('SELECT iv, auth_tag, ciphertext, key_version FROM connection_tokens WHERE account = ?')
    .get(account) as { iv: string; auth_tag: string; ciphertext: string; key_version: number };
}

describe('crypto — fresh IV', () => {
  it('two seals of identical plaintext under the same KEK differ in iv AND ciphertext', () => {
    const kek = Buffer.from(KEY_V1, 'base64');
    const a = seal('the-same-secret', kek);
    const b = seal('the-same-secret', kek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Both still decrypt back to the original.
    expect(open(a, kek)).toBe('the-same-secret');
    expect(open(b, kek)).toBe('the-same-secret');
  });
});

describe('crypto — loadKek versioning', () => {
  afterEach(() => {
    restore('CP_KEK_B64');
    restore('CP_KEK_B64_V2');
  });

  it('no-arg loads CP_KEK_B64 (unchanged behavior)', () => {
    process.env.CP_KEK_B64 = KEY_V1;
    expect(loadKek().toString('base64')).toBe(KEY_V1);
  });

  it('versioned loads CP_KEK_B64_V{n}; falls back to CP_KEK_B64 for the current version', () => {
    process.env.CP_KEK_B64 = KEY_V1; // current version is 1 (config default)
    process.env.CP_KEK_B64_V2 = KEY_V2;
    expect(loadKek(2).toString('base64')).toBe(KEY_V2);
    // version 1 == config.kek.currentVersion → falls back to CP_KEK_B64.
    expect(loadKek(1).toString('base64')).toBe(KEY_V1);
  });

  it('throws when the env var is absent', () => {
    delete process.env.CP_KEK_B64;
    expect(() => loadKek()).toThrow(/CP_KEK_B64/);
  });
});

describe('crypto — rotateKek', () => {
  beforeEach(() => {
    resetDb();
    process.env.CP_KEK_B64 = KEY_V1; // current key (version 1)
  });
  afterEach(() => {
    restore('CP_KEK_B64');
    restore('CP_KEK_B64_V1');
    restore('CP_KEK_B64_V2');
    restore('CP_KEK_B64_V3');
  });

  it('re-seals every row under the new key, bumps key_version, stays decryptable', () => {
    seedToken('a@x.io', 'secret-A', KEY_V1, 1);
    seedToken('b@x.io', 'secret-B', KEY_V1, 1);

    const { rotated } = rotateKek(2, KEY_V2);
    expect(rotated).toBe(2);

    for (const acct of ['a@x.io', 'b@x.io']) {
      const row = tokenRow(acct);
      expect(row.key_version).toBe(2);
      // Decryptable with the NEW key only.
      const plain = open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, Buffer.from(KEY_V2, 'base64'));
      expect(plain).toBe(acct === 'a@x.io' ? 'secret-A' : 'secret-B');
      // The old key can no longer open it.
      expect(() => open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, Buffer.from(KEY_V1, 'base64'))).toThrow();
    }
  });

  it('only rotates rows that lag the target version (already-current rows are skipped)', () => {
    // Two rows already at v2 and one lagging at v1. Rotate to v3: all three lag v3, so all
    // three are re-sealed. The skip predicate (key_version <> target) is what keeps a
    // re-run from double-sealing — verified by the refuse-on-≤-max test below.
    seedToken('lag@x.io', 'secret-lag', KEY_V1, 1);
    seedToken('cur1@x.io', 'secret-1', KEY_V2, 2);
    seedToken('cur2@x.io', 'secret-2', KEY_V2, 2);
    process.env.CP_KEK_B64_V1 = KEY_V1;
    process.env.CP_KEK_B64_V2 = KEY_V2;

    expect(rotateKek(3, KEY_V3).rotated).toBe(3);
    for (const a of ['lag@x.io', 'cur1@x.io', 'cur2@x.io']) {
      expect(tokenRow(a).key_version).toBe(3);
    }
  });

  it('a second rotation to the SAME version is refused — no double-seal (idempotent)', () => {
    seedToken('a@x.io', 'secret-A', KEY_V1, 1);
    expect(rotateKek(2, KEY_V2).rotated).toBe(1); // first run rotates the row
    const after = tokenRow('a@x.io');
    // Re-running the SAME rotation throws (≤ max) — the row is never re-sealed.
    expect(() => rotateKek(2, KEY_V2)).toThrow(/greater than/);
    const stillAfter = tokenRow('a@x.io');
    expect(stillAfter.iv).toBe(after.iv); // untouched
    expect(stillAfter.ciphertext).toBe(after.ciphertext);
    expect(stillAfter.key_version).toBe(2);
  });

  it('reads the new key from CP_KEK_B64_V{n} when no key arg is passed', () => {
    seedToken('a@x.io', 'secret-A', KEY_V1, 1);
    process.env.CP_KEK_B64_V2 = KEY_V2;
    expect(rotateKek(2).rotated).toBe(1);
    expect(tokenRow('a@x.io').key_version).toBe(2);
  });

  it('refuses (throws, no writes) when the new key is not 32 bytes', () => {
    seedToken('a@x.io', 'secret-A', KEY_V1, 1);
    const shortKey = randomBytes(16).toString('base64');
    expect(() => rotateKek(2, shortKey)).toThrow(/32 bytes/);
    // Row untouched.
    expect(tokenRow('a@x.io').key_version).toBe(1);
  });

  it('refuses when newVersion is not greater than the existing max key_version', () => {
    seedToken('a@x.io', 'secret-A', KEY_V2, 2); // already at v2
    expect(() => rotateKek(2, KEY_V2)).toThrow(/greater than/);
    expect(tokenRow('a@x.io').key_version).toBe(2);
  });
});
