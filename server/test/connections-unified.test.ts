import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { listConnections, disconnectConnection, type ConnectionRecord } from '../src/lib/connections.js';
import { ConnectorUnavailable } from '../src/lib/connector-error.js';
import { OllamaUnavailable } from '../src/mcp/ollama.js';
import { McpUnavailable } from '../src/mcp/client.js';
import { MemoryUnavailable } from '../src/connectors/memory.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * llm-7 — ONE connection shape, ONE error contract, ONE disconnect.
 *
 * Consolidates what used to be asserted in two places over two shapes: the google-only
 * decrypting `connectionHealth` (connections.test.ts) and the all-provider,
 * raw-status `listConnections` (connections-route.test.ts). Both are now
 * `listConnections(owner, { withExpiry? })` returning `ConnectionRecord[]`.
 *
 * The no-leak assertions below are carried over VERBATIM from connections.test.ts — they
 * are the reason this refactor is safe, so they were not allowed to soften. What is NEW:
 * a ci_memory row is listed in the same shape as google, `mappedEventCount` is present
 * for google and ABSENT (not 0) for everyone else, and the raw connection_tokens.status
 * string never reaches a caller.
 */

// A real 32-byte AES-256 KEK for sealing test tokens.
const KEY_B64 = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

/** Seal `{ expiresAt }` (+ a fake refresh/access token to exercise the no-leak guard). */
function seedToken(opts: {
  provider?: string;
  account: string;
  status?: string;
  expiresAt?: string | null;
  corrupt?: boolean;
}): void {
  const payload = JSON.stringify({
    accessToken: 'ya29.SECRET-ACCESS-TOKEN',
    refreshToken: '1//SECRET-REFRESH-TOKEN',
    expiresAt: opts.expiresAt ?? null,
  });
  const sealed = seal(payload, Buffer.from(KEY_B64, 'base64'));
  const ciphertext = opts.corrupt ? 'deadbeef' + sealed.ciphertext.slice(8) : sealed.ciphertext;
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(newId(), SYSTEM_OWNER, opts.provider ?? 'google', opts.account, sealed.iv, sealed.authTag, ciphertext, opts.status ?? 'active');
}

/** Insert an external_events row mapped to (SYSTEM_OWNER, 'google', account). */
function seedEvent(account: string): void {
  sqlite
    .prepare(
      `INSERT INTO external_events (id, owner_id, provider, account, external_id, direction)
       VALUES (?, ?, 'google', ?, ?, 'inbound')`,
    )
    .run(newId(), SYSTEM_OWNER, account, newId());
}

/** The seeded sync_calendar scheduled_jobs id (migration 0056; survives resetDb). */
function syncJobId(): string {
  const row = sqlite
    .prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'sync_calendar' LIMIT 1`)
    .get() as { id: string };
  return row.id;
}

/** Insert a job_runs row for the sync_calendar job. */
function seedRun(opts: { startedAt: string; finishedAt?: string | null; status: string; log?: string | null }): void {
  sqlite
    .prepare(
      `INSERT INTO job_runs (id, job_id, started_at, finished_at, status, log)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), syncJobId(), opts.startedAt, opts.finishedAt ?? null, opts.status, opts.log ?? null);
}

beforeEach(() => {
  resetDb();
  process.env.CP_KEK_B64 = KEY_B64;
});
afterEach(() => {
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
});

