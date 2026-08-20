/**
 * B1 — auto-defense.ts acceptance tests.
 *
 * All tests run under TZ=UTC (enforced by resetDb via timezone='UTC').
 * The workday is 09:00–18:00 UTC with a 10-minute break between sessions.
 *
 * Key invariants verified:
 *   - Identical state ⇒ empty diff (deterministic re-placement)
 *   - In-progress blocks are never moved
 *   - Stability window prevents immediate re-churn (anti-thrash)
 *   - A manually-locked auto block survives reflow, stays locked, and isn't duplicated
 *   - Gap-close: a reflow re-packs only what's already placed; it never pulls in backlog
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer, seedFallbackFillWindow } from './helpers.js';
import { reflow, recoverStaleFreezeLocks } from '../src/engine/auto-defense.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';

// ─── Helpers ────────────────────────────────────────────────────────────────

function insertTask(title: string, est = 30): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, estimated_minutes)
         VALUES (uuid7(), ?, ?, 'open', 3, ?) RETURNING id`
      )
      .get(title, OWNER, est) as { id: string }
  ).id;
}

function stage(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`)
    .run(OWNER, taskId, position);
}

function insertDailyPlan(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, ?, 'deterministic')`)
    .run(OWNER, DATE, taskId, position);
}

function insertMeeting(startAt: string, endAt: string): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, owner_id)
         VALUES (uuid7(), 'Meeting', 'meeting', ?, ?, 1, 0, 'manual', ?) RETURNING id`
      )
      .get(startAt, endAt, OWNER) as { id: string }
  ).id;
}

/** Auto blocks for DATE, ordered by start_at. */
function autoBlocks(): { id: string; task_id: string; start_at: string; end_at: string; is_locked: number; last_moved_at: string | null; status: string }[] {
  return sqlite
    .prepare(
      `SELECT id, task_id, start_at, end_at, is_locked, last_moved_at, status
         FROM time_blocks
        WHERE is_auto = 1 AND block_kind = 'task' AND source_kind = 'agent'
          AND start_at >= '${DATE}T00:00:00.000Z' AND start_at < '${DATE}T23:59:59.999Z'
          AND status NOT IN ('completed', 'skipped', 'cancelled')
        ORDER BY start_at`
    )
    .all() as { id: string; task_id: string; start_at: string; end_at: string; is_locked: number; last_moved_at: string | null; status: string }[];
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reflow', () => {
  it('returns empty diff when no auto blocks exist', async () => {
    const diff = await reflow(OWNER, DATE);
    expect(diff.moved).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.unplaced).toHaveLength(0);
  });

  it('identical placement ⇒ empty diff (deterministic re-placement)', async () => {
    const t1 = insertTask('T1');
    const t2 = insertTask('T2');
    insertDailyPlan(t1, 0);
    insertDailyPlan(t2, 1);
    stage(t1, 0);
    stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });

    const blocksBefore = autoBlocks();
    expect(blocksBefore).toHaveLength(2);

    const diff = await reflow(OWNER, DATE);

    expect(diff.moved).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    // New block IDs are created by placeFlightPlan, so IDs differ — but
    // diff compares by task_id + time, not block_id. Same times → no moves.
  });

  it('in_progress block is never moved', async () => {
    const t1 = insertTask('In-progress task');
    insertDailyPlan(t1, 0);
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });

    const [block] = autoBlocks();
    expect(block).toBeTruthy();
    const originalStart = block.start_at;

    // Mark in_progress
    sqlite.prepare(`UPDATE time_blocks SET status = 'in_progress' WHERE id = ?`).run(block.id);

    // A second task is added as disruption to force a different placement
    const t2 = insertTask('Disruptor', 30);
    insertDailyPlan(t2, 1);
    // Don't re-stage t2 — only testing that t1's in_progress block stays put

    const diff = await reflow(OWNER, DATE);

    const blocksAfter = autoBlocks();
    const inProgressBlock = blocksAfter.find((b) => b.task_id === t1);
    expect(inProgressBlock).toBeTruthy();
    expect(inProgressBlock!.start_at).toBe(originalStart);
    expect(diff.moved.find((m) => m.task_id === t1)).toBeUndefined();
  });

  it('stability window prevents re-churn on a second immediate reflow', async () => {
    const t1 = insertTask('T1');
    const t2 = insertTask('T2');
    insertDailyPlan(t1, 0);
    insertDailyPlan(t2, 1);
    stage(t1, 0);
    stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });

    // Insert a meeting that forces T1 and T2 to move on the first reflow.
    insertMeeting(`${DATE}T09:00:00.000Z`, `${DATE}T10:00:00.000Z`);

    const diff1 = await reflow(OWNER, DATE);
    // T1 and T2 should have moved due to the new meeting obstacle.
    expect(diff1.moved.length).toBeGreaterThan(0);

    // Verify last_moved_at was stamped on the new blocks.
    const blocksAfterFirst = autoBlocks();
    for (const b of blocksAfterFirst) {
      expect(b.last_moved_at).not.toBeNull();
    }

    // Second reflow: stability window should protect the moved blocks.
    const diff2 = await reflow(OWNER, DATE);
    expect(diff2.moved).toHaveLength(0);
  });

  it('a manually-locked auto block survives reflow, stays locked, and is not duplicated', async () => {
    const t1 = insertTask('Locked auto');
    insertDailyPlan(t1, 0);
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });

    const [block] = autoBlocks();
    expect(block).toBeTruthy();

    // Manually lock this auto block (e.g. user pinned it).
    sqlite.prepare(`UPDATE time_blocks SET is_locked = 1 WHERE id = ?`).run(block.id);

    await reflow(OWNER, DATE);

    // The locked block survives clearPriorAuto and stays locked...
    const afterBlock = sqlite
      .prepare(`SELECT is_locked FROM time_blocks WHERE id = ?`)
      .get(block.id) as { is_locked: number } | undefined;
    expect(afterBlock).toBeTruthy();
    expect(afterBlock!.is_locked).toBe(1);
    // ...and its task is held (protected), so reflow does NOT place a duplicate beside it.
    expect(autoBlocks().filter((b) => b.task_id === t1)).toHaveLength(1);
  });

  it('gap-close: deleting an earlier block compacts the rest and never pulls in backlog', async () => {
    const t1 = insertTask('T1');
    const t2 = insertTask('T2');
    const backlog = insertTask('Backlog'); // in the day's plan, but never placed
    insertDailyPlan(t1, 0);
    insertDailyPlan(t2, 1);
    insertDailyPlan(backlog, 2);
    stage(t1, 0);
    stage(t2, 1);
    await placeFlightPlan(OWNER, { date: DATE });

    const before = autoBlocks();
    expect(before).toHaveLength(2);
    const t2Start = before.find((b) => b.task_id === t2)!.start_at;

    // Remove the earlier task's block (t1), as the planner's "Remove" does, then reflow.
    const t1Block = before.find((b) => b.task_id === t1)!;
    sqlite.prepare(`DELETE FROM time_blocks WHERE id = ?`).run(t1Block.id);

    const diff = await reflow(OWNER, DATE);

    const after = autoBlocks();
    expect(after.map((b) => b.task_id)).toEqual([t2]); // only the survivor remains
    expect(after.some((b) => b.task_id === backlog)).toBe(false); // backlog never auto-placed
    expect(after[0].start_at < t2Start).toBe(true); // t2 compacted into the freed slot
    expect(diff.added).toHaveLength(0); // gap-close adds no new work
  });

  it('unplaced contains a placed task that no longer fits after a disruption', async () => {
    const t1 = insertTask('No room');
    insertDailyPlan(t1, 0);
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });
    expect(autoBlocks()).toHaveLength(1);

    // A full-day meeting lands, leaving no room to re-place t1 on reflow.
    insertMeeting(`${DATE}T09:00:00.000Z`, `${DATE}T18:00:00.000Z`);

    const diff = await reflow(OWNER, DATE);
    expect(diff.unplaced).toContain(t1);
    expect(diff.removed.some((r) => r.task_id === t1)).toBe(true);
  });

  it('recoverStaleFreezeLocks clears is_locked left on a planned auto block', async () => {
    const t1 = insertTask('Stuck');
    insertDailyPlan(t1, 0);
    stage(t1, 0);
    await placeFlightPlan(OWNER, { date: DATE });
    const [block] = autoBlocks();
    // Simulate residue from a reflow that died before unfreeze.
    sqlite.prepare(`UPDATE time_blocks SET is_locked = 1 WHERE id = ?`).run(block.id);

    const cleared = await recoverStaleFreezeLocks();
    expect(cleared).toBeGreaterThanOrEqual(1);
    const after = sqlite.prepare(`SELECT is_locked FROM time_blocks WHERE id = ?`).get(block.id) as { is_locked: number };
    expect(after.is_locked).toBe(0);
  });
});
