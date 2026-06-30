import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { reviewAndReschedule, rescheduleTask, backoffDays } from '../src/engine/review.js';

/**
 * Nightly review + reschedule (PR-C+, Workstream B). Hybrid-by-priority: low
 * priority auto-defers with a +1/3/7 backoff; high priority is surfaced for the
 * user (status='missed'). Plus the +1/+3/+7 reschedule endpoint.
 */

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, priority: number, status = 'open', deferCount = 0): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, defer_count) VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING id`)
    .get(title, OWNER, status, priority, deferCount) as { id: string }).id;
}
/** A planned task block that ended in the past (missed) or future (not missed). */
function insertBlock(taskId: string, endOffsetHrs: number, status = 'planned'): string {
  const end = new Date(Date.now() + endOffsetHrs * 3600_000);
  const start = new Date(end.getTime() - 3600_000);
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_auto, status) VALUES (uuid7(), ?, 'b', 'task', ?, ?, 1, ?) RETURNING id`)
    .get(taskId, start.toISOString(), end.toISOString(), status) as { id: string }).id;
}
const task = (id: string) => sqlite.prepare(`SELECT status, scheduled_for, defer_count FROM tasks WHERE id = ?`).get(id) as
  { status: string; scheduled_for: string | null; defer_count: number };
const blockCount = (taskId: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE task_id = ?`).get(taskId) as { n: number }).n;

function insertDailyPlan(taskId: string, date: string): void {
  sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, 0, 'deterministic')`).run(OWNER, date, taskId);
}
const planOutcome = (taskId: string): string | null =>
  (sqlite.prepare(`SELECT outcome FROM daily_plan WHERE task_id = ?`).get(taskId) as { outcome: string | null } | undefined)?.outcome ?? null;

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

describe('daily_plan.outcome stamping (N4 lossy-slip fix)', () => {
  const DATE = '2026-06-29';

  it("stamps 'deferred' on auto-deferred low-priority task", () => {
    const t = insertTask('Low chore', 4, 'open', 0);
    insertBlock(t, -2);
    insertDailyPlan(t, DATE);
    reviewAndReschedule();
    expect(planOutcome(t)).toBe('deferred');
  });

  it("stamps 'missed' on surfaced high-priority task", () => {
    const t = insertTask('Important', 1, 'open', 0);
    insertBlock(t, -2);
    insertDailyPlan(t, DATE);
    reviewAndReschedule();
    expect(planOutcome(t)).toBe('missed');
  });

  it('is write-once: does not overwrite an already-stamped outcome', () => {
    const t = insertTask('Low chore', 4, 'open', 0);
    insertBlock(t, -2);
    insertDailyPlan(t, DATE);
    sqlite.prepare(`UPDATE daily_plan SET outcome = 'completed' WHERE task_id = ?`).run(t);
    reviewAndReschedule();
    expect(planOutcome(t)).toBe('completed');
  });

  it('is a no-op when no daily_plan row exists (task never planned by AI)', () => {
    const t = insertTask('Unplanned', 4, 'open', 0);
    insertBlock(t, -2);
    // No insertDailyPlan — task was not in an AI plan
    reviewAndReschedule();
    expect(planOutcome(t)).toBeNull();
    expect(task(t).defer_count).toBe(1); // still deferred normally
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
    const job = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'review_day'`).get() as { id: string } | undefined;
    expect(job).toBeTruthy();
    const t = insertTask('Low', 4); insertBlock(t, -2);
    const r = await api(srv.url, `/api/jobs/${job!.id}/run`, { method: 'POST', json: {} });
    expect(r.status).toBe(200);
    expect(task(t).defer_count).toBe(1); // the job actually reviewed
    expect(rescheduleTask).toBeTypeOf('function');
  });
});

describe('re-stage into flight plan at review (item 5)', () => {
  beforeEach(() => {
    sqlite.exec(`DELETE FROM flight_plan`);
  });

  it('re-stages open tasks with no future blocks into the flight plan', () => {
    const t = insertTask('Open no blocks', 3);
    const r = reviewAndReschedule({ nowISO: new Date().toISOString() });
    expect(r.restaged).toBe(1);
    const fp = sqlite.prepare(`SELECT selected FROM flight_plan WHERE task_id = ?`).get(t) as { selected: number } | undefined;
    expect(fp).toBeTruthy();
    expect(fp!.selected).toBe(1);
  });

  it('habits (subtype=habit) are not re-staged', () => {
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id, status, priority, subtype) VALUES (uuid7(), 'Morning run', ?, 'open', 3, 'habit')`
    ).run(OWNER);
    const r = reviewAndReschedule({ nowISO: new Date().toISOString() });
    expect(r.restaged).toBe(0);
  });

  it('tasks already in the flight plan are not re-staged again', () => {
    const t = insertTask('Already staged', 3);
    sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, t);
    const r = reviewAndReschedule({ nowISO: new Date().toISOString() });
    expect(r.restaged).toBe(0);
    const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE task_id = ?`).get(t) as { n: number }).n;
    expect(n).toBe(1); // no duplicate
  });

  it('tasks with a future block are not re-staged', () => {
    const t = insertTask('Has future block', 3);
    insertBlock(t, +3); // ends 3h from now
    const r = reviewAndReschedule({ nowISO: new Date().toISOString() });
    expect(r.restaged).toBe(0);
  });

  it('re-staging is idempotent — two review runs do not double-stage', () => {
    const t = insertTask('Idempotent task', 3);
    reviewAndReschedule({ nowISO: new Date().toISOString() });
    reviewAndReschedule({ nowISO: new Date().toISOString() });
    const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE task_id = ?`).get(t) as { n: number }).n;
    expect(n).toBe(1);
  });
});