describe('listConnections — one shape', () => {
  it('returns [] (not null) when the owner has no tokens', async () => {
    const result = await listConnections(SYSTEM_OWNER);
    expect(result).toEqual([]);
  });

  it('active row + future expiresAt → connected, with expiresAt + mappedEventCount', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    seedToken({ account: 'a@x.io', expiresAt: future });
    seedEvent('a@x.io');
    seedEvent('a@x.io');

    const result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: 'google',
      account: 'a@x.io',
      status: 'connected',
      expiresAt: future,
      mappedEventCount: 2,
      lastSyncAt: null,
      lastError: null,
    });
    // createdAt came from the old ConnectionSummary and is part of the one shape now.
    expect(typeof result[0].createdAt).toBe('string');
  });

  it('active row + past expiresAt → expired', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    seedToken({ account: 'old@x.io', expiresAt: past });

    const result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result[0].status).toBe('expired');
    expect(result[0].expiresAt).toBe(past);
  });

  it("status='revoked' → inactive, expiresAt null (never decrypts)", async () => {
    seedToken({ account: 'gone@x.io', status: 'revoked', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    const result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result[0].status).toBe('inactive');
    expect(result[0].expiresAt).toBeNull();
  });

  it('corrupt ciphertext → inactive, does NOT throw', async () => {
    seedToken({ account: 'bad@x.io', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), corrupt: true });

    // A rejected promise fails the test, which is the async form of "does NOT throw".
    const result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result[0].status).toBe('inactive');
    expect(result[0].expiresAt).toBeNull();
  });

  it('without withExpiry: no decrypt at all — an unreadable token still reads connected', async () => {
    // Same corrupt row as above. The opt-out path never opens it, so it cannot degrade
    // to 'inactive' — proof that the default list really does skip the decrypt.
    seedToken({ account: 'bad@x.io', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), corrupt: true });
    const result = await listConnections(SYSTEM_OWNER);
    expect(result[0].status).toBe('connected');
    expect(result[0].expiresAt).toBeNull();
  });

  it('lastError is populated from an errored sync_calendar run, null when done', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();

    // Errored run.
    seedToken({ account: 'err@x.io', expiresAt: future });
    seedRun({ startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(), status: 'error', log: 'token refresh failed' });
    let result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result[0].lastError).toBe('token refresh failed');
    expect(result[0].lastSyncAt).not.toBeNull();

    // Replace with a 'done' run → lastError clears (most recent wins).
    sqlite.exec('DELETE FROM job_runs');
    seedRun({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'done', log: 'ok' });
    result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result[0].lastError).toBeNull();
    expect(result[0].lastSyncAt).not.toBeNull();
  });

  it('lastSyncAt falls back to started_at when finished_at is null (still-running run)', async () => {
    const started = new Date().toISOString();
    seedToken({ account: 'run@x.io', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    seedRun({ startedAt: started, finishedAt: null, status: 'running' });

    const result = await listConnections(SYSTEM_OWNER, { withExpiry: true });
    expect(result[0].lastSyncAt).toBe(started);
    expect(result[0].lastError).toBeNull();
  });

  it('lists every provider in one shape, ordered by provider then account', async () => {
    seedToken({ provider: 'google', account: 'b@x.io' });
    seedToken({ provider: 'ci_memory', account: 'mem@x.io', status: 'error' });
    seedToken({ provider: 'google', account: 'a@x.io', status: 'revoked' });

    const list = await listConnections(SYSTEM_OWNER);
    expect(list.map((c) => `${c.provider}/${c.account}`)).toEqual([
      'ci_memory/mem@x.io',
      'google/a@x.io',
      'google/b@x.io',
    ]);
    // The raw column is MAPPED on the way out — 'error' and 'revoked' are both inactive.
    expect(list.find((c) => c.account === 'mem@x.io')!.status).toBe('inactive');
    expect(list.find((c) => c.account === 'a@x.io')!.status).toBe('inactive');
  });

  it('mappedEventCount is google-only: present (even at 0) for google, ABSENT for ci_memory', async () => {
    seedToken({ provider: 'google', account: 'g@x.io' });
    seedToken({ provider: 'ci_memory', account: 'mem@x.io' });

    const list = await listConnections(SYSTEM_OWNER);
    const google = list.find((c) => c.provider === 'google')!;
    const memory = list.find((c) => c.provider === 'ci_memory')!;
    expect(google.mappedEventCount).toBe(0); // google with no mapped events is a real 0
    expect('mappedEventCount' in memory).toBe(false); // absent, NOT 0
  });

  it('is owner-scoped — never returns another owner\'s rows', async () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('owner-b', 'B')`).run();
    seedToken({ account: 'mine@x.io' });
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
         VALUES (?, 'owner-b', 'google', 'theirs@x.io', 'aa', 'bb', 'cc', 1, 'active')`,
      )
      .run(newId());

    expect((await listConnections(SYSTEM_OWNER)).map((c) => c.account)).toEqual(['mine@x.io']);
    expect((await listConnections('owner-b')).map((c) => c.account)).toEqual(['theirs@x.io']);
  });

  it('NO-LEAK GUARD: serialized result contains no token material', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    seedToken({ account: 'leak-check@x.io', expiresAt: future });
    seedToken({ account: 'revoked@x.io', status: 'revoked' });
    seedEvent('leak-check@x.io');

    const json = JSON.stringify(await listConnections(SYSTEM_OWNER, { withExpiry: true }));
    for (const forbidden of ['ciphertext', 'authTag', 'auth_tag', 'accessToken', 'refreshToken']) {
      expect(json).not.toContain(forbidden);
    }
    // `iv` is checked as a JSON KEY (`"iv":`) not a bare substring — a bare "iv"
    // collides with the legitimate status value "inactive" (inact·iv·e).
    expect(json).not.toContain('"iv"');
    // And the actual sealed IV hex never appears in the output.
    const ivHex = (sqlite.prepare(`SELECT iv FROM connection_tokens WHERE account = 'leak-check@x.io'`).get() as { iv: string }).iv;
    expect(json).not.toContain(ivHex);
  });

  it('NO-LEAK GUARD: the RAW status column never reaches a caller', async () => {
    seedToken({ provider: 'google', account: 'active@x.io', status: 'active' });
    seedToken({ provider: 'google', account: 'revoked@x.io', status: 'revoked' });
    seedToken({ provider: 'ci_memory', account: 'errored@x.io', status: 'error' });

    for (const opts of [{}, { withExpiry: true }]) {
      const json = JSON.stringify(await listConnections(SYSTEM_OWNER, opts));
      expect(json).not.toContain('"active"');
      expect(json).not.toContain('"revoked"');
      expect(json).not.toContain('"error"');
    }
  });
});

