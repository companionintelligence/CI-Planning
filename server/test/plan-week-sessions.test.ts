import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0131 from '../src/db/migrations/0131_planning_sessions.js';
import { sqlite } from '../src/db/index.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import type { PlanningSession } from '../src/services/planning-sessions.js';

/**
 * FTUE · T1 (#337) — the planning-session log.
 *
 * Migration checks run against isolated in-memory DBs (mirroring daily-recap.test.ts);
 * the behavioral half goes over HTTP against the shared sequential DB.
 */

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');
const cols = (db: Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('0131 planning_sessions migration', () => {
  it('creates the table with all ten columns and its owner index', () => {
    const db = fresh();
    runMigrations(db);

    expect(cols(db, 'planning_sessions')).toEqual(
      expect.arrayContaining([
        'id', 'owner_id', 'started_at', 'ended_at', 'entry_branch',
        'status', 'llm_used', 'transcript', 'summary', 'created_at',
      ]),
    );
    const ix = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='ix_planning_sessions_owner'`)
      .get();
    expect(ix).toBeTruthy();
    db.close();
  });

  it('leaves the schema sound and is idempotent', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(db).applied).toEqual([]);
    expect(() => m0131.up(db)).not.toThrow(); // guard: planning_sessions already exists
    db.close();
  });

  it('cascades: deleting the owner removes their sessions', () => {
    const db = fresh();
    runMigrations(db);
    db.pragma('foreign_keys = ON');

    db.prepare(`INSERT INTO owners (id, name) VALUES ('o-cascade', 'Temp')`).run();
    db.prepare(`INSERT INTO planning_sessions (id, owner_id, entry_branch) VALUES ('s-cascade', 'o-cascade', 'review')`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM planning_sessions`).get()).toEqual({ n: 1 });

    db.prepare(`DELETE FROM owners WHERE id = 'o-cascade'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM planning_sessions`).get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('/api/plan-week/sessions', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  const open = (entry_branch = 'fill_week', headers?: Record<string, string>) =>
    api<{ session: PlanningSession }>(server.url, '/api/plan-week/sessions', {
      method: 'POST', json: { entry_branch }, ...(headers ? { headers } : {}),
    });

  /**
   * `started_at` must be true ISO-8601, not SQLite's `CURRENT_TIMESTAMP`
   * (`YYYY-MM-DD HH:MM:SS`) — JS reads that space-separated form as LOCAL time while
   * SQLite stored UTC, so the Logs tab would shift every session by the viewer's offset,
   * and it would disagree with `ended_at`, which the service writes as real ISO.
   */
  it('stamps started_at and ended_at in the same ISO-8601 format', async () => {
    const id = (await open()).body.session.id;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    const created = (await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`)).body.session;
    expect(created.started_at).toMatch(iso);
    expect(created.created_at).toMatch(iso);
    expect(Number.isNaN(Date.parse(created.started_at))).toBe(false);

    const closed = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`, {
      method: 'PATCH', json: { status: 'completed' },
    });
    expect(closed.body.session.ended_at).toMatch(iso);
    // Both ends of the session are comparable as plain strings.
    expect(closed.body.session.ended_at! >= created.started_at).toBe(true);
  });

  it('round-trips open → append → close → list → get → delete', async () => {
    const created = await open('fill_week');
    expect(created.status).toBe(201);
    expect(created.body.session).toMatchObject({ status: 'open', llm_used: false, transcript: [], ended_at: null });
    const id = created.body.session.id;

    // Append: the transcript grows and the server stamps `ts` (the client sent none).
    const appended = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`, {
      method: 'PATCH', json: { message: { role: 'user', text: 'plan my week' } },
    });
    expect(appended.status).toBe(200);
    expect(appended.body.session.transcript).toHaveLength(1);
    expect(appended.body.session.transcript[0]).toMatchObject({ role: 'user', text: 'plan my week' });
    expect(appended.body.session.transcript[0].ts).toBeTruthy();

    const closed = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`, {
      method: 'PATCH', json: { status: 'completed', summary: 'x', llm_used: true },
    });
    expect(closed.body.session).toMatchObject({ status: 'completed', summary: 'x', llm_used: true });
    expect(closed.body.session.ended_at).toBeTruthy();
    expect(closed.body.session.transcript).toHaveLength(1); // the close must not drop the log

    const listed = await api<{ sessions: PlanningSession[] }>(server.url, '/api/plan-week/sessions');
    expect(listed.body.sessions.map((s) => s.id)).toEqual([id]);

    const got = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`);
    expect(got.body.session.id).toBe(id);

    const removed = await api<{ ok: boolean }>(server.url, `/api/plan-week/sessions/${id}`, { method: 'DELETE' });
    expect(removed.body).toEqual({ ok: true });
    expect((await api(server.url, `/api/plan-week/sessions/${id}`)).status).toBe(404);
  });

  it('lists newest first', async () => {
    const a = (await open('review')).body.session.id;
    // started_at now carries milliseconds, but two inserts can still land in the same one —
    // age the first explicitly so the ordering assertion is deterministic, not merely likely.
    sqlite.prepare(`UPDATE planning_sessions SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(a);
    const b = (await open('fill_week')).body.session.id;

    const listed = await api<{ sessions: PlanningSession[] }>(server.url, '/api/plan-week/sessions');
    expect(listed.body.sessions.map((s) => s.id)).toEqual([b, a]);
  });

  it('replaces the whole transcript when given an array', async () => {
    const id = (await open()).body.session.id;
    const res = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`, {
      method: 'PATCH',
      json: { transcript: [{ role: 'system', text: 'a', ts: '2026-07-18T00:00:00.000Z' }] },
    });
    expect(res.body.session.transcript).toHaveLength(1);
    expect(res.body.session.transcript[0].text).toBe('a');
  });

  it('422s an unknown entry_branch or status, and writes nothing', async () => {
    const bad = await open('bogus');
    expect(bad.status).toBe(422);
    expect((await api<{ sessions: PlanningSession[] }>(server.url, '/api/plan-week/sessions')).body.sessions).toEqual([]);

    const id = (await open()).body.session.id;
    const badClose = await api(server.url, `/api/plan-week/sessions/${id}`, {
      method: 'PATCH', json: { status: 'bogus' },
    });
    expect(badClose.status).toBe(422);
    const after = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`);
    expect(after.body.session.status).toBe('open'); // unchanged
    expect(after.body.session.ended_at).toBeNull();
  });

  it('422s an unknown message role', async () => {
    const id = (await open()).body.session.id;
    const res = await api(server.url, `/api/plan-week/sessions/${id}`, {
      method: 'PATCH', json: { message: { role: 'assistant', text: 'nope' } },
    });
    expect(res.status).toBe(422);
  });

  it('404s GET / PATCH / DELETE on an unknown id', async () => {
    expect((await api(server.url, '/api/plan-week/sessions/nope')).status).toBe(404);
    expect((await api(server.url, '/api/plan-week/sessions/nope', { method: 'PATCH', json: { status: 'completed' } })).status).toBe(404);
    expect((await api(server.url, '/api/plan-week/sessions/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('isolates owners: B cannot read, list, or delete A\'s session', async () => {
    createOwner(SECOND_OWNER_ID);
    const id = (await open('review')).body.session.id;
    const asB = { 'x-test-owner': SECOND_OWNER_ID };

    expect((await api(server.url, `/api/plan-week/sessions/${id}`, { headers: asB })).status).toBe(404);
    expect((await api<{ sessions: PlanningSession[] }>(server.url, '/api/plan-week/sessions', { headers: asB })).body.sessions).toEqual([]);
    expect((await api(server.url, `/api/plan-week/sessions/${id}`, { method: 'DELETE', headers: asB })).status).toBe(404);

    // ...and A's row survived every one of B's attempts.
    const mine = await api<{ session: PlanningSession }>(server.url, `/api/plan-week/sessions/${id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.session.id).toBe(id);
  });
});
