import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Triality T1 — the flag + log land DARK (docs/triality-design.md §7).
 *
 * What is pinned here: the migrations are idempotent, the flag round-trips through
 * /api/prefs like any other boolean pref, and the append-only log table exists and is
 * covered by resetDb.
 *
 * Flag-off was trivially true when nothing read the flag; now that the routes do, it is
 * asserted (R4) against a fixture that provably WOULD have produced rows — a negative
 * over an empty fixture proves nothing. Every wave that touches the shown path re-runs
 * that assertion here, because "dark" is a claim about the whole feature, not about the
 * wave that last edited it: v2.2 adds a column, an insert parameter and a payload key,
 * and none of them may become reachable with the flag off.
 */

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
beforeEach(() => {
  resetDb();
});

describe('migrations 0139/0140/0144', () => {
  it('are idempotent — running up() again changes nothing and does not throw', () => {
    for (const idWanted of ['0139_triality_flag', '0140_triality_log', '0144_triality_confidence']) {
      const mig = MIGRATIONS.find((m) => m.id === idWanted);
      expect(mig, `${idWanted} registered in MIGRATIONS`).toBeTruthy();
      mig!.up(sqlite as never);
    }
    const cols = sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'triality_enabled')).toHaveLength(1);
    const log = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'triality_log'`)
      .get();
    expect(log).toBeTruthy();
    // 0144 is an addColumn-if-missing: SQLite would happily accept a second
    // `ADD COLUMN confidence`, and a duplicated column is not a cosmetic defect — every
    // reader of the blob would then be reading whichever one PRAGMA order handed it.
    const logCols = sqlite.prepare(`PRAGMA table_info(triality_log)`).all() as { name: string }[];
    expect(logCols.filter((c) => c.name === 'confidence')).toHaveLength(1);
  });
});

describe('flag via /api/prefs', () => {
  it('defaults to false and round-trips a PATCH', async () => {
    const before = await api(srv.url, '/api/prefs');
    expect(before.status).toBe(200);
    expect(before.body.prefs.triality_enabled).toBe(false);

    const patch = await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { triality_enabled: true },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.prefs.triality_enabled).toBe(true);

    const after = await api(srv.url, '/api/prefs');
    expect(after.body.prefs.triality_enabled).toBe(true);
  });

  it('resetDb pins the flag back to 0 between tests', async () => {
    // The previous test left it true; the beforeEach resetDb must have re-pinned
    // it — this is the cross-file leak guard for the shared sequential DB.
    const res = await api(srv.url, '/api/prefs');
    expect(res.body.prefs.triality_enabled).toBe(false);
  });
});

describe('flag off (R4)', () => {
  const logRows = () => (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log`).get() as { c: number }).c;

  it('404s /next and writes nothing — v2.2 changes none of that', async () => {
    // A fixture that would rank: over the refusal floor, with something to suggest.
    const done = sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id, status, completed_at, completion_mood)
       VALUES (uuid7(), ?, ?, 'done', ?, 'flat')`,
    );
    for (let i = 0; i < 12; i++) {
      done.run(`done-${i}`, SYSTEM_OWNER, new Date(Date.now() - (i + 1) * 86_400_000).toISOString());
    }
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), ?, ?, 'open', 20)`)
      .run('alpha', SYSTEM_OWNER);

    const off = await api(srv.url, '/api/triality/next');
    expect(off.status).toBe(404);        // absent, not broken — the client gates on the pref it already has
    expect(logRows()).toBe(0);           // …and the gate returns BEFORE the shown-rows insert

    // The negative above only means something if the same fixture produces rows once the
    // flag is on. Confidence is stamped on that insert, so this also pins that v2.2's
    // extra column stays unreachable while dark rather than merely unwritten.
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const on = await api(srv.url, '/api/triality/next');
    expect(on.status).toBe(200);
    expect(logRows()).toBeGreaterThan(0);
  });
});

describe('triality_log', () => {
  it('accepts append + outcome stamp shapes and resetDb clears it', () => {
    sqlite
      .prepare(
        `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores)
         VALUES (uuid7(), ?, '2026-07-29T10:00:00.000Z', '2026-07-29', 'habitual', 'task', 'task-1', '{"F":0.5}')`
      )
      .run(SYSTEM_OWNER);
    const n = (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log`).get() as { c: number }).c;
    expect(n).toBe(1);

    resetDb();
    const after = (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log`).get() as { c: number }).c;
    expect(after).toBe(0);
  });

  it('cascades with owner deletion', () => {
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES ('tri-owner-x', 'Tri X')`).run();
    sqlite
      .prepare(
        `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores)
         VALUES (uuid7(), 'tri-owner-x', '2026-07-29T10:00:00.000Z', '2026-07-29', 'novel', 'task', 'task-2', '{}')`
      )
      .run();
    sqlite.prepare(`DELETE FROM owners WHERE id = 'tri-owner-x'`).run();
    const left = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log WHERE owner_id = 'tri-owner-x'`).get() as { c: number }
    ).c;
    expect(left).toBe(0);
  });
});
