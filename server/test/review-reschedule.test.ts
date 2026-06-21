import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { reviewAndReschedule, rescheduleTask, backoffDays } from '../src/engine/review.js';

/**
 * Nightly review + reschedule (PR-C+, Workstream B). Hybrid-by-priority: low
 * priority auto-defers with a +1/3/7 backoff; high priority is surfaced for the
 * user (status='missed'). Plus the +1/+3/+7 reschedule endpoint.
 */

const OWNER = 1;

function insertTask(title: string, priority: number, status = 'open', deferCount = 0): number {
  return (sqlite
    .prepare(`INSERT INTO tasks (title, owner_id, status, priority, defer_count) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(title, OWNER, status, priority, deferCount) as { id: number }).id;
}
/** A planned task block that ended in the past (missed) or future (not missed). */
function insertBlock(taskId: number, endOffsetHrs: number, status = 'planned'): number {
  const end = new Date(Date.now() + endOffsetHrs * 3600_000);
  const start = new Date(end.getTime() - 3600_000);
  return (sqlite
    .prepare(`INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, is_auto, status) VALUES (?, 'b', 'task', ?, ?, 1, ?) RETURNING id`)
    .get(taskId, start.toISOString(), end.toISOString(), status) as { id: number }).id;
}
const task = (id: number) => sqlite.prepare(`SELECT status, scheduled_for, defer_count FROM tasks WHERE id = ?`).get(id) as
  { status: string; scheduled_for: string | null; defer_count: number };
const blockCount = (taskId: number) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE task_id = ?`).get(taskId) as { n: number }).n;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('backoffDays', () => {
  it('escalates 0→1, 1→3, 2+→7', () => {
    expect(backoffDays(0)).toBe(1);
    expect(backoffDays(1)).toBe(3);
    expect(backoffDays(2)).toBe(7);
    expect(backoffDays(9)).toBe(7);
  });
});

describe('reviewAndReschedule (hybrid by priority)', () => {
  it('low-priority miss auto-defers (+backoff), drops the stale block, bumps defer_count', () => {
    const t = insertTask('Low chore', 4, 'open', 0);
    insertBlock(t, -2); // ended 2h ago, un-started
    const r = reviewAndReschedule();
    expect(r).toMatchObject({ missed: 1, deferred: 1, surfaced: 0 });
    const after = task(t);
    expect(after.status).toBe('open');
    expect(after.defer_count).toBe(1);
    expect(after.scheduled_for).toBeTruthy(); // pushed to a future day
    expect(blockCount(t)).toBe(0);            // stale block dropped
  });

  it('high-priority miss is surfaced (status=missed), NOT moved silently', () => {
    const t = insertTask('Important', 1, 'open', 0);
    insertBlock(t, -2);
    const r = reviewAndReschedule();
    expect(r).toMatchObject({ missed: 1, deferred: 0, surfaced: 1 });
    const after = task(t);
    expect(after.status).toBe('missed');
    expect(after.scheduled_for).toBeNull(); // not moved
    expect(after.defer_count).toBe(0);
  });

  it('ignores future blocks, completed tasks, and already-missed tasks', () => {
    const future = insertTask('Future', 4); insertBlock(future, +3);    // not yet due
    const done = insertTask('Done', 4, 'done'); insertBlock(done, -2);  // already done
    const already = insertTask('Already', 4, 'missed'); insertBlock(already, -2);
    const r = reviewAndReschedule();
    expect(r.missed).toBe(0);
    expect(task(future).status).toBe('open');
  });

  it('backoff escalates across successive misses (defer_count drives +1 → +3 → +7)', () => {
    const t = insertTask('Repeat-misser', 5, 'open', 0);
    insertBlock(t, -2);
    reviewAndReschedule();
    expect(task(t).defer_count).toBe(1);
    // simulate the next day's miss
    insertBlock(t, -2);
    reviewAndReschedule();
    expect(task(t).defer_count).toBe(2);
  });
});

describe('POST /api/tasks/:id/reschedule', () => {
  it('reschedules a missed task by N days, clears missed, drops stale blocks', async () => {
    const t = insertTask('Important', 1, 'missed', 0);
    insertBlock(t, -2, 'missed');
    const r = await api(srv.url, `/api/tasks/${t}/reschedule`, { method: 'POST', json: { days: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.scheduled_for).toBeTruthy();
    const after = task(t);
    expect(after.status).toBe('open');
    expect(after.defer_count).toBe(1);
    expect(blockCount(t)).toBe(0);
  });

  it('422 without days; 404 for unknown task', async () => {
    const t = insertTask('X', 3);
    expect((await api(srv.url, `/api/tasks/${t}/reschedule`, { method: 'POST', json: {} })).status).toBe(422);
    expect((await api(srv.url, `/api/tasks/999999/reschedule`, { method: 'POST', json: { days: 1 } })).status).toBe(404);
  });
});

describe('review_day job', () => {
  it('is seeded and runs via POST /api/jobs/:id/run', async () => {
    const job = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'review_day'`).get() as { id: number } | undefined;
    expect(job).toBeTruthy();
    const t = insertTask('Low', 4); insertBlock(t, -2);
    const r = await api(srv.url, `/api/jobs/${job!.id}/run`, { method: 'POST', json: {} });
    expect(r.status).toBe(200);
    expect(task(t).defer_count).toBe(1); // the job actually reviewed
    expect(rescheduleTask).toBeTypeOf('function');
  });
});
