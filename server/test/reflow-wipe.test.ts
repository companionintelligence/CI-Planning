/**
 * Reflow-wipe regression suite (PR 1 — reflow correctness).
 *
 * THE BUG: reflow cleared ALL of the day's is_auto=1 agent task blocks but re-placed
 * only the subset it could find in `daily_plan` with `status='open'` — so editing one
 * task's start time (PATCH → requestReplan → reflow) silently unscheduled every
 * placement outside that set. Three real entry conditions, each a test below:
 *   A. task placed with no daily_plan row (author-once staleness),
 *   B. task status flipped to 'scheduled' by another placement path,
 *   C. no daily_plan authored at all (autoScheduleOnIngest / calendar-sync cron).
 * The explicit path had the same asymmetry: a second Auto run of the day deleted the
 * first run's (no-longer-staged) placements.
 *
 * THE FIX (snapshot-based reflow): clear set == re-place set by construction;
 * daily_plan orders, never gates; reflow bypasses the user's flight_plan staging.
 * Plus: status parity (placed = scheduled on every path, task_time stays user-only),
 * terminal-status vocab alignment ('missed'/'cancelled' evidence blocks survive),
 * owner-tz reactive dates, and the R3 not-before-now clamp for engine-chosen slots.
 *
 * All tests run under TZ=UTC; prefs timezone='UTC' unless a test sets otherwise.
 * Dates are fixed PAST days (clamp inactive) except the clamp/tz tests, which inject
 * nowMs — never the runner's clock (see reference_companion_test_gotchas).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer, seedFallbackFillWindow } from './helpers.js';
import { reflow, sweepMissedBlocks } from '../src/engine/auto-defense.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { updateTask } from '../src/services/tasks.js';
import { zonedWallTimeToUTC } from '../src/lib/tz.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';

function insertTask(title: string, est = 30, status = 'open'): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, estimated_minutes)
         VALUES (uuid7(), ?, ?, ?, 3, ?) RETURNING id`
      )
      .get(title, OWNER, status, est) as { id: string }
  ).id;
}

function stage(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`)
    .run(OWNER, taskId, position);
}

function insertDailyPlan(taskId: string, position: number, date = DATE): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, ?, 'deterministic')`)
    .run(OWNER, date, taskId, position);
}

function taskBlocks(taskId: string): { id: string; start_at: string; end_at: string; is_auto: number; status: string }[] {
  return sqlite
    .prepare(`SELECT id, start_at, end_at, is_auto, status FROM time_blocks WHERE task_id = ? AND block_kind = 'task' ORDER BY start_at`)
    .all(taskId) as { id: string; start_at: string; end_at: string; is_auto: number; status: string }[];
}

function taskRow(taskId: string): { status: string; scheduled_for: string | null; task_time: string | null } {
  return sqlite
    .prepare(`SELECT status, scheduled_for, task_time FROM tasks WHERE id = ?`)
    .get(taskId) as { status: string; scheduled_for: string | null; task_time: string | null };
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  seedFallbackFillWindow(); // 0156: Auto's fallback fill needs work/community windows
  sqlite.exec(`DELETE FROM flight_plan`);
  sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
  sqlite.prepare(
    `UPDATE scheduling_prefs SET timezone = 'UTC', auto_fill_workday = 1, max_focus_block_minutes = 90, min_break_minutes = 10 WHERE owner_id = ?`
  ).run(OWNER);
});

// ─── The wipe: a task-time edit must never unschedule the OTHER placed tasks ────

describe('reflow after a task-time edit keeps every other placement', () => {
  it('canonical: all tasks in daily_plan → others survive and stay placed', async () => {
    const t1 = insertTask('Edited');
    const t2 = insertTask('Other A');
    const t3 = insertTask('Other B');
    [t1, t2, t3].forEach((t, i) => { insertDailyPlan(t, i); stage(t, i); });
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskBlocks(t2)).toHaveLength(1);

    // The user edits t1's start time in the task modal → PATCH → updateTask (moves the
    // block via syncBlockFromTask, marking it is_auto=0) → route fires requestReplan.
    const res = await updateTask(OWNER, t1, { scheduled_for: DATE, task_time: '14:00' });
    expect(res.ok).toBe(true);
    await reflow(OWNER, DATE);

    expect(taskBlocks(t1), 'edited task keeps its (now manual) block').toHaveLength(1);
    expect(taskBlocks(t1)[0].is_auto).toBe(0);
    expect(taskBlocks(t2), 'other A must still be placed').toHaveLength(1);
    expect(taskBlocks(t3), 'other B must still be placed').toHaveLength(1);
  });

  it('variant A: a task placed WITHOUT a daily_plan row (author-once staleness) survives', async () => {
    const t1 = insertTask('Edited');
    const t2 = insertTask('In daily_plan');
    const t3 = insertTask('Staged after authoring'); // no daily_plan row — the author-once guard skipped it
    insertDailyPlan(t1, 0); insertDailyPlan(t2, 1);
    [t1, t2, t3].forEach((t, i) => stage(t, i));
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskBlocks(t3)).toHaveLength(1);

    await updateTask(OWNER, t1, { scheduled_for: DATE, task_time: '14:00' });
    await reflow(OWNER, DATE);

    expect(taskBlocks(t2)).toHaveLength(1);
    expect(taskBlocks(t3), 'unauthored task must NOT be wiped').toHaveLength(1);
  });

  it("variant B: a placed task whose status is 'scheduled' (not 'open') survives", async () => {
    const t1 = insertTask('Edited');
    const t2 = insertTask('Flipped to scheduled');
    insertDailyPlan(t1, 0); insertDailyPlan(t2, 1);
    stage(t1, 0); stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });
    // Parity now flips placed tasks itself, but assert the flow even for a task some
    // other path (wizard/add-tasks/routine) flipped.
    sqlite.prepare(`UPDATE tasks SET status = 'scheduled' WHERE id = ?`).run(t2);

    await updateTask(OWNER, t1, { scheduled_for: DATE, task_time: '14:00' });
    await reflow(OWNER, DATE);

    expect(taskBlocks(t2), "'scheduled' task must NOT be wiped").toHaveLength(1);
  });

  it('variant C: no daily_plan authored at all (autoScheduleOnIngest path) → nothing is wiped', async () => {
    const t1 = insertTask('Edited');
    const t2 = insertTask('Other A');
    const t3 = insertTask('Other B');
    [t1, t2, t3].forEach((t, i) => stage(t, i)); // NO daily_plan rows anywhere
    await placeFlightPlan(OWNER, { date: DATE });

    await updateTask(OWNER, t1, { scheduled_for: DATE, task_time: '14:00' });
    await reflow(OWNER, DATE);

    expect(taskBlocks(t1)).toHaveLength(1);
    expect(taskBlocks(t2), 'must NOT be wiped').toHaveLength(1);
    expect(taskBlocks(t3), 'must NOT be wiped').toHaveLength(1);
  });

  it('cron self-wipe: an immediate reflow after an unauthored placement keeps the fresh blocks', async () => {
    // sync_calendar: autoScheduleOnIngest places (never authors daily_plan), then the
    // same tick fires requestReplan('calendar') — the reflow must not eat what the
    // cron just placed.
    const t1 = insertTask('Ingested A');
    const t2 = insertTask('Ingested B');
    stage(t1, 0); stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskBlocks(t1)).toHaveLength(1);

    const diff = await reflow(OWNER, DATE, 'calendar');

    expect(taskBlocks(t1)).toHaveLength(1);
    expect(taskBlocks(t2)).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
  });
});

// ─── The explicit path's twin: a second Auto run is additive ───────────────────

describe('explicit Auto runs', () => {
  it('a second run places new work WITHOUT deleting the first run’s placements', async () => {
    const t1 = insertTask('First run A');
    const t2 = insertTask('First run B');
    stage(t1, 0); stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskBlocks(t1)).toHaveLength(1);
    const t1Start = taskBlocks(t1)[0].start_at;

    const t3 = insertTask('Second run');
    stage(t3, 0);
    await placeFlightPlan(OWNER, { date: DATE });

    expect(taskBlocks(t1), 'first run’s block must survive the second run').toHaveLength(1);
    expect(taskBlocks(t1)[0].start_at, 'and must not move').toBe(t1Start);
    expect(taskBlocks(t2)).toHaveLength(1);
    expect(taskBlocks(t3), 'new work placed around the existing blocks').toHaveLength(1);
  });

  it('re-staging an already-placed task re-places it once (no duplicate)', async () => {
    const t1 = insertTask('Re-staged');
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });
    stage(t1, 0); // user stages it again
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskBlocks(t1)).toHaveLength(1);
  });
});

// ─── Reflow hygiene: staging purity, GC, missed evidence ────────────────────────

describe('reflow hygiene', () => {
  it('never writes to the user’s flight_plan staging area', async () => {
    const t1 = insertTask('Placed');
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(OWNER)).toEqual({ n: 0 });

    await reflow(OWNER, DATE);

    expect(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(OWNER),
      'reflow must not leak rows into flight_plan',
    ).toEqual({ n: 0 });
  });

  it('garbage-collects the stale planned block of a task completed via task PATCH', async () => {
    const t1 = insertTask('Done under its block');
    const t2 = insertTask('Still live');
    stage(t1, 0); stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });
    sqlite.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(t1);

    await reflow(OWNER, DATE);

    expect(taskBlocks(t1), 'terminal task’s stale block is cleared, not re-placed').toHaveLength(0);
    expect(taskBlocks(t2)).toHaveLength(1);
  });

  it("preserves 'missed' evidence blocks (status-vocabulary alignment)", async () => {
    const t1 = insertTask('Missed earlier', 30, 'missed');
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
         VALUES (uuid7(), ?, ?, 'Missed earlier', 'task', ?, ?, 0, 1, 'agent', 'missed')`,
      )
      .run(t1, OWNER, `${DATE}T09:00:00.000Z`, `${DATE}T09:30:00.000Z`);
    const t2 = insertTask('Live');
    stage(t2, 0);
    await placeFlightPlan(OWNER, { date: DATE });

    await reflow(OWNER, DATE);

    expect(taskBlocks(t1), "the review surface's missed evidence must survive a reflow").toHaveLength(1);
    expect(taskBlocks(t1)[0].status).toBe('missed');
  });

  it("clearPriorAuto never deletes a re-placed task's own cancelled/missed blocks", async () => {
    // Sharper than the reflow case above: here the terminal blocks belong to the very
    // task being re-placed, so they sit squarely inside clearPriorAuto's task-id scope —
    // only the terminal-status filter keeps them alive.
    const t1 = insertTask('Second attempt');
    const insEvidence = sqlite.prepare(
      `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
       VALUES (uuid7(), ?, ?, 'Second attempt', 'task', ?, ?, 0, 1, 'agent', ?)`,
    );
    insEvidence.run(t1, OWNER, `${DATE}T09:00:00.000Z`, `${DATE}T09:30:00.000Z`, 'cancelled');
    insEvidence.run(t1, OWNER, `${DATE}T10:00:00.000Z`, `${DATE}T10:30:00.000Z`, 'missed');
    stage(t1, 0);

    await placeFlightPlan(OWNER, { date: DATE });

    const statuses = taskBlocks(t1).map((b) => b.status).sort();
    expect(statuses, 'terminal evidence survives alongside the new placement').toContain('cancelled');
    expect(statuses).toContain('missed');
    expect(statuses.filter((s) => s === 'planned'), 'the task still gets its new placement').toHaveLength(1);
  });
});

// ─── R2 status parity ───────────────────────────────────────────────────────────

describe('placement status parity', () => {
  it('placing flips open → scheduled and mirrors scheduled_for, but NEVER task_time', async () => {
    const t1 = insertTask('Placed');
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });

    const row = taskRow(t1);
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toBe(DATE);
    // task_time is USER-stated intent; if the engine mirrored its chosen slot here, the
    // next run's pin pass would freeze it as an is_auto=0 pin (reflow would rust solid).
    expect(row.task_time).toBeNull();
  });

  it('a reflow that cannot re-place a task reverts it to the open backlog', async () => {
    const t1 = insertTask('Squeezed out');
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskRow(t1).status).toBe('scheduled');

    // A full-day meeting lands; reflow can no longer fit t1.
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, owner_id)
         VALUES (uuid7(), 'All-day', 'meeting', ?, ?, 1, 0, 'manual', ?)`,
      )
      .run(`${DATE}T00:00:00.000Z`, `${DATE}T23:59:00.000Z`, OWNER);
    const diff = await reflow(OWNER, DATE);

    expect(diff.unplaced).toContain(t1);
    expect(taskBlocks(t1)).toHaveLength(0);
    expect(taskRow(t1).status, 'no placement left ⇒ back to open').toBe('open');
  });

  it('sweepMissedBlocks reverts a placement-scheduled task so it re-queues', async () => {
    const t1 = insertTask('Missed placement');
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });
    expect(taskRow(t1).status).toBe('scheduled');

    // Sweep "now" = end of that day: the block's end is in the past.
    const now = Date.parse(`${DATE}T23:00:00.000Z`);
    const res = await sweepMissedBlocks(OWNER, DATE, now);

    expect(res.skipped).toBe(1);
    expect(res.requeued, 'the scheduled→open revert must precede the open-check').toBe(1);
    expect(taskRow(t1).status).toBe('open');
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(OWNER, t1)).toEqual({ n: 1 });
  });
});

// ─── Owner-tz reactive date + R3 clamp ─────────────────────────────────────────

describe('owner-timezone dates and the not-before-now clamp', () => {
  it('a date-less reflow targets the OWNER’s current day, not the server’s', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'America/Los_Angeles' WHERE owner_id = ?`).run(OWNER);
    // Fixed instant: 2026-06-24 20:00Z = 13:00 in LA (server-UTC date and LA date agree
    // here; the assertion below pins the LA day resolution + survival, deterministic).
    const nowMs = Date.parse('2026-06-24T20:00:00.000Z');
    const laDay = '2026-06-24';
    const t1 = insertTask('LA task A');
    const t2 = insertTask('LA task B');
    stage(t1, 0); stage(t2, 1);
    await placeFlightPlan(OWNER, { date: laDay, nowMs });
    expect(taskBlocks(t1)).toHaveLength(1);

    const diff = await reflow(OWNER, undefined, 'task:updated', { nowMs });

    expect(taskBlocks(t1), 'reflow found (and kept) the owner-day blocks').toHaveLength(1);
    expect(taskBlocks(t2)).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
  });

  it('engine-chosen slots on the current day start no earlier than now', async () => {
    const nowMs = Date.parse(`${DATE}T14:07:00.000Z`); // mid-afternoon "now" on the placement day
    const t1 = insertTask('Afternoon A');
    const t2 = insertTask('Afternoon B');
    stage(t1, 0); stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE, nowMs });

    for (const t of [t1, t2]) {
      const [b] = taskBlocks(t);
      expect(b, 'still fits in the remaining day').toBeTruthy();
      expect(Date.parse(b.start_at)).toBeGreaterThanOrEqual(nowMs);
    }
  });

  it('a reflow late in the day re-packs into the REMAINING day, never into past gaps', async () => {
    const t1 = insertTask('Morning-placed');
    stage(t1, 0);
    // Placed in the morning (now = 08:00 → block lands at workday start 09:00).
    await placeFlightPlan(OWNER, { date: DATE, nowMs: Date.parse(`${DATE}T08:00:00.000Z`) });
    expect(taskBlocks(t1)[0].start_at).toBe(`${DATE}T09:00:00.000Z`);

    // 15:00: a disruption triggers a reflow. The 09:00 slot is in the past now.
    const nowMs = Date.parse(`${DATE}T15:00:00.000Z`);
    await reflow(OWNER, DATE, 'overrun', { nowMs });

    const [b] = taskBlocks(t1);
    expect(b).toBeTruthy();
    expect(Date.parse(b.start_at), 'never moved into an already-past slot').toBeGreaterThanOrEqual(nowMs);
  });

  it('an exact user task_time is honored even when it has already passed (stated intent)', async () => {
    const t1 = insertTask('Stated 09:30');
    sqlite.prepare(`UPDATE tasks SET scheduled_for = ?, task_time = '09:30' WHERE id = ?`).run(DATE, t1);
    stage(t1, 0);
    const nowMs = Date.parse(`${DATE}T15:00:00.000Z`); // 09:30 is long past
    await placeFlightPlan(OWNER, { date: DATE, nowMs });

    const [b] = taskBlocks(t1);
    expect(b).toBeTruthy();
    expect(b.start_at, 'stated time wins over the clamp').toBe(zonedWallTimeToUTC(DATE, '09:30', 'UTC'));
    expect(b.is_auto, 'stated-time pin is user intent, not engine output').toBe(0);
  });
});