describe('GET /api/connections — every provider, one shape', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(async () => { await srv.close(); });

  it('lists a google AND a ci_memory row; only google carries mappedEventCount', async () => {
    seedToken({ provider: 'google', account: 'g@x.io' });
    seedToken({ provider: 'ci_memory', account: 'ci.example.com' });
    seedEvent('g@x.io');

    const { status, body } = await api<{ connections: ConnectionRecord[] }>(srv.url, '/api/connections');
    expect(status).toBe(200);
    expect(body.connections.map((c) => c.provider)).toEqual(['ci_memory', 'google']);

    const google = body.connections.find((c) => c.provider === 'google')!;
    const memory = body.connections.find((c) => c.provider === 'ci_memory')!;
    expect(google).toMatchObject({ account: 'g@x.io', status: 'connected', mappedEventCount: 1 });
    expect(Object.keys(google).sort()).toEqual(
      ['account', 'createdAt', 'expiresAt', 'lastError', 'lastSyncAt', 'mappedEventCount', 'provider', 'status'].sort(),
    );
    expect('mappedEventCount' in memory).toBe(false);
    expect(memory).toMatchObject({ account: 'ci.example.com', status: 'connected', lastSyncAt: null, lastError: null });

    // No-leak, at the wire this time — including the raw status string.
    const serialized = JSON.stringify(body);
    for (const key of ['ciphertext', 'auth_tag', 'iv', 'key_version', 'accessToken', 'refreshToken']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    expect(serialized).not.toContain('ya29.');
    expect(serialized).not.toContain('1//');
    expect(serialized).not.toContain('"active"');
  });

  it('DELETE /api/connections/ci_memory/:account drops the row and its outbound_queue rows', async () => {
    const account = 'ci.example.com';
    seedToken({ provider: 'ci_memory', account });
    // outbound_queue.block_id FKs time_blocks (FK pragma is ON), so seed a real block.
    const blockId = newId();
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, start_at, end_at, all_day, owner_id) VALUES (?, 'b', ?, ?, 0, ?)`)
      .run(blockId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), SYSTEM_OWNER);
    sqlite
      .prepare(`INSERT INTO outbound_queue (id, owner_id, block_id, provider, account) VALUES (?, ?, ?, 'ci_memory', ?)`)
      .run(newId(), SYSTEM_OWNER, blockId, account);
    // The memory connection's display label must go with it (GET /api/memory/status
    // sources `connected` from this same list, so a stale label would contradict it).
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_account = ? WHERE owner_id = ?`).run(account, SYSTEM_OWNER);

    const { status, body } = await api(srv.url, `/api/connections/ci_memory/${encodeURIComponent(account)}`, {
      method: 'DELETE',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ disconnected: { provider: 'ci_memory', account } });

    const tokN = sqlite.prepare('SELECT COUNT(*) AS n FROM connection_tokens WHERE account = ?').get(account) as { n: number };
    const oqN = sqlite.prepare('SELECT COUNT(*) AS n FROM outbound_queue WHERE account = ?').get(account) as { n: number };
    expect(tokN.n).toBe(0);
    expect(oqN.n).toBe(0);
    const prefs = sqlite.prepare('SELECT memory_account FROM scheduling_prefs WHERE owner_id = ?').get(SYSTEM_OWNER) as { memory_account: string | null };
    expect(prefs.memory_account).toBeNull();

    // …and GET /api/memory/status agrees, because it reads the same surface.
    const mem = await api<{ connected: boolean; account: string | null }>(srv.url, '/api/memory/status');
    expect(mem.body.connected).toBe(false);
    expect(mem.body.account).toBeNull();
  });

  it('a ci_memory row makes GET /api/memory/status report connected, from listConnections', async () => {
    seedToken({ provider: 'ci_memory', account: 'ci.example.com' });
    const { body } = await api<{ connected: boolean; account: string | null }>(srv.url, '/api/memory/status');
    expect(body.connected).toBe(true);
    expect(body.account).toBe('ci.example.com');
  });

  it('disconnectConnection() returns true when a row was removed, false when nothing matched', async () => {
    seedToken({ provider: 'ci_memory', account: 'unit.example.com' });
    expect(await disconnectConnection(SYSTEM_OWNER, 'ci_memory', 'unit.example.com')).toBe(true);
    expect(await disconnectConnection(SYSTEM_OWNER, 'ci_memory', 'unit.example.com')).toBe(false);
  });
});

