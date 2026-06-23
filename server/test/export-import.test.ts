import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { startTestServer, api, resetDb, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterEach(() => resetDb());

describe('GET /api/export', () => {
  it('returns a JSON file with the correct structure', async () => {
    const res = await fetch(`${srv.url}/api/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment.*filename="companion-export/);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe('1');
    expect(typeof body.owner_id).toBe('string');
    expect(typeof body.exported_at).toBe('string');
    for (const key of ['tasks', 'patterns', 'tags', 'scheduling_prefs']) {
      expect(Array.isArray(body[key]), `${key} should be an array`).toBe(true);
    }
  });

  it('includes seeded tasks in the export', async () => {
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'export-me', id FROM owners LIMIT 1`
    ).run();
    const res = await fetch(`${srv.url}/api/export`);
    const body = await res.json() as { tasks: { title: string }[] };
    expect(body.tasks.some((t) => t.title === 'export-me')).toBe(true);
  });
});

describe('POST /api/import', () => {
  it('restores a full round-trip (export → wipe → import → re-export)', async () => {
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'round-trip-task', id FROM owners LIMIT 1`
    ).run();

    const exp1 = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const tasksBefore = (exp1.tasks as { id: string; title: string }[]);
    expect(tasksBefore.some((t) => t.title === 'round-trip-task')).toBe(true);

    resetDb();
    const { status, body } = await api<{ imported: Record<string, number> }>(
      srv.url, '/api/import', { method: 'POST', json: exp1 }
    );
    expect(status).toBe(200);
    expect(body.imported.tasks).toBe(tasksBefore.length);

    const exp2 = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const tasksAfter = (exp2.tasks as { id: string }[]).map((t) => t.id).sort();
    const tasksBeforeIds = tasksBefore.map((t) => t.id).sort();
    expect(tasksAfter).toEqual(tasksBeforeIds);
  });

  it('writes an audit row', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json();
    const before = (sqlite.prepare('SELECT count(*) as n FROM audit_log').get() as { n: number }).n;
    await api(srv.url, '/api/import', { method: 'POST', json: exp });
    const after = (sqlite.prepare('SELECT count(*) as n FROM audit_log').get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });

  it('rejects a mismatched owner_id with 403', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json();
    const { status } = await api(srv.url, '/api/import', {
      method: 'POST',
      json: { ...exp, owner_id: 'different-owner-id' },
    });
    expect(status).toBe(403);
  });

  it('rejects an unknown version with 400', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json();
    const { status } = await api(srv.url, '/api/import', {
      method: 'POST',
      json: { ...exp, version: '99' },
    });
    expect(status).toBe(400);
  });

  it('rejects a missing version with 400', async () => {
    const { version: _v, ...noVersion } = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: noVersion });
    expect(status).toBe(400);
  });

  it('rejects a payload with a missing required array with 400', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const { tasks: _t, ...noTasks } = exp;
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: noTasks });
    expect(status).toBe(400);
  });

  it('rolls back entirely when a row violates a NOT NULL constraint', async () => {
    // Seed one task so the DB is non-empty before the failed import.
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'should-survive', id FROM owners LIMIT 1`
    ).run();
    const rowsBefore = (sqlite.prepare('SELECT count(*) as n FROM tasks').get() as { n: number }).n;

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    // Append a row with a null PK — violates the NOT NULL constraint mid-insert.
    const broken = { ...exp, tasks: [...(exp.tasks as unknown[]), { id: null, title: null, owner_id: null }] };

    // The import may succeed or throw; either way we check DB state.
    await api(srv.url, '/api/import', { method: 'POST', json: broken }).catch(() => {});

    const rowsAfter = (sqlite.prepare('SELECT count(*) as n FROM tasks').get() as { n: number }).n;
    // Transaction rolled back — original row count restored.
    expect(rowsAfter).toBe(rowsBefore);
  });
});
