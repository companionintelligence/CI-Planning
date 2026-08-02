/**
 * Phase AE hardening (PR 2) — the peripheral scheduling-correctness findings.
 *
 *  H1  requestReplan fires only on a scheduling-relevant task edit (updateTouchesSchedule).
 *  H2  rescheduleTask + the nightly review never destroy a user-LOCKED (pinned) block,
 *      and a locked past block never triggers an endless nightly re-defer.
 *  H4  placeStartAnchoredTask / pinTaskAt idempotency is DAY-scoped: a stale block on
 *      another day no longer suppresses the stated day (a locked pin elsewhere is honoured).
 *  H5  sweepMissedBlocks re-queues each task at a distinct flight-plan position, not 0.
 *      Plus a characterization of multi-session edit behaviour after AE.
 *
 * TZ=UTC; prefs timezone='UTC' so expected instants are plain UTC wall times.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { placeFlightPlan, placeStartAnchoredTask } from '../src/engine/autoplan.js';
import { reviewAndReschedule, rescheduleTask } from '../src/engine/review.js';
import { sweepMissedBlocks } from '../src/engine/auto-defense.js';
import { updateTouchesSchedule, updateTask } from '../src/services/tasks.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, opts: { est?: number; priority?: number; status?: string; scheduledFor?: string; taskTime?: string } = {}): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, scheduled_for, task_time)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(title, OWNER, opts.status ?? 'open', opts.est ?? 60, opts.priority ?? 3, opts.scheduledFor ?? null, opts.taskTime ?? null) as { id: string }).id;
}
function stage(taskId: string, position = 0): void {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`).run(OWNER, taskId, position);
}
function insertBlock(taskId: string, startAt: string, endAt: string, opts: { isAuto?: number; isLocked?: number; status?: string; source?: string } = {}): string {
  return (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_auto, is_locked, source_kind, status)
       VALUES (uuid7(), ?, ?, 'B', 'task', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(taskId, OWNER, startAt, endAt, opts.isAuto ?? 0, opts.isLocked ?? 0, opts.source ?? 'agent', opts.status ?? 'planned') as { id: string }).id;
}
function taskBlocks(taskId: string): { id: string; start_at: string; is_auto: number; is_locked: number; status: string }[] {
  return sqlite
    .prepare(`SELECT id, start_at, is_auto, is_locked, status FROM time_blocks WHERE task_id = ? AND block_kind = 'task' ORDER BY start_at`)
    .all(taskId) as { id: string; start_at: string; is_auto: number; is_locked: number; status: string }[];
}
function taskRow(taskId: string): { status: string; scheduled_for: string | null; defer_count: number | null } {
  return sqlite.prepare(`SELECT status, scheduled_for, defer_count FROM tasks WHERE id = ?`).get(taskId) as { status: string; scheduled_for: string | null; defer_count: number | null };
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan`);
  sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 1, max_focus_block_minutes = 90, min_break_minutes = 10 WHERE owner_id = ?`).run(OWNER);
});

// ─── H1 — narrowed replan trigger ──────────────────────────────────────────────

describe('H1 updateTouchesSchedule', () => {
  it('is true for scheduling columns, false for content-only columns', () => {
    for (const f of ['scheduledFor', 'taskTime', 'estimatedMinutes', 'priority', 'dueAt', 'status', 'completedAt', 'deferUntil']) {
      expect(updateTouchesSchedule([f]), f).toBe(true);
    }
    for (const f of ['title', 'description', 'notes', 'parentId', 'recurrenceRule', 'subtype']) {
      expect(updateTouchesSchedule([f]), f).toBe(false);
    }
    expect(updateTouchesSchedule([])).toBe(false);
    expect(updateTouchesSchedule(['title', 'priority'])).toBe(true); // mixed → relevant
  });

  it('a title-only PATCH reports no scheduling change (route would skip requestReplan)', async () => {
    const t = insertTask('Rename me');
    const res = await updateTask(OWNER, t, { title: 'Renamed' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.updatedFields).toEqual(['title']);
      expect(updateTouchesSchedule(res.updatedFields)).toBe(false);
    }
  });
});

// ─── H2 — locked-block guards ───────────────────────────────────────────────────

describe('H2 locked blocks survive reschedule + review', () => {
  it('rescheduleTask keeps a locked block, drops the unlocked one', async () => {
    const t = insertTask('Has a pin', { scheduledFor: '2026-06-24' });
    const locked = insertBlock(t, '2026-06-24T09:00:00.000Z', '2026-06-24T10:00:00.000Z', { isLocked: 1 });
    insertBlock(t, '2026-06-24T11:00:00.000Z', '2026-06-24T12:00:00.000Z', { isLocked: 0 }); // unlocked

    await rescheduleTask(t, 3, OWNER);

    const blocks = taskBlocks(t);
    expect(blocks.map((b) => b.id)).toEqual([locked]); // only the pin survives
    expect(taskRow(t).status).toBe('open');
  });

  it('the nightly review leaves a locked past block alone (no defer, no re-defer loop)', async () => {
    const now = '2026-06-24T20:00:00.000Z';
    const t = insertTask('Pinned but not done', { priority: 3 }); // low priority → would auto-defer if missed
    const locked = insertBlock(t, '2026-06-24T09:00:00.000Z', '2026-06-24T10:00:00.000Z', { isAuto: 1, isLocked: 1 });

    const r = await reviewAndReschedule({ nowISO: now });

    // The locked past block is not "missed work": no defer, block survives, task untouched.
    expect(taskBlocks(t).map((b) => b.id)).toEqual([locked]);
    expect(taskRow(t).status).toBe('open');
    expect(taskRow(t).scheduled_for).toBeNull(); // NOT bumped
    // A second run must not re-defer it either (would be an endless nightly loop).
    await reviewAndReschedule({ nowISO: '2026-06-25T20:00:00.000Z' });
    expect(taskBlocks(t).map((b) => b.id)).toEqual([locked]);
    expect(taskRow(t).defer_count ?? 0).toBe(0);
    expect(r.missed).toBeGreaterThanOrEqual(0);
  });

  it('the review still defers an UNLOCKED missed low-priority block (control)', async () => {
    const t = insertTask('Genuinely missed', { priority: 3 });
    insertBlock(t, '2026-06-24T09:00:00.000Z', '2026-06-24T10:00:00.000Z', { isAuto: 1, isLocked: 0 });

    await reviewAndReschedule({ nowISO: '2026-06-24T20:00:00.000Z' });

    expect(taskBlocks(t), 'unlocked missed block is dropped on defer').toHaveLength(0);
    expect((taskRow(t).defer_count ?? 0)).toBe(1);
  });
});

// ─── H4 — day-scoped pin idempotency ────────────────────────────────────────────

describe('H4 placeStartAnchoredTask idempotency is day-scoped', () => {
  it('honours the stated day even when a stale block sits on another day (moves it)', () => {
    const t = insertTask('Stated today, stale yesterday', { scheduledFor: '2026-06-25', taskTime: '10:00', est: 60 });
    insertBlock(t, '2026-06-20T09:00:00.000Z', '2026-06-20T10:00:00.000Z', { isAuto: 0, isLocked: 0 }); // stale, other day

    const out = placeStartAnchoredTask(OWNER, t, { silent: true, nowMs: Date.parse('2026-06-25T00:00:00.000Z') });

    expect(out.placed).toBe(true);
    const blocks = taskBlocks(t);
    expect(blocks, 'the stale other-day block was moved, not duplicated').toHaveLength(1);
    expect(blocks[0].start_at).toBe('2026-06-25T10:00:00.000Z'); // honoured the stated (day, time)
  });

  it('treats a LOCKED pin on another day as the placement (never fights the pin)', () => {
    const t = insertTask('Pinned elsewhere', { scheduledFor: '2026-06-25', taskTime: '10:00', est: 60 });
    const locked = insertBlock(t, '2026-06-20T09:00:00.000Z', '2026-06-20T10:00:00.000Z', { isLocked: 1 });

    const out = placeStartAnchoredTask(OWNER, t, { silent: true, nowMs: Date.parse('2026-06-25T00:00:00.000Z') });

    expect(out.placed).toBe(true);
    expect(taskBlocks(t).map((b) => b.id), 'no competing block created').toEqual([locked]);
  });

  it('is idempotent against a block already on the stated day (no duplicate)', () => {
    const t = insertTask('Already placed today', { scheduledFor: '2026-06-25', taskTime: '10:00', est: 60 });
    const sameDay = insertBlock(t, '2026-06-25T14:00:00.000Z', '2026-06-25T15:00:00.000Z', { isAuto: 0 });

    const out = placeStartAnchoredTask(OWNER, t, { silent: true, nowMs: Date.parse('2026-06-25T00:00:00.000Z') });

    expect(out.placed).toBe(true);
    expect(taskBlocks(t).map((b) => b.id)).toEqual([sameDay]); // reused, not duplicated
  });
});

// ─── H5 — sweep requeue positions + multi-session characterization ──────────────

describe('H5 sweep requeue + multi-session', () => {
  it('re-queues each missed task at a distinct flight-plan position (not all 0)', () => {
    const t1 = insertTask('Missed A');
    const t2 = insertTask('Missed B');
    // Two agent auto blocks whose planned end is in the past.
    insertBlock(t1, '2026-06-24T09:00:00.000Z', '2026-06-24T09:30:00.000Z', { isAuto: 1 });
    insertBlock(t2, '2026-06-24T10:00:00.000Z', '2026-06-24T10:30:00.000Z', { isAuto: 1 });

    const res = sweepMissedBlocks(OWNER, '2026-06-24', Date.parse('2026-06-24T23:00:00.000Z'));

    expect(res.skipped).toBe(2);
    expect(res.requeued).toBe(2);
    const positions = (sqlite
      .prepare(`SELECT task_id, position FROM flight_plan WHERE owner_id = ? ORDER BY position`)
      .all(OWNER) as { task_id: string; position: number }[]).map((r) => r.position);
    expect(new Set(positions).size, 'distinct positions, not all 0').toBe(2);
  });

  it('multi-session task keeps a single coherent placement after a time edit + reflow (no duplication)', async () => {
    // 180min task with a 90m focus cap → two sessions.
    const t = insertTask('Deep work', { est: 180 });
    stage(t);
    placeFlightPlan(OWNER, { date: '2026-06-24', nowMs: Date.parse('2026-06-24T08:00:00.000Z') });
    expect(taskBlocks(t).length, 'placed as 2 sessions').toBe(2);

    // User edits the task's start time; the service moves the earliest block (is_auto=0)
    // and the PATCH-triggered reflow re-packs. The invariant: the task must not end up
    // double-placed (an is_auto=0 survivor beside freshly-created is_auto=1 sessions).
    await updateTask(OWNER, t, { scheduled_for: '2026-06-24', task_time: '14:00' });
    const { reflow } = await import('../src/engine/auto-defense.js');
    reflow(OWNER, '2026-06-24', 'task:updated', { nowMs: Date.parse('2026-06-24T08:05:00.000Z') });

    const blocks = taskBlocks(t);
    const starts = blocks.map((b) => b.start_at);
    expect(new Set(starts).size, 'no two blocks share a start (no duplication)').toBe(starts.length);
    // The user's stated 14:00 placement is present and manual.
    const pin = blocks.find((b) => b.start_at === '2026-06-24T14:00:00.000Z');
    expect(pin, 'the stated-time block exists').toBeTruthy();
    expect(pin!.is_auto).toBe(0);
  });
});
