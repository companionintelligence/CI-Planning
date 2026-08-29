import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  memoryCreds,
  memoryHeaders,
  memoryMode,
  storeMemoryConnection,
  deleteMemoryConnection,
  graphData,
  graphSearch,
  graphContext,
  MemoryUnavailable,
  MEMORY_PROVIDER,
} from '../src/connectors/memory.js';
import { memoryConnectorAvailable, memoryStatus } from '../src/services/memory.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase AA · AA0 — CI-Server memory connector. Covers the creds resolution chain
 * (settings row → env fallback → null; env gated off under multi-tenant SSO), header
 * coexistence, MemoryUnavailable degradation in live mode (including the 3xx
 * redirect refusal that keeps x-api-key on-origin), the fixture graph round-trip
 * (window filtering), the
 * connect/disconnect routes (KEK-encrypted storage, no plaintext leak), and the
 * memory_pull_enabled flag round-trip through PATCH /api/prefs (never raw SQL only).
 */

const OWNER = SYSTEM_OWNER;
const KEY_B64 = randomBytes(32).toString('base64');

// Env juggling: the suite files share one process, so save/restore everything we touch.
const SAVED = {
  kek: process.env.CP_KEK_B64,
  url: process.env.CI_SERVER_URL,
  apiKey: process.env.CI_SERVER_API_KEY,
  mode: process.env.MEMORY_MODE,
};

beforeAll(() => {
  process.env.CP_KEK_B64 = KEY_B64;
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('CP_KEK_B64', SAVED.kek);
  restore('CI_SERVER_URL', SAVED.url);
  restore('CI_SERVER_API_KEY', SAVED.apiKey);
  restore('MEMORY_MODE', SAVED.mode);
});

beforeEach(() => {
  resetDb(); // clears connection_tokens
  // Redundant since resetDb's baseline started pinning the push-side fields (it runs
  // immediately above), but kept as a local guard so this suite still isolates itself
  // if that baseline is ever trimmed. Safe to drop with the 0012 block in helpers.ts.
  sqlite.exec(`
    UPDATE scheduling_prefs SET
      memory_sync_enabled = 0,
      memory_account = NULL,
      memory_last_synced_at = NULL,
      memory_sync_completed = 1,
      memory_sync_habits = 1,
      memory_sync_reflections = 1;
  `);
  delete process.env.CI_SERVER_URL;
  delete process.env.CI_SERVER_API_KEY;
  process.env.MEMORY_MODE = 'fixture';
});

