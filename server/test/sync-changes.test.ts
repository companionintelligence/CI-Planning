/**
 * GET /api/sync/changes: the polling twin of the SSE stream.
 *
 * The Capacitor app shell cannot keep an EventSource (it is served from its own origin, so the
 * stream carries no session cookie and the server allows no foreign origin), so it polls this
 * with the cursor from its last answer. It reads the same `sync_events` rows with the same
 * window and overflow rule as the SSE replay (sse-catchup.test.ts); these tests pin the
 * contract the shell's poller relies on: where a cursor starts, what it advances to, when it
 * is told to refetch, and who may ask.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { issueApiKey } from '../src/lib/auth/apiKey.js';
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE } from '../src/lib/auth/types.js';
import { flushBroadcasts } from '../src/routes/sse.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

const REPLAY_LIMIT = 500; // must match routes/sse.ts

interface Changes {
  events: { seq: number; event: string; data: unknown }[];
  cursor: number;
  resync: boolean;
}

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(() => server.close());
beforeEach(() => { resetDb(); });
afterEach(() => {
  config.auth.mode = 'test';
  sqlite.exec('DELETE FROM api_keys');
});

/** Insert `count` events for `ownerId`; returns their seqs, oldest first. */
function seed(count: number, ownerId: string = SYSTEM_OWNER, event = 'task:updated'): number[] {
  const insert = sqlite.prepare(
    `INSERT INTO sync_events (owner_id, entity, entity_id, version, event, payload, at)
     VALUES (?, 'task', ?, 1, ?, ?, datetime('now'))`,
  );
  const seqs: number[] = [];
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `t${seqs.length}`;
      seqs.push(Number(insert.run(ownerId, id, event, JSON.stringify({ id, n: i })).lastInsertRowid));
    }
  })();
  return seqs;
}

const changes = (query = '', init?: Parameters<typeof api>[2]) =>
  api<Changes>(server.url, `/api/sync/changes${query}`, init);

describe('GET /api/sync/changes: where a cursor starts', () => {
  it('with no cursor, answers the latest seq and no events', async () => {
    const seqs = seed(3);
    const { status, body } = await changes();
    expect(status).toBe(200);
    expect(body).toEqual({ events: [], cursor: seqs[2], resync: false });
  });

  it('with no cursor on an owner with no events, answers cursor 0, and the first event after is delivered', async () => {
    const start = await changes();
    expect(start.body).toEqual({ events: [], cursor: 0, resync: false });

    // since=0 means "everything after 0". Were it read as "no cursor", the head would jump
    // to this event's seq with nothing returned, and the owner's first change would be
    // skipped for good.
    const [first] = seed(1);
    const next = await changes(`?since=${start.body.cursor}`);
    expect(next.body.events.map((e) => e.seq)).toEqual([first]);
    expect(next.body.cursor).toBe(first);
  });
});

