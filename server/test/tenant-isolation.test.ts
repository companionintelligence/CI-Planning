import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createOwner, resetDb, startTestServer, api, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * Cross-tenant isolation regression suite (multi-tenant leak audit, 2026-07-12).
 * Owner A is the default (no header); owner B drives requests via `x-test-owner` (T0).
 * Each block pins one of the four confirmed leaks that were fixed:
 *   1. timer write onto another owner's task        (services/timer.ts)
 *   2. pattern membership referencing a foreign task (services/patterns.ts)
 *   3. reminder targeting a foreign task             (services/notifications.ts)
 *   4. import writing another owner's partition      (routes/backup.ts)
 */
const A = SYSTEM_OWNER;
const B = SECOND_OWNER_ID;
const asB = { headers: { 'x-test-owner': B } };

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); createOwner(B); });

function insertTask(owner: string, title = 'task', est = 30): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), ?, ?, 'open', ?) RETURNING id`)
    .get(title, owner, est) as { id: string }).id;
}
function insertPattern(owner: string): string {
  return (sqlite
    .prepare(`INSERT INTO patterns (id, owner_id, name) VALUES (uuid7(), ?, 'routine') RETURNING id`)
    .get(owner) as { id: string }).id;
}
const actualOf = (id: string) =>
  (sqlite.prepare(`SELECT actual_minutes FROM tasks WHERE id = ?`).get(id) as { actual_minutes: number | null }).actual_minutes;
const count = (sql: string, ...p: unknown[]) => (sqlite.prepare(sql).get(...p) as { n: number }).n;

describe('timer — cannot touch another owner\'s task', () => {
  it('B starting a timer on A\'s task 404s, creates no entry, and never writes A\'s actual_minutes', async () => {
    const aTask = insertTask(A, 'A work');
    sqlite.prepare(`UPDATE tasks SET actual_minutes = 42 WHERE id = ?`).run(aTask); // sentinel
    const r = await api(srv.url, `/api/tasks/${aTask}/timer/start`, { ...asB, method: 'POST', json: {} });
    expect(r.status).toBe(404);
    expect(count(`SELECT COUNT(*) AS n FROM time_entries WHERE task_id = ?`, aTask)).toBe(0);
    expect(actualOf(aTask)).toBe(42); // unchanged — no cross-tenant write
  });

  it('B can time their OWN task; the aggregate write stays in B\'s partition', async () => {
    const bTask = insertTask(B, 'B work');
    expect((await api(srv.url, `/api/tasks/${bTask}/timer/start`, { ...asB, method: 'POST', json: {} })).status).toBe(201);
    expect((await api(srv.url, `/api/tasks/${bTask}/timer/stop`, { ...asB, method: 'POST', json: {} })).status).toBe(200);
    expect(actualOf(bTask)).not.toBeNull(); // B's own task got its minutes
  });

  it('stopping a (legacy) running entry pointing at A\'s task never writes A\'s row', async () => {
    // Simulate a pre-fix corrupted entry: owned by B, but task_id = A's task.
    const aTask = insertTask(A);
    sqlite.prepare(`UPDATE tasks SET actual_minutes = 99 WHERE id = ?`).run(aTask);
    sqlite
      .prepare(`INSERT INTO time_entries (id, task_id, owner_id, started_at) VALUES (uuid7(), ?, ?, '2026-06-22T10:00:00.000Z')`)
      .run(aTask, B);
    const r = await api(srv.url, `/api/tasks/${aTask}/timer/stop`, { ...asB, method: 'POST', json: {} });
    expect(r.status).toBe(200); // B's own running entry is closed…
    expect(actualOf(aTask)).toBe(99); // …but the owner-scoped UPDATE leaves A's task untouched
  });
});

describe('pattern membership — cannot include another owner\'s task', () => {
  it('B adding A\'s task to B\'s pattern 404s and stores no membership', async () => {
    const aTask = insertTask(A);
    const bPat = insertPattern(B);
    const r = await api(srv.url, `/api/patterns/${bPat}/tasks`, { ...asB, method: 'POST', json: { task_id: aTask } });
    expect(r.status).toBe(404);
    expect(count(`SELECT COUNT(*) AS n FROM pattern_tasks WHERE pattern_id = ?`, bPat)).toBe(0);
  });

  it('a PATCH with a mix of owned + foreign task_ids keeps only the owner\'s own', async () => {
    const aTask = insertTask(A);
    const bTask = insertTask(B);
    const bPat = insertPattern(B);
    const r = await api(srv.url, `/api/patterns/${bPat}`, { ...asB, method: 'PATCH', json: { task_ids: [aTask, bTask] } });
    expect(r.status).toBe(200);
    const members = (sqlite.prepare(`SELECT task_id FROM pattern_tasks WHERE pattern_id = ? ORDER BY position`).all(bPat) as { task_id: string }[]).map((m) => m.task_id);
    expect(members).toEqual([bTask]); // A's task silently dropped
  });
});

describe('reminder — cannot target another owner\'s task', () => {
  it('B creating a reminder on A\'s task is rejected and stores no reminder', async () => {
    const aTask = insertTask(A);
    const r = await api(srv.url, '/api/reminders', { ...asB, method: 'POST', json: { taskId: aTask, fireAt: '2099-01-01T00:00:00.000Z' } });
    expect(r.status).toBe(422);
    expect(count(`SELECT COUNT(*) AS n FROM reminders WHERE task_id = ?`, aTask)).toBe(0);
  });
});

describe('import — cannot write another owner\'s partition', () => {
  const base = (owner: string, extra: Record<string, unknown> = {}) => ({
    version: '8', owner_id: owner,
    scheduling_prefs: [], tags: [], tasks: [], patterns: [],
    ...extra,
  });

  it('rejects (400) an import whose task row carries a foreign owner_id; A\'s row is untouched', async () => {
    const aTask = insertTask(A, 'A original');
    const payload = base(B, { tasks: [{ id: aTask, owner_id: A, title: 'HIJACKED', status: 'open' }] });
    const r = await api(srv.url, '/api/import', { ...asB, method: 'POST', json: payload });
    expect(r.status).toBe(400);
    expect(sqlite.prepare(`SELECT title, owner_id FROM tasks WHERE id = ?`).get(aTask)).toEqual({ title: 'A original', owner_id: A });
  });

  it('drops a junction (entity_tags) row that references A\'s task', async () => {
    const aTask = insertTask(A);
    const bTag = (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, 'btag', 'intention') RETURNING id`).get(B) as { id: string }).id;
    const payload = base(B, {
      tags: [{ id: bTag, owner_id: B, name: 'btag', kind: 'intention' }],
      entity_tags: [{ entity_kind: 'task', entity_id: aTask, tag_id: bTag, level: 1 }],
    });
    const r = await api(srv.url, '/api/import', { ...asB, method: 'POST', json: payload });
    expect(r.status).toBe(200);
    expect(count(`SELECT COUNT(*) AS n FROM entity_tags WHERE entity_id = ?`, aTask)).toBe(0);
  });
});
