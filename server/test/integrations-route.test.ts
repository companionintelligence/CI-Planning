import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startTestServer, api, resetDb, type TestServer } from './helpers.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';

// WP7: GET /api/integrations widens google to { mode, liveEnabled, connections } while
// leaving ollama + push UNCHANGED. This guards the wire contract + the no-token-leak rule.
let srv: TestServer;
const KEY_B64 = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

beforeEach(() => {
  resetDb();
  process.env.CP_KEK_B64 = KEY_B64;
});
afterEach(() => {
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
});

describe('GET /api/integrations — WP7 google connections', () => {
  it('google block exposes liveEnabled boolean + connections array ([] when no tokens)', async () => {
    const r = await api(srv.url, '/api/integrations');
    expect(r.status).toBe(200);
    expect(typeof r.body.google.liveEnabled).toBe('boolean');
    // Test env is GOOGLE_MODE=fixture → not live.
    expect(r.body.google.liveEnabled).toBe(false);
    expect(Array.isArray(r.body.google.connections)).toBe(true);
    expect(r.body.google.connections).toEqual([]);
    expect(typeof r.body.google.mode).toBe('string');
  });

  it('surfaces a seeded connection with the locked ConnectionRecord shape', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const sealed = seal(JSON.stringify({ accessToken: 'ya29.SECRET', refreshToken: '1//SECRET', expiresAt: future }), Buffer.from(KEY_B64, 'base64'));
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
         VALUES (?, ?, 'google', 'me@x.io', ?, ?, ?, 1, 'active')`,
      )
      .run(newId(), SYSTEM_OWNER, sealed.iv, sealed.authTag, sealed.ciphertext);

    const r = await api(srv.url, '/api/integrations');
    expect(r.body.google.connections).toHaveLength(1);
    const c = r.body.google.connections[0];
    // llm-7: one shape for every connection, so `createdAt` (from the old
    // ConnectionSummary) joins the google health fields here.
    expect(Object.keys(c).sort()).toEqual(
      ['account', 'createdAt', 'expiresAt', 'lastError', 'lastSyncAt', 'mappedEventCount', 'provider', 'status'].sort(),
    );
    expect(c).toMatchObject({ provider: 'google', account: 'me@x.io', status: 'connected', expiresAt: future });
  });

  it('ollama + push blocks keep their pre-WP7 shape', async () => {
    const r = await api(srv.url, '/api/integrations');
    // ollama
    expect(typeof r.body.ollama.available).toBe('boolean');
    expect(Array.isArray(r.body.ollama.models)).toBe(true);
    expect(typeof r.body.ollama.fastModel).toBe('string');
    expect(typeof r.body.ollama.qualityModel).toBe('string');
    expect(typeof r.body.ollama.embedModel).toBe('string');
    // push (Phase H) — VAPID keys now auto-provisioned on boot, so push reports configured
    expect(typeof r.body.push.configured).toBe('boolean');
    expect(r.body.push.configured).toBe(true);
  });

  it('NO-LEAK GUARD: response body contains no token material', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const sealed = seal(JSON.stringify({ accessToken: 'ya29.SECRET-ACCESS', refreshToken: '1//SECRET-REFRESH', expiresAt: future }), Buffer.from(KEY_B64, 'base64'));
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
         VALUES (?, ?, 'google', 'leak@x.io', ?, ?, ?, 1, 'active')`,
      )
      .run(newId(), SYSTEM_OWNER, sealed.iv, sealed.authTag, sealed.ciphertext);

    const r = await api(srv.url, '/api/integrations');
    const body = JSON.stringify(r.body);
    for (const forbidden of ['ciphertext', 'authTag', 'auth_tag', 'accessToken', 'refreshToken', 'SECRET', 'key_version', 'keyVersion']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
