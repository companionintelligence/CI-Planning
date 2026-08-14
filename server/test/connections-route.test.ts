import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { issueApiKey } from '../src/lib/auth/apiKey.js';
import { SCOPE_READ, SCOPE_WRITE } from '../src/lib/auth/types.js';
import { seal, loadKek } from '../src/lib/crypto/index.js';
import { listConnections, disconnectConnection, type ConnectionRecord } from '../src/lib/connections.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';

/**
 * T13 (#349) — the provider-agnostic connection surface: listConnections /
 * disconnectConnection (server/src/lib/connections.ts) + GET /api/connections and
 * DELETE /api/connections/:provider/:account (server/src/routes/connections.ts).
 *
 * Mirrors oauth.test.ts's stub-proof harness: config.auth.mode flipped to 'standalone'
 * per test and ALWAYS restored to 'test' in afterEach; CP_KEK_B64 set per test (no
 * global KEK); a captured realFetch drives our server so the revoke fetch-stub only
 * intercepts the handler's own outbound call.
 */

const KEY = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

// Real fetch captured before any vi.stubGlobal — drives our server stub-proof.
const realFetch = globalThis.fetch.bind(globalThis);

let srv: TestServer;

async function authHeaders(): Promise<{ headers: Record<string, string> }> {
  const key = await issueApiKey(SYSTEM_OWNER, [SCOPE_READ, SCOPE_WRITE]);
  return { headers: { 'x-api-key': key } };
}

