import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startTestServer, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { hydrateGoogleConfig, saveGoogleConfig, googleConfigState } from '../src/services/google-config.js';

/**
 * In-app Google connection setup — /api/google-config + services/google-config.ts.
 *
 * The test env pins GOOGLE_MODE=fixture (vitest env), so these tests flip
 * config.google.envPinned/mode on the singleton per test and restore them after —
 * the same pattern oauth.test.ts uses for its live-mode setup.
 */
let srv: TestServer;

const NON_ADMIN = { 'x-test-scopes': 'planning:read,planning:write' };
const KEY = randomBytes(32).toString('base64');
const SAVED = {
  kek: process.env.CP_KEK_B64,
  mode: config.google.mode,
  envPinned: config.google.envPinned,
  clientId: config.google.clientId,
  clientSecret: config.google.clientSecret,
};

async function get(headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/google-config`, { headers });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function put(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/google-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  sqlite.prepare(`DELETE FROM app_config`).run();
  process.env.CP_KEK_B64 = KEY;
  // Simulate the shipping default: GOOGLE_MODE unset ⇒ off, not env-pinned.
  config.google.envPinned = false;
  config.google.mode = 'off';
  config.google.clientId = undefined;
  config.google.clientSecret = undefined;
});

afterEach(() => {
  sqlite.prepare(`DELETE FROM app_config`).run();
  if (SAVED.kek === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED.kek;
  config.google.mode = SAVED.mode;
  config.google.envPinned = SAVED.envPinned;
  config.google.clientId = SAVED.clientId;
  config.google.clientSecret = SAVED.clientSecret;
});

describe('admin gate', () => {
  it('403s a non-admin credential on GET and PUT', async () => {
    expect((await get(NON_ADMIN)).status).toBe(403);
    expect((await put({ enabled: false }, NON_ADMIN)).status).toBe(403);
  });

  it('returns the redacted state to an admin', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ source: 'off', mode: 'off', envPinned: false, kekAvailable: true, enabled: false });
    expect(body.redirectUri).toContain('/api/oauth/google/callback');
    expect(JSON.stringify(body)).not.toContain('client_secret');
  });
});

describe('PUT /api/google-config', () => {
  it('saves the client, flips live mode at runtime, and never echoes the secret', async () => {
    const { status, body } = await put({
      client_id: 'test-id.apps.googleusercontent.com',
      client_secret: 'GOCSPX-super-secret',
      enabled: true,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      source: 'app',
      mode: 'live',
      clientId: 'test-id.apps.googleusercontent.com',
      hasClientSecret: true,
      enabled: true,
    });
    expect(JSON.stringify(body)).not.toContain('GOCSPX-super-secret');

    // The config singleton was hot-applied — no restart.
    expect(config.google.mode).toBe('live');
    expect(config.google.clientId).toBe('test-id.apps.googleusercontent.com');
    expect(config.google.clientSecret).toBe('GOCSPX-super-secret');

    // The stored secret is SEALED — the plaintext never touches the DB.
    const rows = sqlite.prepare(`SELECT key, value FROM app_config`).all() as { key: string; value: string }[];
    const secretRow = rows.find((r) => r.key === 'google_client_secret')!;
    expect(secretRow.value).not.toContain('GOCSPX-super-secret');
    expect(JSON.parse(secretRow.value)).toMatchObject({ key_version: config.kek.currentVersion });
  });

  it('a blank secret on re-save keeps the stored one; null clears it', async () => {
    await put({ client_id: 'id-1', client_secret: 's3cret', enabled: true });
    const kept = await put({ client_id: 'id-1', enabled: true });
    expect(kept.body.hasClientSecret).toBe(true);
    expect(config.google.clientSecret).toBe('s3cret');
    const cleared = await put({ client_id: 'id-1', client_secret: null, enabled: true });
    expect(cleared.body.hasClientSecret).toBe(false);
    expect(config.google.clientSecret).toBeUndefined();
  });

  it('disable returns mode to off and restores the env-derived client', async () => {
    await put({ client_id: 'id-1', enabled: true });
    expect(config.google.mode).toBe('live');
    const { body } = await put({ enabled: false });
    expect(body).toMatchObject({ source: 'off', mode: 'off', enabled: false });
    expect(config.google.mode).toBe('off');
  });

  it('refuses when GOOGLE_MODE is env-pinned (409)', async () => {
    config.google.envPinned = true;
    const { status } = await put({ client_id: 'id-1', enabled: true });
    expect(status).toBe(409);
  });

  it('requires a KEK to enable or store a secret (400)', async () => {
    delete process.env.CP_KEK_B64;
    const enable = await put({ client_id: 'id-1', enabled: true });
    expect(enable.status).toBe(400);
    expect(enable.body.error).toContain('CP_KEK_B64');
    // Saving DISABLED without a secret is still allowed (drafting the client id).
    expect((await put({ client_id: 'id-1', enabled: false })).status).toBe(200);
  });

  it('requires a client id to enable (400) and a boolean enabled flag', async () => {
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({ client_id: 'x' })).status).toBe(400);
  });
});

// FTUE · T12 (#348) — the "Try with sample data" fixture-mode toggle.
describe('fixture mode', () => {
  it('enables with no client id and no KEK, persists the marker, and survives boot hydration', () => {
    delete process.env.CP_KEK_B64; // fixture mode must not need a KEK
    const res = saveGoogleConfig({ enabled: true, mode: 'fixture' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state).toMatchObject({ source: 'app', mode: 'fixture', enabled: true, clientId: null });
    expect(config.google.mode).toBe('fixture');

    // Simulate a restart: singleton back at defaults, then re-hydrate from app_config.
    config.google.mode = 'off';
    hydrateGoogleConfig();
    expect(config.google.mode).toBe('fixture');
    expect(googleConfigState().mode).toBe('fixture');
  });

  it('disabling clears the marker and returns to off', () => {
    saveGoogleConfig({ enabled: true, mode: 'fixture' });
    expect(config.google.mode).toBe('fixture');

    const cleared = saveGoogleConfig({ enabled: false });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.state).toMatchObject({ source: 'off', mode: 'off' });
    expect(config.google.mode).toBe('off');

    const rows = sqlite.prepare(`SELECT key FROM app_config WHERE key = 'google_mode'`).all();
    expect(rows).toEqual([]);
  });

  it('switching to fixture then back to live restores the previously-saved client untouched', () => {
    saveGoogleConfig({ clientId: 'id-1', clientSecret: 'sekret', enabled: true });
    saveGoogleConfig({ enabled: true, mode: 'fixture' });
    expect(config.google.mode).toBe('fixture');

    const back = saveGoogleConfig({ enabled: true }); // mode omitted => live path
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.state).toMatchObject({ mode: 'live', clientId: 'id-1', hasClientSecret: true });
    expect(config.google.clientId).toBe('id-1');
  });

  it('PUT /api/google-config: admin sets fixture mode, non-admin 403s, an invalid mode 400s', async () => {
    const asAdmin = await put({ enabled: true, mode: 'fixture' });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.mode).toBe('fixture');

    const asNonAdmin = await put({ enabled: true, mode: 'fixture' }, NON_ADMIN);
    expect(asNonAdmin.status).toBe(403);

    const badMode = await put({ enabled: true, mode: 'bogus' });
    expect(badMode.status).toBe(400);
  });

  // Adversarial review caught this: the boot-time guard in config.ts (NODE_ENV=
  // production + GOOGLE_MODE=fixture refuses to start without CP_ALLOW_FIXTURE=true)
  // only runs once at process start against the ENV variable — it does nothing to stop
  // this RUNTIME path from flipping a live production deployment into fixture mode via
  // a single admin (or FTUE onboarding) click. saveGoogleConfig must re-check it.
  describe('production guard (mirrors config.ts boot check)', () => {
    const savedNodeEnv = process.env.NODE_ENV;
    const savedAllowFixture = process.env.CP_ALLOW_FIXTURE;
    afterEach(() => {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
      if (savedAllowFixture === undefined) delete process.env.CP_ALLOW_FIXTURE; else process.env.CP_ALLOW_FIXTURE = savedAllowFixture;
    });

    it('refuses fixture mode in production without CP_ALLOW_FIXTURE', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CP_ALLOW_FIXTURE;
      const res = saveGoogleConfig({ enabled: true, mode: 'fixture' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('fixture_forbidden_in_production');
      expect(config.google.mode).not.toBe('fixture'); // nothing was persisted or hot-applied
    });

    it('allows fixture mode in production with the explicit CP_ALLOW_FIXTURE escape hatch', () => {
      process.env.NODE_ENV = 'production';
      process.env.CP_ALLOW_FIXTURE = 'true';
      const res = saveGoogleConfig({ enabled: true, mode: 'fixture' });
      expect(res.ok).toBe(true);
    });

    it('PUT /api/google-config 403s the fixture toggle in production without CP_ALLOW_FIXTURE', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CP_ALLOW_FIXTURE;
      const res = await put({ enabled: true, mode: 'fixture' });
      expect(res.status).toBe(403);
    });
  });
});

describe('boot hydration', () => {
  it('re-applies a saved app config after a simulated restart', () => {
    saveGoogleConfig({ clientId: 'boot-id', clientSecret: 'boot-secret', enabled: true });
    // Simulate a fresh boot: singleton back at defaults, then hydrate (app.ts does this).
    config.google.mode = 'off';
    config.google.clientId = undefined;
    config.google.clientSecret = undefined;
    hydrateGoogleConfig();
    expect(config.google.mode).toBe('live');
    expect(config.google.clientId).toBe('boot-id');
    expect(config.google.clientSecret).toBe('boot-secret');
    expect(googleConfigState().source).toBe('app');
  });

  it('is a no-op when env-pinned', () => {
    saveGoogleConfig({ clientId: 'boot-id', enabled: true });
    config.google.envPinned = true;
    config.google.mode = 'fixture';
    hydrateGoogleConfig();
    expect(config.google.mode).toBe('fixture'); // untouched
  });
});
