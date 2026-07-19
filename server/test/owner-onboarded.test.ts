import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0132 from '../src/db/migrations/0132_owner_onboarded.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * FTUE · T11 (#347) — the `scheduling_prefs.onboarded_at` "confirmed owner" flag.
 *
 * Migration checks run against isolated in-memory DBs (mirrors plan-week-sessions.test.ts
 * for 0131); the PATCH /api/prefs passthrough check goes over HTTP against the shared
 * sequential DB.
 */

const fresh = () => new BetterSqlite3(':memory:');
const cols = (db: Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe('0132 owner_onboarded migration', () => {
  it('adds the nullable onboarded_at column', () => {
    const db = fresh();
    runMigrations(db);
    expect(cols(db, 'scheduling_prefs')).toContain('onboarded_at');
    db.close();
  });

  it('backfills an owner that already has ≥1 task, leaves a fresh owner NULL', () => {
    const db = fresh();
    runMigrations(db);

    db.prepare(`INSERT INTO owners (id, name) VALUES ('o-has-tasks', 'Has tasks')`).run();
    db.prepare(`INSERT INTO scheduling_prefs (id, owner_id) VALUES ('sp-has-tasks', 'o-has-tasks')`).run();
    db.prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES ('t-1', 'x', 'o-has-tasks', 'open', 3)`).run();

    db.prepare(`INSERT INTO owners (id, name) VALUES ('o-fresh', 'Fresh')`).run();
    db.prepare(`INSERT INTO scheduling_prefs (id, owner_id) VALUES ('sp-fresh', 'o-fresh')`).run();

    // Re-run `up` — this is what a real upgrade does (the migration runner applies
    // each `up` once, but the function itself must still be safe to call again).
    m0132.up(db);

    const withTasks = db.prepare(`SELECT onboarded_at FROM scheduling_prefs WHERE owner_id = 'o-has-tasks'`).get() as { onboarded_at: string | null };
    const noTasks = db.prepare(`SELECT onboarded_at FROM scheduling_prefs WHERE owner_id = 'o-fresh'`).get() as { onboarded_at: string | null };
    expect(withTasks.onboarded_at).not.toBeNull();
    expect(noTasks.onboarded_at).toBeNull();
    db.close();
  });

  it('is idempotent — re-running up() does not throw and does not clobber an already-set value', () => {
    const db = fresh();
    runMigrations(db);
    db.prepare(`UPDATE scheduling_prefs SET onboarded_at = '2020-01-01T00:00:00.000Z' WHERE owner_id = ?`).run(SYSTEM_OWNER);

    expect(() => m0132.up(db)).not.toThrow();
    const row = db.prepare(`SELECT onboarded_at FROM scheduling_prefs WHERE owner_id = ?`).get(SYSTEM_OWNER) as { onboarded_at: string };
    expect(row.onboarded_at).toBe('2020-01-01T00:00:00.000Z'); // backfill only touches NULL rows
    db.close();
  });

  it('leaves the schema sound', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(db).applied).toEqual([]);
    db.close();
  });
});

describe('PATCH /api/prefs passthrough for onboarded_at', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  it('persists and round-trips onboarded_at with no server-side whitelist change', async () => {
    const iso = '2026-07-19T05:00:00.000Z';
    const patched = await api<{ prefs: { onboarded_at: string | null } }>(server.url, '/api/prefs', {
      method: 'PATCH', json: { onboarded_at: iso },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.prefs.onboarded_at).toBe(iso);

    const got = await api<{ prefs: { onboarded_at: string | null } }>(server.url, '/api/prefs');
    expect(got.body.prefs.onboarded_at).toBe(iso);
  });

  it('clears back to NULL by sending null', async () => {
    await api(server.url, '/api/prefs', { method: 'PATCH', json: { onboarded_at: '2026-07-19T05:00:00.000Z' } });
    const cleared = await api<{ prefs: { onboarded_at: string | null } }>(server.url, '/api/prefs', {
      method: 'PATCH', json: { onboarded_at: null },
    });
    expect(cleared.body.prefs.onboarded_at).toBeNull();
  });
});