describe('GET /api/sync/changes: following a cursor', () => {
  it('returns what came after, in order, with the payload parsed and the cursor on the last', async () => {
    const [seen, ...later] = seed(4);
    const { status, body } = await changes(`?since=${seen}`);
    expect(status).toBe(200);
    expect(body.resync).toBe(false);
    expect(body.events).toEqual(
      later.map((seq, i) => ({ seq, event: 'task:updated', data: { id: `t${i + 1}`, n: i + 1 } })),
    );
    expect(body.cursor).toBe(later[later.length - 1]);
  });

  it('answers an up-to-date cursor with nothing, and the same cursor', async () => {
    const seqs = seed(2);
    const head = seqs[1]!;
    const { body } = await changes(`?since=${head}`);
    expect(body).toEqual({ events: [], cursor: head, resync: false });
  });

  it('replays a gap of exactly REPLAY_LIMIT, and resyncs one past it', async () => {
    const [seen] = seed(1);
    seed(REPLAY_LIMIT);
    const exact = await changes(`?since=${seen}`);
    expect(exact.body.resync).toBe(false);
    expect(exact.body.events).toHaveLength(REPLAY_LIMIT);

    seed(1);
    const over = await changes(`?since=${seen}`);
    expect(over.body.resync).toBe(true);
    expect(over.body.events).toEqual([]);
  });

  it('on a resync, hands back the latest seq so the next poll starts past the overflow', async () => {
    const [seen] = seed(1);
    const all = seed(REPLAY_LIMIT + 1);
    const latest = all[all.length - 1]!;

    const over = await changes(`?since=${seen}`);
    expect(over.body).toEqual({ events: [], cursor: latest, resync: true });

    // The same call from the new cursor is quiet; without the cursor advancing, every
    // poll would resync again.
    const after = await changes(`?since=${over.body.cursor}`);
    expect(after.body).toEqual({ events: [], cursor: latest, resync: false });
  });

  it('tells a cursor that is ahead of everything the owner has to start over from the real one', async () => {
    // A restored backup, or a server set up afresh at the same address: the client's cursor
    // belongs to a log that is gone. Left alone it would hear nothing until the new log
    // reached its number.
    const seqs = seed(3);
    const head = seqs[2]!;
    const ahead = await changes(`?since=${head + 1000}`);
    expect(ahead.body).toEqual({ events: [], cursor: head, resync: true });

    const settled = await changes(`?since=${ahead.body.cursor}`);
    expect(settled.body).toEqual({ events: [], cursor: head, resync: false });
  });

  it('does the same when the owner has no events left at all, and then delivers the next one', async () => {
    const ahead = await changes('?since=7');
    expect(ahead.body).toEqual({ events: [], cursor: 0, resync: true });

    const [first] = seed(1);
    const next = await changes(`?since=${ahead.body.cursor}`);
    expect(next.body.events.map((e) => e.seq)).toEqual([first]);
  });

  it("sees what a real mutation logs, so it answers what the stream would have pushed", async () => {
    const start = await changes();

    const created = await api<{ task: { id: string } }>(server.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'Seen by a poller' },
    });
    expect(created.status).toBe(201);
    await flushBroadcasts();

    const { body } = await changes(`?since=${start.body.cursor}`);
    const hit = body.events.find((e) => e.event === 'task:created');
    expect(hit?.data).toMatchObject({ id: created.body.task.id, title: 'Seen by a poller' });
    expect(body.cursor).toBeGreaterThan(start.body.cursor);
  });
});

describe('GET /api/sync/changes: owners', () => {
  it("never returns another owner's events, and the cap counts only the owner's own rows", async () => {
    createOwner(SECOND_OWNER_ID);
    const mine = seed(2);
    seed(REPLAY_LIMIT + 5, SECOND_OWNER_ID, 'task:created');
    const as = (owner: string) => ({ headers: { 'x-test-owner': owner } });

    // 505 other-owner rows after my cursor would resync anyone who was counted with them.
    const me = await changes(`?since=${mine[0]}`);
    expect(me.body.resync).toBe(false);
    expect(me.body.events.map((e) => e.seq)).toEqual([mine[1]]);

    const them = await changes('?since=0', as(SECOND_OWNER_ID));
    expect(them.body.resync).toBe(true); // 505 of their own is over the cap
    const head = await changes('', as(SECOND_OWNER_ID));
    expect(head.body.cursor).toBeGreaterThan(mine[1]!);
    expect(head.body.events).toEqual([]);
  });
});

describe('GET /api/sync/changes: the cursor parameter', () => {
  it.each([
    ['not a number', '?since=abc'],
    ['negative', '?since=-1'],
    ['fractional', '?since=1.5'],
    ['empty', '?since='],
    ['in exponent form', '?since=1e3'],
    ['too long to be exact', '?since=12345678901234567'],
    ['repeated', '?since=1&since=2'],
  ])('rejects a cursor that is %s', async (_label, query) => {
    const { status, body } = await changes(query);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'since must be a non-negative integer' });
  });

  it('is never cached', async () => {
    const res = await fetch(`${server.url}/api/sync/changes`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/sync/changes: who may ask', () => {
  it('401s without a credential in standalone mode', async () => {
    config.auth.mode = 'standalone';
    const { status, body } = await changes();
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthenticated' } as never);
  });

  it('serves a read key (a write key satisfies read too) and refuses one with neither', async () => {
    seed(1);
    config.auth.mode = 'standalone';
    for (const scopes of [[SCOPE_READ], [SCOPE_WRITE]]) {
      const key = await issueApiKey(SYSTEM_OWNER, scopes);
      const ok = await changes('', { headers: { 'x-api-key': key } });
      expect(ok.status, scopes.join()).toBe(200);
    }

    // Admin is not implied by read or write, and neither is read implied by admin.
    const adminOnly = await issueApiKey(SYSTEM_OWNER, [SCOPE_ADMIN]);
    const denied = await changes('', { headers: { 'x-api-key': adminOnly } });
    expect(denied.status).toBe(403);
  });
});