describe('creds resolution chain', () => {
  it('resolves to null when neither a settings row nor env is present', async () => {
    expect(await memoryCreds(OWNER)).toBeNull();
    expect(await memoryConnectorAvailable(OWNER)).toBe(false);
  });

  it('falls back to env (CI_SERVER_URL / CI_SERVER_API_KEY)', async () => {
    process.env.CI_SERVER_URL = 'http://ci.local:3000';
    process.env.CI_SERVER_API_KEY = 'env-key';
    expect(await memoryCreds(OWNER)).toEqual({ url: 'http://ci.local:3000', apiKey: 'env-key', source: 'env', authKind: null });
    expect(await memoryConnectorAvailable(OWNER)).toBe(true);
  });

  it('honors the env fallback in single-tenant modes but IGNORES it under multi-tenant SSO', async () => {
    process.env.CI_SERVER_URL = 'http://ci.local:3000';
    process.env.CI_SERVER_API_KEY = 'env-key';
    const saved = { mode: config.auth.mode, disableOidc: config.auth.disableOidc };
    try {
      // Single-tenant modes: standalone and sso+DISABLE_OIDC (local login) keep the fallback.
      config.auth.mode = 'standalone';
      expect((await memoryCreds(OWNER))?.source).toBe('env');
      config.auth.mode = 'sso';
      config.auth.disableOidc = true;
      expect((await memoryCreds(OWNER))?.source).toBe('env');

      // Multi-tenant SSO: one shared env key would map every owner onto ONE
      // CI-Server user (ApiKeyStrategy derives userId from the key) — fallback off.
      config.auth.disableOidc = false;
      expect(await memoryCreds(OWNER)).toBeNull();
      expect(await memoryConnectorAvailable(OWNER)).toBe(false);

      // Per-owner settings rows are unaffected by the gate.
      await storeMemoryConnection(OWNER, { url: 'https://settings.local:8443', apiKey: 'k' });
      expect(await memoryCreds(OWNER)).toMatchObject({ url: 'https://settings.local:8443', source: 'settings' });
    } finally {
      config.auth.mode = saved.mode;
      config.auth.disableOidc = saved.disableOidc;
    }
  });

  it('a stored settings connection wins over env', async () => {
    process.env.CI_SERVER_URL = 'http://env.local:3000';
    await storeMemoryConnection(OWNER, { url: 'https://settings.local:8443', apiKey: 'settings-key' });
    const creds = await memoryCreds(OWNER);
    expect(creds).toMatchObject({ url: 'https://settings.local:8443', apiKey: 'settings-key', source: 'settings' });
  });

  it('stores the creds sealed — plaintext never appears in the row', async () => {
    await storeMemoryConnection(OWNER, { url: 'https://settings.local:8443', apiKey: 'super-secret-key' });
    const row = sqlite
      .prepare(`SELECT account, iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ?`)
      .get(OWNER, MEMORY_PROVIDER) as { account: string; iv: string; auth_tag: string; ciphertext: string };
    expect(row.account).toBe('settings.local:8443');
    expect(row.ciphertext).not.toContain('super-secret-key');
    expect(row.ciphertext).not.toContain('settings.local');
  });

  it('reconnecting replaces the previous row (one logical connection per owner)', async () => {
    await storeMemoryConnection(OWNER, { url: 'http://a.local:3000', apiKey: 'k1' });
    await storeMemoryConnection(OWNER, { url: 'http://b.local:3000', apiKey: 'k2' });
    const rows = sqlite
      .prepare(`SELECT account FROM connection_tokens WHERE owner_id = ? AND provider = ?`)
      .all(OWNER, MEMORY_PROVIDER) as { account: string }[];
    expect(rows).toEqual([{ account: 'b.local:3000' }]);
    expect((await memoryCreds(OWNER))?.url).toBe('http://b.local:3000');
    expect(await deleteMemoryConnection(OWNER)).toBe(1);
    expect(await memoryCreds(OWNER)).toBeNull();
  });
});

describe('headers', () => {
  it('x-api-key and Bearer COEXIST when both are set (CI-Import-Tools pattern)', () => {
    const h = memoryHeaders({ url: 'http://x', apiKey: 'k', bearer: 'tok' });
    expect(h['x-api-key']).toBe('k');
    expect(h['Authorization']).toBe('Bearer tok');
  });

  it('omits each header when its credential is absent', () => {
    expect(memoryHeaders({ url: 'http://x' })).not.toHaveProperty('x-api-key');
    expect(memoryHeaders({ url: 'http://x' })).not.toHaveProperty('Authorization');
  });
});

