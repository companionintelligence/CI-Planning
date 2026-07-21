import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { reviewAndReschedule, rescheduleTask, backoffDays } from '../src/engine/review.js';

/**
 * Review + reschedule (PR-C+, Workstream B; UNIFIED 2026-07-20). Every priority
 * auto-defers with the +1/3/7 backoff — the old high-priority 'missed' parking is
 * retired (it starved Fill/Auto: the review surface only arrived in #409). Stuck
 * 'missed' one-offs are revived by the same backoff. daily_plan outcome stamps
 * KEEP the priority split ('missed' ≤2 / 'deferred' ≥3). hands_off owners get
 * everything reopened placed via placeStartAnchoredTask. Plus the reschedule
 * endpoint (+ Schedule-mode placement) and the owner-scoped POST /review/sweep.
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
    .prepare(`INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_auto, status, owner_id) VALUES (uuid7(), ?, 'b', 'task', ?, ?, 1, ?, ?) RETURNING id`)
    .get(taskId, start.toISOString(), end.toISOString(), status, OWNER) as { id: string }).id;
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

describe('reviewAndReschedule (unified auto-defer)', () => {
  it('low-priority miss auto-defers (+backoff), drops the stale block, bumps defer_count', () => {
    const t = insertTask('Low chore', 4, 'open', 0);
    insertBlock(t, -2); // ended 2h ago, un-started
    const r = reviewAndReschedule();
    expect(r).toMatchObject({ missed: 1, deferred: 1, revived: 0 });
    const after = task(t);
    expect(after.status).toBe('open');
    expect(after.defer_count).toBe(1);
    expect(after.scheduled_for).toBeTruthy(); // pushed to a future day
    expect(blockCount(t)).toBe(0);            // stale block dropped
  });

  it('high-priority miss ALSO auto-defers (unified — no more missed parking)', () => {
    const t = insertTask('Important', 1, 'open', 0);
    insertBlock(t, -2);
    const r = reviewAndReschedule();
    expect(r).toMatchObject({ missed: 1, deferred: 1, revived: 0 });
    const after = task(t);
    expect(after.status).toBe('open');        // back in circulation, never parked
    expect(after.defer_count).toBe(1);
    expect(after.scheduled_for).toBeTruthy();
    expect(blockCount(t)).toBe(0);
  });

  it('revives a stuck status=missed one-off (backoff → open), not recurring instances', () => {
    const stuck = insertTask('Stuck P1', 1, 'missed', 0); insertBlock(stuck, -2, 'missed');
    // A recurring INSTANCE stays missed — its missed day is genuine history.
    const parent = insertTask('Routine', 3, 'recurring');
    const inst = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, recurrence_parent_id) VALUES (uuid7(), 'Routine day', ?, 'missed', 3, ?) RETURNING id`)
      .get(OWNER, parent) as { id: string }).id;
    const r = reviewAndReschedule();
    expect(r.revived).toBe(1);
    const after = task(stuck);
    expect(after.status).toBe('open');
    expect(after.defer_count).toBe(1);
    expect(after.scheduled_for).toBeTruthy();
    expect(blockCount(stuck)).toBe(0);        // the relabelled 'missed' block dropped too
    expect(task(inst).status).toBe('missed'); // instance untouched
  });

  it('ignores future blocks and completed tasks', () => {
    const future = insertTask('Future', 4); insertBlock(future, +3);    // not yet due
    const done = insertTask('Done', 4, 'done'); insertBlock(done, -2);  // already done
    const r = reviewAndReschedule();
    expect(r.missed).toBe(0);
    expect(task(future).status).toBe('open');
    expect(task(done).status).toBe('done');
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

  it('is idempotent — a second immediate run moves nothing further', () => {
    const t = insertTask('Once', 1, 'open', 0);
    insertBlock(t, -2);
    reviewAndReschedule();
    const r2 = reviewAndReschedule();
    expect(r2).toMatchObject({ missed: 0, deferred: 0, revived: 0 });
    expect(task(t).defer_count).toBe(1); // not double-deferred
  });

  it('hands_off owner: a deferred task is placed into its new day (block created)', () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = 'hands_off' WHERE owner_id = ?`).run(OWNER);
    const t = insertTask('Auto-place me', 1, 'open', 0);
    insertBlock(t, -2);
    const r = reviewAndReschedule();
    expect(r.deferred).toBe(1);
    expect(r.placed).toBe(1);
    expect(task(t).status).toBe('scheduled'); // R2 parity: placed = scheduled
    expect(blockCount(t)).toBe(1);            // the new-day block exists
  });

  it('balanced (Suggest) owner: deferred task is reopened+dated but NOT placed', () => {
    const t = insertTask('Wait for me', 1, 'open', 0);
    insertBlock(t, -2);
    const r = reviewAndReschedule();
    expect(r.placed).toBe(0);
    expect(task(t).status).toBe('open');
    expect(blockCount(t)).toBe(0);
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

  it("stamps 'missed' on a high-priority miss — the outcome keeps the priority split even though the task now auto-defers", () => {
    const t = insertTask('Important', 1, 'open', 0);
    insertBlock(t, -2);
    insertDailyPlan(t, DATE);
    reviewAndReschedule();
    expect(planOutcome(t)).toBe('missed'); // the DAY's record: important work was missed
    expect(task(t).status).toBe('open');   // but the TASK auto-defers like everything else
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
  it('reschedules a missed task by N days, clears missed, drops stale blocks (Suggest: no placement)', async () => {
    const t = insertTask('Important', 1, 'missed', 0);
    insertBlock(t, -2, 'missed');
    const r = await api(srv.url, `/api/tasks/${t}/reschedule`, { method: 'POST', json: { days: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.scheduled_for).toBeTruthy();
    expect(r.body.placement).toBeUndefined(); // balanced owner — nothing placed
    const after = task(t);
    expect(after.status).toBe('open');
    expect(after.defer_count).toBe(1);
    expect(blockCount(t)).toBe(0);
  });

  it('Schedule mode (hands_off): the reopened task is placed on its new day and the response reports it', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = 'hands_off' WHERE owner_id = ?`).run(OWNER);
    const t = insertTask('Place me', 1, 'missed', 0);
    insertBlock(t, -2, 'missed');
    const r = await api(srv.url, `/api/tasks/${t}/reschedule`, { method: 'POST', json: { days: 1 } });
    expect(r.status).toBe(200);
    expect(r.body.placement?.placed).toBe(true);
    expect(r.body.placement?.startAt).toBeTruthy();
    expect(r.body.task.status).toBe('scheduled'); // response carries the post-placement row
    expect(blockCount(t)).toBe(1);
  });

  it('422 without days; 404 for unknown task', async () => {
    const t = insertTask('X', 3);
    expect((await api(srv.url, `/api/tasks/${t}/reschedule`, { method: 'POST', json: {} })).status).toBe(422);
    expect((await api(srv.url, `/api/tasks/999999/reschedule`, { method: 'POST', json: { days: 1 } })).status).toBe(404);
  });
});

describe('POST /api/review/sweep (the top-bar refresh)', () => {
  it('runs the owner-scoped sweep and returns the counts', async () => {
    const t = insertTask('Sweep me', 1, 'open', 0);
    insertBlock(t, -2);
    const stuck = insertTask('Stuck', 2, 'missed', 0);
    const r = await api(srv.url, `/api/review/sweep`, { method: 'POST', json: {} });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ missed: 1, deferred: 1, revived: 1 });
    expect(task(t).status).toBe('open');
    expect(task(stuck).status).toBe('open');
  });

  it('is a no-op returning zeros when nothing is stale', async () => {
    const r = await api(srv.url, `/api/review/sweep`, { method: 'POST', json: {} });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ missed: 0, deferred: 0, revived: 0, placed: 0 });
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