async function realApi<T = any>(path: string, init?: RequestInit & { json?: unknown }) {
  const { json, ...rest } = init ?? {};
  const res = await realFetch(`${srv.url}${path}`, {
    ...rest,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : (rest.body as BodyInit | undefined),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Seed a connection_tokens row. Google rows get a real sealed token so disconnect can
 *  decrypt+revoke; the sealed secrets are the ya29./1// prefixes the no-leak guard hunts. */
async function seedToken(opts: { provider?: string; account: string; status?: string; owner?: string }) {
  const payload = JSON.stringify({
    accessToken: 'ya29.SECRET-ACCESS-TOKEN',
    refreshToken: '1//SECRET-REFRESH-TOKEN',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const sealed = seal(payload, await loadKek());
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(newId(), opts.owner ?? SYSTEM_OWNER, opts.provider ?? 'google', opts.account, sealed.iv, sealed.authTag, sealed.ciphertext, opts.status ?? 'active');
}

beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  resetDb();
  process.env.CP_KEK_B64 = KEY;
  config.auth.mode = 'standalone';
});

afterEach(() => {
  config.auth.mode = 'test';
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
  sqlite.exec('DELETE FROM outbound_queue; DELETE FROM connection_tokens; DELETE FROM api_keys; DELETE FROM time_blocks;');
  vi.unstubAllGlobals();
});

describe('listConnections() — leak-safe list', () => {
  it('returns one ConnectionRecord per row, ordered by provider, account', async () => {
    // Insert out of order to prove the ORDER BY, across providers.
    await seedToken({ provider: 'google', account: 'b@x.io', status: 'active' });
    await seedToken({ provider: 'ci_memory', account: 'mem@x.io', status: 'error' });
    await seedToken({ provider: 'google', account: 'a@x.io', status: 'revoked' });

    const list = await listConnections(SYSTEM_OWNER);
    expect(list.map((c) => `${c.provider}/${c.account}`)).toEqual([
      'ci_memory/mem@x.io',
      'google/a@x.io',
      'google/b@x.io',
    ]);
    // Only safe keys, and status is the MAPPED value — the raw connection_tokens.status
    // ('active' | 'revoked' | 'error') no longer leaves the server (llm-7). google rows
    // additionally carry mappedEventCount; ci_memory rows must NOT.
    for (const row of list) {
      const keys = Object.keys(row).sort();
      expect(keys).toEqual(
        (row.provider === 'google'
          ? ['account', 'createdAt', 'expiresAt', 'lastError', 'lastSyncAt', 'mappedEventCount', 'provider', 'status']
          : ['account', 'createdAt', 'expiresAt', 'lastError', 'lastSyncAt', 'provider', 'status']
        ).sort(),
      );
      expect(typeof row.createdAt).toBe('string');
    }
    expect(list.find((c) => c.account === 'a@x.io')!.status).toBe('inactive'); // was raw 'revoked'
  });

  it('returns [] (not null) for an owner with no connections', async () => {
    expect(await listConnections(SYSTEM_OWNER)).toEqual([]);
  });

  it('never leaks token material (no ciphertext/iv/key_version/token values)', async () => {
    await seedToken({ provider: 'google', account: 'leak-check@x.io' });
    const json = JSON.stringify(await listConnections(SYSTEM_OWNER));
    for (const key of ['ciphertext', 'authTag', 'auth_tag', 'key_version', 'accessToken', 'refreshToken']) {
      expect(json).not.toContain(`"${key}"`);
    }
    expect(json).not.toContain('"iv"'); // JSON key form — bare 'iv' collides with 'inact-iv-e'
    // Value-level: the seeded secret prefixes must never appear.
    expect(json).not.toContain('ya29.');
    expect(json).not.toContain('1//');
    // And the actual sealed IV hex is absent.
    const ivHex = (sqlite.prepare("SELECT iv FROM connection_tokens WHERE account = 'leak-check@x.io'").get() as { iv: string }).iv;
    expect(json).not.toContain(ivHex);
  });

  it('is owner-scoped — never returns another owner\'s rows', async () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('owner-b', 'B')`).run();
    await seedToken({ provider: 'google', account: 'mine@x.io', owner: SYSTEM_OWNER });
    await seedToken({ provider: 'google', account: 'theirs@x.io', owner: 'owner-b' });

    const mine = await listConnections(SYSTEM_OWNER);
    expect(mine.map((c) => c.account)).toEqual(['mine@x.io']);
    expect((await listConnections('owner-b')).map((c) => c.account)).toEqual(['theirs@x.io']);
  });
});

describe('GET /api/connections', () => {
  it('returns 200 { connections: [...] } for the seeded owner, leak-free', async () => {
    await seedToken({ provider: 'google', account: 'get@x.io' });
    const { status, body } = await realApi<{ connections: ConnectionRecord[] }>('/api/connections', await authHeaders());
    expect(status).toBe(200);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toEqual({
      provider: 'google',
      account: 'get@x.io',
      // Mapped, never the raw 'active'. expiresAt stays null: this route does not decrypt.
      status: 'connected',
      createdAt: expect.any(String),
      expiresAt: null,
      lastSyncAt: null,
      lastError: null,
      mappedEventCount: 0,
    });
    const serialized = JSON.stringify(body);
    for (const key of ['ciphertext', 'auth_tag', 'iv', 'key_version', 'accessToken', 'refreshToken']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    expect(serialized).not.toContain('ya29.');
    expect(serialized).not.toContain('1//');
  });

  it('returns { connections: [] } for an owner with none', async () => {
    const { status, body } = await realApi<{ connections: ConnectionRecord[] }>('/api/connections', await authHeaders());
    expect(status).toBe(200);
    expect(body.connections).toEqual([]);
  });

  it('never shows another owner\'s connections', async () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('owner-b', 'B')`).run();
    await seedToken({ provider: 'google', account: 'theirs@x.io', owner: 'owner-b' });
    const { body } = await realApi<{ connections: ConnectionRecord[] }>('/api/connections', await authHeaders());
    expect(body.connections).toEqual([]); // the api key is SYSTEM_OWNER's
  });
});

describe('DELETE /api/connections/:provider/:account', () => {
  it('revokes (google), deletes the token + outbound_queue rows, returns the pair', async () => {
    const account = 'disc@x.io';
    await seedToken({ provider: 'google', account });
    // A pending outbound_queue row for the same (owner, provider, account); its block_id
    // FKs time_blocks (FK pragma ON), so seed a real block first.
    const blockId = newId();
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, start_at, end_at, all_day, owner_id) VALUES (?, 'b', ?, ?, 0, ?)`)
      .run(blockId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), SYSTEM_OWNER);
    sqlite
      .prepare(`INSERT INTO outbound_queue (id, owner_id, block_id, provider, account) VALUES (?, ?, ?, 'google', ?)`)
      .run(newId(), SYSTEM_OWNER, blockId, account);

    let revokeCalled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('revoke')) revokeCalled = true;
      return new Response('', { status: 200 });
    }));

    const { status, body } = await realApi(`/api/connections/google/${encodeURIComponent(account)}`, {
      method: 'DELETE',
      ...await authHeaders(),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ disconnected: { provider: 'google', account } });
    expect(revokeCalled).toBe(true);

    const tokN = sqlite.prepare('SELECT COUNT(*) AS n FROM connection_tokens WHERE account = ?').get(account) as { n: number };
    const oqN = sqlite.prepare('SELECT COUNT(*) AS n FROM outbound_queue WHERE account = ?').get(account) as { n: number };
    expect(tokN.n).toBe(0);
    expect(oqN.n).toBe(0);
  });

  it('404s { error: connection_not_found } when the owner holds no such connection', async () => {
    const { status, body } = await realApi(`/api/connections/google/${encodeURIComponent('nobody@x.io')}`, {
      method: 'DELETE',
      ...await authHeaders(),
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'connection_not_found' });
  });

  it('deletes a non-google provider WITHOUT attempting a revoke', async () => {
    const account = 'mem@x.io';
    await seedToken({ provider: 'ci_memory', account });

    let revokeCalled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('revoke')) revokeCalled = true;
      return new Response('', { status: 200 });
    }));

    const { status, body } = await realApi(`/api/connections/ci_memory/${encodeURIComponent(account)}`, {
      method: 'DELETE',
      ...await authHeaders(),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ disconnected: { provider: 'ci_memory', account } });
    expect(revokeCalled).toBe(false); // no revocation endpoint for non-google providers

    const n = sqlite.prepare('SELECT COUNT(*) AS n FROM connection_tokens WHERE account = ?').get(account) as { n: number };
    expect(n.n).toBe(0);
  });

  it('is owner-scoped — cannot delete another owner\'s connection', async () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('owner-b', 'B')`).run();
    await seedToken({ provider: 'google', account: 'theirs@x.io', owner: 'owner-b' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const { status } = await realApi(`/api/connections/google/${encodeURIComponent('theirs@x.io')}`, {
      method: 'DELETE',
      ...await authHeaders(),
    });
    expect(status).toBe(404); // not this owner's row → not found, not deleted
    const n = sqlite.prepare("SELECT COUNT(*) AS n FROM connection_tokens WHERE account = 'theirs@x.io'").get() as { n: number };
    expect(n.n).toBe(1); // still there
  });
});

describe('disconnectConnection() — direct unit', () => {
  it('returns true when a row was removed, false when nothing matched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await seedToken({ provider: 'google', account: 'unit@x.io' });
    expect(await disconnectConnection(SYSTEM_OWNER, 'google', 'unit@x.io')).toBe(true);
    expect(await disconnectConnection(SYSTEM_OWNER, 'google', 'unit@x.io')).toBe(false);
  });
});
