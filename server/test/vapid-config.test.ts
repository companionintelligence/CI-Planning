import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { hydrateVapidConfig, vapidConfigState } from '../src/services/vapid-config.js';

/**
 * Automatic Web Push (VAPID) provisioning — services/vapid-config.ts.
 *
 * The test env sets no VAPID_* and no CP_KEK_B64, so config.pins.vapid starts false
 * and these tests drive the config singleton + app_config directly (the pattern
 * google-config.test.ts uses), restoring env + singleton state after each case.
 */
const KEY = randomBytes(32).toString('base64');

const SAVED = {
  kek: process.env.CP_KEK_B64,
  publicKey: config.vapidPublicKey,
  privateKey: config.vapidPrivateKey,
  subject: config.vapidSubject,
  envPinned: config.pins.vapid,
};

function readRow(key: string): string | null {
  const row = sqlite.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function reset(): void {
  sqlite.prepare(`DELETE FROM app_config WHERE key LIKE 'vapid_%'`).run();
  config.vapidPublicKey = '';
  config.vapidPrivateKey = '';
  config.pins.vapid = false;
}

beforeEach(() => {
  reset();
  process.env.CP_KEK_B64 = KEY;
});

afterEach(() => {
  sqlite.prepare(`DELETE FROM app_config WHERE key LIKE 'vapid_%'`).run();
  if (SAVED.kek === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED.kek;
  config.vapidPublicKey = SAVED.publicKey;
  config.vapidPrivateKey = SAVED.privateKey;
  config.vapidSubject = SAVED.subject;
  config.pins.vapid = SAVED.envPinned;
});

describe('first boot — auto-generation', () => {
  it('generates a keypair, hydrates the config, and seals the private key at rest (KEK present)', async () => {
    await hydrateVapidConfig();

    // Config singleton is populated → push.ts pushEnabled() would return true.
    expect(config.vapidPublicKey).toBeTruthy();
    expect(config.vapidPrivateKey).toBeTruthy();

    // Public key stored in the clear; private key stored as a SEALED envelope.
    expect(readRow('vapid_public_key')).toBe(config.vapidPublicKey);
    const privRaw = readRow('vapid_private_key')!;
    const env = JSON.parse(privRaw);
    expect(env).toMatchObject({ sealed: true, key_version: config.kek.currentVersion });
    // The plaintext private key never lands in the DB.
    expect(privRaw).not.toContain(config.vapidPrivateKey);

    const state = await vapidConfigState();
    expect(state).toMatchObject({ source: 'generated', configured: true, sealed: true, hasStoredPair: true });
    // No key material leaks through the diagnostic state.
    expect(JSON.stringify(state)).not.toContain(config.vapidPrivateKey);
  });

  it('reuses the stored pair across a simulated restart (stable — never rotates)', async () => {
    await hydrateVapidConfig();
    const pub1 = config.vapidPublicKey;
    const priv1 = config.vapidPrivateKey;

    // Simulate a fresh boot: singleton back at defaults, then hydrate again (app.ts does this).
    config.vapidPublicKey = '';
    config.vapidPrivateKey = '';
    await hydrateVapidConfig();

    expect(config.vapidPublicKey).toBe(pub1);
    expect(config.vapidPrivateKey).toBe(priv1);
  });
});

describe('no KEK — plaintext fallback', () => {
  it('generates and stores the private key UNSEALED (push still comes up)', async () => {
    delete process.env.CP_KEK_B64;

    await hydrateVapidConfig();
    expect(config.vapidPrivateKey).toBeTruthy();

    const env = JSON.parse(readRow('vapid_private_key')!);
    expect(env.sealed).toBe(false);
    expect(env.key).toBe(config.vapidPrivateKey); // plaintext at rest

    const state = await vapidConfigState();
    expect(state).toMatchObject({ source: 'generated', configured: true, sealed: false, kekAvailable: false });
  });
});

describe('env-pinned', () => {
  it('is a no-op when both env keys are set — never touches the DB or singleton', async () => {
    config.pins.vapid = true;
    config.vapidPublicKey = 'ENV_PUB';
    config.vapidPrivateKey = 'ENV_PRIV';

    await hydrateVapidConfig();

    expect(config.vapidPublicKey).toBe('ENV_PUB');
    expect(config.vapidPrivateKey).toBe('ENV_PRIV');
    expect(readRow('vapid_public_key')).toBeNull();
    expect(readRow('vapid_private_key')).toBeNull();
    expect((await vapidConfigState()).source).toBe('env');
  });
});

describe('malformed stored envelope', () => {
  it('regenerates when the unsealed envelope has no usable key (corrupt row)', async () => {
    // A row that parses but is missing the key — must not be applied as an undefined key.
    sqlite
      .prepare(`INSERT INTO app_config (key, value) VALUES ('vapid_private_key', ?)`)
      .run(JSON.stringify({ sealed: false }));
    sqlite
      .prepare(`INSERT INTO app_config (key, value) VALUES ('vapid_public_key', 'stale-pub')`)
      .run();

    await hydrateVapidConfig();

    // Regenerated into a real string pair, and the corrupt row was overwritten.
    expect(typeof config.vapidPrivateKey).toBe('string');
    expect(config.vapidPrivateKey).toBeTruthy();
    const env = JSON.parse(readRow('vapid_private_key')!);
    expect(env.sealed).toBe(true); // KEK present in this block → freshly sealed
    expect((await vapidConfigState()).configured).toBe(true);
  });
});

describe('sealed key becomes unreadable (KEK removed/rotated)', () => {
  it('stays dormant instead of regenerating — existing subscriptions survive', async () => {
    await hydrateVapidConfig(); // seals under KEY
    const storedBefore = readRow('vapid_private_key')!;

    // Simulate a restart where CP_KEK_B64 was lost: singleton reset, KEK gone.
    config.vapidPublicKey = '';
    config.vapidPrivateKey = '';
    delete process.env.CP_KEK_B64;

    await hydrateVapidConfig();

    // Dormant: no usable pair applied…
    expect(config.vapidPublicKey).toBe('');
    expect(config.vapidPrivateKey).toBe('');
    expect(await vapidConfigState()).toMatchObject({ source: 'dormant', configured: false });
    // …and crucially the stored (undecryptable) pair was NOT overwritten.
    expect(readRow('vapid_private_key')).toBe(storedBefore);
  });
});