describe('fixture transport (MEMORY_MODE default)', () => {
  it('defaults to fixture mode', () => {
    expect(memoryMode()).toBe('fixture');
  });

  it('round-trips the fixture graph with resolved (upcoming) event times', async () => {
    const g = await graphData(OWNER);
    expect(g.nodes.length).toBeGreaterThanOrEqual(5);
    const events = g.nodes.filter((n) => n.entityType === 'event');
    expect(events.length).toBe(3);
    // now±Nh templates resolve to real ISO timestamps in the future.
    for (const e of events) {
      const start = e.properties.start_time as string;
      expect(Date.parse(start)).toBeGreaterThan(Date.now());
    }
    expect(g.links.length).toBe(2);
  });

  it('windows dated nodes with from/to but keeps undated nodes (people)', async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const g = await graphData(OWNER, { from, to });
    const events = g.nodes.filter((n) => n.entityType === 'event');
    expect(events.length).toBe(2); // the now+90h dentist event falls outside
    expect(g.nodes.some((n) => n.entityType === 'person')).toBe(true);
  });

  it('graphSearch matches name/description substrings', async () => {
    const g = await graphSearch(OWNER, 'sam');
    expect(g.nodes.some((n) => n.name === 'Sam Rivera')).toBe(true);
    expect(g.nodes.some((n) => n.name === 'Dinner with Sam')).toBe(true);
  });

  it('graphContext renders every fixture node as a `type: name — description` line', async () => {
    const ctx = await graphContext(OWNER);
    // Events AND people render (not just the first node type).
    expect(ctx).toContain('Quarterly planning review');
    expect(ctx).toContain('Sam Rivera');
    // Line shape: `type: name — description`.
    expect(ctx).toMatch(/^event: Quarterly planning review — /m);
    expect(ctx).toMatch(/^person: Sam Rivera — /m);
    // All 5 fixture nodes make it into the snapshot, one line each.
    expect(ctx.split('\n')).toHaveLength(5);
    for (const name of ['Quarterly planning review', 'Dinner with Sam', 'Dentist appointment', 'Sam Rivera', 'Alex Chen']) {
      expect(ctx).toContain(name);
    }
  });
});

describe('live transport degradation', () => {
  it('throws MemoryUnavailable when CI-Server is unreachable', async () => {
    process.env.MEMORY_MODE = 'live';
    process.env.CI_SERVER_URL = 'http://127.0.0.1:9'; // nothing listens on the discard port
    await expect(graphData(OWNER)).rejects.toBeInstanceOf(MemoryUnavailable);
  });

  it('throws MemoryUnavailable when no creds resolve in live mode', async () => {
    process.env.MEMORY_MODE = 'live';
    await expect(graphData(OWNER)).rejects.toBeInstanceOf(MemoryUnavailable);
  });

  it('refuses to follow a 3xx redirect (x-api-key must never cross origins)', async () => {
    const listen = (srv: Server) => new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
    });
    const close = (srv: Server) => new Promise<void>((resolve) => srv.close(() => resolve()));

    // "Attacker-reachable" redirect target: any request arriving here means the leak.
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"data":{"nodes":[],"links":[]}}');
    });
    const targetPort = await listen(target);

    // The configured host answers every GET with a cross-origin 302.
    const origin = createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `http://127.0.0.1:${targetPort}/graph/data`);
      res.end();
    });
    const originPort = await listen(origin);

    try {
      process.env.MEMORY_MODE = 'live';
      process.env.CI_SERVER_URL = `http://127.0.0.1:${originPort}`;
      process.env.CI_SERVER_API_KEY = 'leaky-key';
      const err = await graphData(OWNER).then(
        () => {
          throw new Error('expected graphData to reject');
        },
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(MemoryUnavailable);
      expect(err.message).toMatch(/redirect \(HTTP 302\)/);
      expect(err.message).not.toContain('leaky-key');
      expect(targetHits).toBe(0); // the redirect was never followed
    } finally {
      await close(origin);
      await close(target);
    }
  });

  /**
   * A CI-Server that accepts the connection and never answers must not hang the
   * request forever. getJson() had no AbortSignal at all — a stalled server (not
   * refused, not erroring, just silent) meant the promise never settled, which for
   * resolveLiveMemoryCreds's single-flighted token refresh meant every OTHER caller
   * sharing that in-flight refresh hung too, indefinitely, with it.
   *
   * Real wall-clock wait against the actual HTTP_TIMEOUT_MS (10s), not a shortened
   * stand-in — the point is that the PRODUCTION constant, wired at the real call
   * site, actually bounds a real hang.
   */
  it(
    'a silent CI-Server does not hang graphContext forever — the request times out',
    { timeout: 15_000 },
    async () => {
      const listen = (srv: Server) => new Promise<number>((resolve) => {
        srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
      });
      const close = (srv: Server) => new Promise<void>((resolve) => srv.close(() => resolve()));

      // Accepts the connection, then does nothing — no response, no close, no error.
      // The opposite of "unreachable": something IS there, it just never answers.
      const blackHole = createServer(() => { /* deliberately silent */ });
      const port = await listen(blackHole);

      try {
        process.env.MEMORY_MODE = 'live';
        process.env.CI_SERVER_URL = `http://127.0.0.1:${port}`;
        process.env.CI_SERVER_API_KEY = 'irrelevant-key';

        const started = Date.now();
        const err = await graphContext(OWNER).then(
          () => { throw new Error('expected graphContext to reject'); },
          (e: unknown) => e as Error,
        );
        const elapsed = Date.now() - started;

        expect(err).toBeInstanceOf(MemoryUnavailable);
        // Bounded by HTTP_TIMEOUT_MS (10s), not left to the OS's own multi-minute TCP
        // timeout — with real margin either side so this isn't a hair-trigger timing
        // assertion.
        expect(elapsed).toBeGreaterThan(8_000);
        expect(elapsed).toBeLessThan(13_000);
      } finally {
        await close(blackHole);
      }
    },
  );
});

