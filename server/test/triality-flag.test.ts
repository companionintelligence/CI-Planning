import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Triality T1 — the flag + log land DARK (docs/triality-design.md §7).
 *
 * Nothing consumes `triality_enabled` yet, so what there is to pin is exactly:
 * the migrations are idempotent, the flag round-trips through /api/prefs like
 * any other boolean pref, and the append-only log table exists and is covered
 * by resetDb. Flag-off byte-identity is trivially true at this wave (no reader)
 * and gets its real assertions with the routes/banner waves.
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

describe('migrations 0139/0140', () => {
  it('are idempotent — running up() again changes nothing and does not throw', () => {
    for (const idWanted of ['0139_triality_flag', '0140_triality_log']) {
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
