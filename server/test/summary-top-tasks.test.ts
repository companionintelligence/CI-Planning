/**
 * Phase O · O0 — GET /api/summary/top-tasks.
 *
 * The Today's Brief top-tasks list: real, plannable Tasks for the day, ranked by
 * the frozen daily_plan then priority. EXCLUDES habits and routine/pattern
 * instances (mirrors the S3/S4 star rule). Pinned dates (TZ=UTC in CI).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const DAY = '2026-06-15';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

function makeTask(opts: { title: string; subtype?: string; priority?: number; recurrenceParentId?: string | null; status?: string }): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, subtype, priority, recurrence_parent_id, status, owner_id)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      opts.title, opts.subtype ?? 'standard', opts.priority ?? 3,
      opts.recurrenceParentId ?? null, opts.status ?? 'open', SYSTEM_OWNER,
    ) as { id: string }).id;
}

function plan(taskId: string, position: number) {
  sqlite.prepare(
    `INSERT INTO daily_plan (owner_id, date, task_id, position) VALUES (?, ?, ?, ?)`,
  ).run(SYSTEM_OWNER, DAY, taskId, position);
}

function blockOn(taskId: string, date: string) {
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO time_blocks (id, title, task_id, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, created_at)
     VALUES (uuid7(), 'blk', ?, 'task', ?, ?, 0, 1, 'auto', 'scheduled', ?)`,
  ).run(taskId, `${date}T10:00:00.000Z`, `${date}T11:00:00.000Z`, now);
}

const get = () => api(srv.url, `/api/summary/top-tasks?date=${DAY}`);

describe('GET /api/summary/top-tasks', () => {
  it('returns daily_plan tasks ranked by plan position', async () => {
    const a = makeTask({ title: 'A', priority: 5 });
    const b = makeTask({ title: 'B', priority: 1 });
    plan(a, 0); // planned first despite lower priority
    plan(b, 1);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: any) => t.title)).toEqual(['A', 'B']);
    expect(res.body.tasks.every((t: any) => t.planned)).toBe(true);
  });

  it('includes a task with a block placed today even if not in daily_plan', async () => {
    const t = makeTask({ title: 'Scheduled only' });
    blockOn(t, DAY);
    const res = await get();
    expect(res.body.tasks.map((t: any) => t.title)).toEqual(['Scheduled only']);
    expect(res.body.tasks[0].planned).toBe(false);
  });

  it('excludes habits', async () => {
    const habit = makeTask({ title: 'Meditate', subtype: 'habit' });
    plan(habit, 0);
    expect((await get()).body.tasks).toHaveLength(0);
  });

  it('excludes recurring/routine instances (recurrence_parent_id set)', async () => {
    const tmpl = makeTask({ title: 'Series', status: 'recurring' });
    const inst = makeTask({ title: 'Instance', recurrenceParentId: tmpl });
    plan(inst, 0);
    expect((await get()).body.tasks).toHaveLength(0);
  });

  it('excludes pattern (routine) member tasks', async () => {
    const t = makeTask({ title: 'Routine member' });
    const now = new Date().toISOString();
    const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, name, created_at) VALUES (uuid7(), ?, 'Morning', ?) RETURNING id`)
      .get(SYSTEM_OWNER, now) as { id: string }).id;
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(pid, t);
    plan(t, 0);
    expect((await get()).body.tasks).toHaveLength(0);
  });

  it('excludes tasks neither planned nor blocked today', async () => {
    makeTask({ title: 'Backlog only' });
    expect((await get()).body.tasks).toHaveLength(0);
  });

  it('reports done state for completed planned tasks', async () => {
    const t = makeTask({ title: 'Finished', status: 'done' });
    plan(t, 0);
    const res = await get();
    expect(res.body.tasks[0]).toMatchObject({ title: 'Finished', done: true });
  });
});