describe('routes', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('GET /api/memory/status reflects real (un)availability + source', async () => {
    const off = await api(srv.url, '/api/memory/status');
    expect(off.status).toBe(200);
    expect(off.body.pull).toEqual({ enabled: false, available: false, source: null, authKind: null, host: null });
    expect(off.body.available).toBe(false);

    process.env.CI_SERVER_URL = 'http://ci.local:3000';
    const env = await api(srv.url, '/api/memory/status');
    expect(env.body.pull).toMatchObject({ available: true, source: 'env', host: 'ci.local:3000' });
  });

  it('POST /api/memory/connect validates the URL', async () => {
    for (const url of ['', 'not a url', 'ftp://x.local']) {
      const r = await api(srv.url, '/api/memory/connect', { method: 'POST', json: { url, api_key: 'k' } });
      expect(r.status).toBe(422);
    }
    expect(await memoryCreds(OWNER)).toBeNull();
  });

  it('POST /api/memory/connect stores the connection and stamps memory_account; disconnect clears both', async () => {
    const conn = await api(srv.url, '/api/memory/connect', {
      method: 'POST',
      json: { url: 'https://ci.example.com', api_key: 'route-key' },
    });
    expect(conn.status).toBe(201);
    expect(conn.body.pull).toMatchObject({ available: true, source: 'settings', host: 'ci.example.com' });
    expect(conn.body.connected).toBe(true);
    expect(conn.body.account).toBe('ci.example.com');
    // The key is never echoed anywhere in the status payload.
    expect(JSON.stringify(conn.body)).not.toContain('route-key');

    const disc = await api(srv.url, '/api/memory/disconnect', { method: 'POST' });
    expect(disc.status).toBe(200);
    expect(disc.body.pull).toMatchObject({ available: false, source: null });
    expect(disc.body.connected).toBe(false);
    expect(await memoryCreds(OWNER)).toBeNull();
  });

  it('memory_pull_enabled round-trips through PATCH /api/prefs (never raw SQL)', async () => {
    const patch = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: true } });
    expect(patch.status).toBe(200);
    expect(patch.body.prefs.memory_pull_enabled).toBe(true);

    const get = await api(srv.url, '/api/prefs');
    expect(get.body.prefs.memory_pull_enabled).toBe(true);

    const status = await api(srv.url, '/api/memory/status');
    expect(status.body.pull.enabled).toBe(true);

    const off = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: false } });
    expect(off.body.prefs.memory_pull_enabled).toBe(false);
  });

  it('memoryStatus keeps the legacy push fields byte-compatible when off', async () => {
    const s = await memoryStatus(OWNER);
    expect(s).toMatchObject({ enabled: false, connected: false, account: null, lastSyncedAt: null });
    expect(s.scopes).toEqual({ completed: true, habits: true, reflections: true });
  });
});