describe('one error contract — ConnectorUnavailable', () => {
  const cases: Array<[string, Error]> = [
    ['OllamaUnavailable', new OllamaUnavailable('ollama down')],
    ['McpUnavailable', new McpUnavailable('mcp down', { status: 503 })],
    ['MemoryUnavailable', new MemoryUnavailable('memory down')],
  ];

  it('each class still narrows itself and keeps its exact .name', () => {
    const [, ollama] = cases[0];
    const [, mcp] = cases[1];
    const [, memory] = cases[2];

    expect(ollama).toBeInstanceOf(OllamaUnavailable);
    expect(mcp).toBeInstanceOf(McpUnavailable);
    expect(memory).toBeInstanceOf(MemoryUnavailable);

    // Nothing cross-narrows: the specific catches in ingest.ts / memory-suggest.ts /
    // google.ts must keep telling the three apart.
    expect(ollama).not.toBeInstanceOf(McpUnavailable);
    expect(ollama).not.toBeInstanceOf(MemoryUnavailable);
    expect(mcp).not.toBeInstanceOf(MemoryUnavailable);

    for (const [name, err] of cases) expect(err.name).toBe(name);
  });

  it('one instanceof ConnectorUnavailable narrows all three (and Error still does)', () => {
    for (const [, err] of cases) {
      expect(err).toBeInstanceOf(ConnectorUnavailable);
      expect(err).toBeInstanceOf(Error);
      expect((err as ConnectorUnavailable).connector).toMatch(/^(ollama|mcp|memory)$/);
      expect(err.message).toContain('down');
    }
  });

  it('McpUnavailable keeps its extra status / freshEtag payload', () => {
    const err = new McpUnavailable('conflict', { status: 412, freshEtag: '"etag-2"' });
    expect(err.status).toBe(412);
    expect(err.freshEtag).toBe('"etag-2"');
    expect(err).toBeInstanceOf(ConnectorUnavailable);
  });
});
