import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { issueApiKey } from '../src/lib/auth/apiKey.js';
import { SCOPE_READ, SCOPE_WRITE } from '../src/lib/auth/types.js';
import { startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase I (PR1) — the standalone api-key auth surface.
 *
 * `config.auth.mode` is a runtime singleton the middleware reads per request, so a
 * single built app serves every mode; tests flip it and ALWAYS restore `test` in
 * afterEach (the suite shares one sequential DB + process — a leaked `standalone`
 * would 401 every later file).
 */

// Every mounted /api router base path; requireAuth runs before the routers, so a
// credential-free request 401s regardless of whether the path/query is otherwise valid.
const GATED_PATHS = [
  '/api/tasks',
  '/api/blocks',
  '/api/block-templates',
  '/api/possible-tasks',
  '/api/tags',
  '/api/jobs',
  '/api/prefs',
  '/api/schedule',
  '/api/summary',
  '/api/memory',
  '/api/patterns',
  '/api/pattern-types',
  '/api/flight-plan',
  '/api/pattern-blocks',
  '/api/pattern-prefs',
  '/api/notifications',
  '/api/backup',
  '/api/events', // the SSE stream is gated too
];

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
afterEach(() => {
  config.auth.mode = 'test';
  sqlite.exec('DELETE FROM api_keys');
});

const withKey = (key: string) => ({ headers: { 'x-api-key': key } });

describe('requireAuth — test mode (default)', () => {
  it('injects the system owner with no credential', async () => {
    config.auth.mode = 'test';
    const { status } = await api(srv.url, '/api/tasks');
    expect(status).toBe(200);
  });
});

describe('requireAuth — standalone mode, no credential', () => {
  it('401s on every gated route', async () => {
    config.auth.mode = 'standalone';
    for (const path of GATED_PATHS) {
      const { status, body } = await api(srv.url, path);
      expect(status, `${path} should be 401`).toBe(401);
      expect(body).toEqual({ error: 'unauthenticated' });
    }
  });

  it('allow-lists /api/health (200 without a key)', async () => {
    config.auth.mode = 'standalone';
    const { status, body } = await api(srv.url, '/api/health');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it('rejects an unknown / malformed key', async () => {
    config.auth.mode = 'standalone';
    const { status } = await api(srv.url, '/api/tasks', withKey('cpk_deadbeef'));
    expect(status).toBe(401);
  });
});

describe('requireAuth — standalone mode, api key', () => {
  it('accepts a valid read+write key', async () => {
    config.auth.mode = 'standalone';
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ, SCOPE_WRITE]);
    const { status } = await api(srv.url, '/api/tasks', withKey(key));
    expect(status).toBe(200);
  });

  it('accepts the key as an ?api_key= query param (for EventSource)', async () => {
    config.auth.mode = 'standalone';
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    const { status } = await api(srv.url, `/api/tasks?api_key=${key}`);
    expect(status).toBe(200);
  });

  it('403s a read-only key on a mutation, 200 on a read', async () => {
    config.auth.mode = 'standalone';
    const ro = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    const read = await api(srv.url, '/api/tasks', withKey(ro));
    expect(read.status).toBe(200);
    const write = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'x' }, ...withKey(ro) });
    expect(write.status).toBe(403);
    expect(write.body).toEqual({ error: 'forbidden' });
  });

  it('401s an expired key', async () => {
    config.auth.mode = 'standalone';
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    sqlite.prepare(`UPDATE api_keys SET expires_at = ? WHERE prefix = ?`).run('2000-01-01T00:00:00.000Z', key.slice(0, 5));
    const { status } = await api(srv.url, '/api/tasks', withKey(key));
    expect(status).toBe(401);
  });

  it('401s a revoked key', async () => {
    config.auth.mode = 'standalone';
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    sqlite.prepare(`UPDATE api_keys SET revoked_at = ? WHERE prefix = ?`).run(new Date().toISOString(), key.slice(0, 5));
    const { status } = await api(srv.url, '/api/tasks', withKey(key));
    expect(status).toBe(401);
  });

  it('advances last_used_at after an accepted call', async () => {
    config.auth.mode = 'standalone';
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    const before = sqlite.prepare(`SELECT last_used_at FROM api_keys WHERE prefix = ?`).get(key.slice(0, 5)) as { last_used_at: string | null };
    expect(before.last_used_at).toBeNull();
    await api(srv.url, '/api/tasks', withKey(key));
    const after = sqlite.prepare(`SELECT last_used_at FROM api_keys WHERE prefix = ?`).get(key.slice(0, 5)) as { last_used_at: string | null };
    expect(after.last_used_at).not.toBeNull();
  });
});

describe('api key storage — secrets never plaintext', () => {
  it('stores only the SHA-256 hash, never the raw key', () => {
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    const row = sqlite.prepare(`SELECT * FROM api_keys WHERE prefix = ?`).get(key.slice(0, 5)) as Record<string, unknown>;
    // key_hash is the 64-char SHA-256 hex, not the 68-char raw key.
    expect(row.key_hash).toHaveLength(64);
    expect(row.key_hash).not.toBe(key);
    // The full raw key appears in NO stored column (only its 5-char prefix does).
    const stored = Object.values(row).map(String).join('|');
    expect(stored).not.toContain(key);
  });
});
