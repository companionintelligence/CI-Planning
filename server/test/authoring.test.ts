/**
 * Phase M §0 / A1 — acceptance tests for the durable day-plan authoring seam.
 *
 * All DB-backed tests use SYSTEM_OWNER (seeded by 0003_seed_defaults) and the
 * standard resetDb() + explicit daily_plan / flight_plan cleanup in beforeEach.
 *
 * The LLM-enabled path is gated on ollamaAvailable() so the suite is always
 * green in CI (where Ollama is absent) — the loop harness fallback path is fully
 * exercised by loop.test.ts mocks.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, ollamaAvailable, type TestServer } from './helpers.js';
import { authorPlanOrder } from '../src/agents/plan.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';

// ─── Helpers ────────────────────────────────────────────────────────────────

function insertTask(title: string, priority = 3, dueAt?: string, est = 30): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, due_at, estimated_minutes)
         VALUES (uuid7(), ?, ?, 'open', ?, ?, ?) RETURNING id`,
      )
      .get(title, OWNER, priority, dueAt ?? null, est) as { id: string }
  ).id;
}

function stage(taskId: string, position: number): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`)
    .run(OWNER, taskId, position);
}

function dailyPlanRows(date = DATE): { task_id: string; position: number; source: string; block_id: string | null }[] {
  return sqlite
    .prepare(`SELECT task_id, position, source, block_id FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
    .all(OWNER, date) as { task_id: string; position: number; source: string; block_id: string | null }[];
}

// ─── Suite setup ────────────────────────────────────────────────────────────

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
  // resetDb() already clears daily_plan; here for explicitness
  sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}';`);
  // fill_order='overdue' = deadline-first (the Phase-M default); the deterministic
  // ordering tests below assert deadline-first behaviour explicitly.
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', planning_mode = 'basic', fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('authorPlanOrder — deterministic path (planning_mode = basic)', () => {
  it('writes one daily_plan row per staged task, ordered by deterministic priority+due sort', async () => {
    const p3 = insertTask('Low priority', 3);
    const p1 = insertTask('High priority', 1);
    stage(p3, 0); // p3 first in flight_plan
    stage(p1, 1); // p1 second

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(2);
    // Deterministic: P1 before P3
    expect(rows[0].task_id).toBe(p1);
    expect(rows[0].position).toBe(0);
    expect(rows[0].source).toBe('deterministic');
    expect(rows[1].task_id).toBe(p3);
    expect(rows[1].position).toBe(1);
  });

  it('is a no-op (author-once) on a second call for the same day', async () => {
    const t = insertTask('Task A', 2);
    stage(t, 0);

    await authorPlanOrder(OWNER, DATE);
    const firstRows = dailyPlanRows();

    // Add another task and re-call — second call must be a no-op
    const t2 = insertTask('Task B', 1);
    stage(t2, 1);
    await authorPlanOrder(OWNER, DATE);

    const secondRows = dailyPlanRows();
    expect(secondRows).toHaveLength(firstRows.length); // no new rows
    expect(secondRows[0].task_id).toBe(firstRows[0].task_id);
  });

  it('is a no-op when fewer than 2 tasks are staged', async () => {
    const t = insertTask('Solo task');
    stage(t, 0);

    await authorPlanOrder(OWNER, DATE);

    // Single-task case: writes one deterministic row
    const rows = dailyPlanRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(t);

    // Zero-task case: no rows
    sqlite.exec(`DELETE FROM daily_plan;`);
    sqlite.exec(`DELETE FROM flight_plan;`);
    await authorPlanOrder(OWNER, DATE);
    expect(dailyPlanRows()).toHaveLength(0);
  });

  it('writes nothing when the flight_plan is empty', async () => {
    await authorPlanOrder(OWNER, DATE);
    expect(dailyPlanRows()).toHaveLength(0);
  });

  it('orders past-due tasks before equal-priority future-due tasks', async () => {
    const overdue = insertTask('Overdue task', 2, '2026-01-01');
    const future = insertTask('Future task', 2, '2026-12-31');
    stage(future, 0); // future staged first
    stage(overdue, 1);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows[0].task_id).toBe(overdue); // past-due sorts first
    expect(rows[1].task_id).toBe(future);
  });

  it('a deadline on a lower-priority task places it before a higher-priority no-deadline task', async () => {
    // Deterministic sort is deadline-first: due_at → priority → id.
    // P3 with a deadline sorts before P1 with no deadline ('9999' sentinel).
    const p1NoDue = insertTask('High priority no deadline', 1);
    const p3WithDue = insertTask('Low priority urgent', 3, DATE);
    stage(p3WithDue, 0);
    stage(p1NoDue, 1);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    // Deadline beats priority: p3WithDue comes first.
    expect(rows[0].task_id).toBe(p3WithDue);
    expect(rows[1].task_id).toBe(p1NoDue);
  });

  it('fill_order=priority flips the authored order to priority-first', async () => {
    // The fill_order pref maps onto authoring: 'priority' → priority beats deadline.
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'priority' WHERE owner_id = ?`).run(OWNER);
    const p1NoDue = insertTask('High priority no deadline', 1);
    const p3WithDue = insertTask('Low priority urgent', 3, DATE);
    stage(p3WithDue, 0);
    stage(p1NoDue, 1);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    // Priority-first: P1 (no deadline) now precedes the urgent P3.
    expect(rows[0].task_id).toBe(p1NoDue);
    expect(rows[1].task_id).toBe(p3WithDue);
  });

  // Authoring must honor fill_order='new_today' for the same reason it honors the other
  // two: placement skips its own fill_order branch whenever a daily_plan exists, so a
  // value only the engine understood would be inert on every deliberately-planned day.
  it('fill_order=new_today leads with tasks created today, deadline-first within each half', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'new_today' WHERE owner_id = ?`).run(OWNER);
    const oldUrgent = insertTask('Old but urgent', 3, DATE);
    sqlite
      .prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 9 * 86_400_000).toISOString(), oldUrgent);
    const freshLater = insertTask('Arrived today, later deadline', 3, '2026-12-31T00:00:00.000Z');
    stage(oldUrgent, 0);
    stage(freshLater, 1);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    // Today's arrival leads even though the older task is the more urgent one — under
    // the 'overdue' default (this suite's baseline) the order would be reversed.
    expect(rows[0].task_id).toBe(freshLater);
    expect(rows[1].task_id).toBe(oldUrgent);
  });
});

describe('placeFlightPlan — reads daily_plan.position (§0 seam)', () => {
  beforeEach(() => {
    // A workday plan block to place into (no Plans = workday fallback only)
    sqlite.prepare(`UPDATE scheduling_prefs SET auto_fill_workday = 1 WHERE owner_id = ?`).run(OWNER);
  });

  it('places tasks in daily_plan order, not flight_plan.position order', async () => {
    const p1 = insertTask('High priority', 1, undefined, 30);
    const p3 = insertTask('Low priority', 3, undefined, 30);
    // Stage p3 at position 0, p1 at position 1 (counter-priority)
    stage(p3, 0);
    stage(p1, 1);

    // Write daily_plan with the reversed order (p3 first — as if the LLM put it first)
    sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, ?, 'test')`).run(OWNER, DATE, p3, 0);
    sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, ?, 'test')`).run(OWNER, DATE, p1, 1);

    await placeFlightPlan(OWNER, { date: DATE });

    const blocks = sqlite
      .prepare(`SELECT title, start_at FROM time_blocks WHERE is_auto = 1 AND block_kind = 'task' ORDER BY start_at`)
      .all() as { title: string; start_at: string }[];

    expect(blocks).toHaveLength(2);
    // daily_plan says p3 first → p3's block should start earlier
    expect(blocks[0].title).toBe('Low priority');
    expect(blocks[1].title).toBe('High priority');
  });

  it('falls back to priority order when no daily_plan row exists', async () => {
    // Without a daily_plan, the workday pass calls orderForPlan which sorts by priority.
    // Stage the lower-priority task first (counter-priority) to prove it's not fp.position.
    const high = insertTask('High priority', 1, undefined, 30);
    const low = insertTask('Low priority', 3, undefined, 30);
    stage(low, 0); // staged first but lower priority
    stage(high, 1);

    await placeFlightPlan(OWNER, { date: DATE });

    const blocks = sqlite
      .prepare(`SELECT title, start_at FROM time_blocks WHERE is_auto = 1 AND block_kind = 'task' ORDER BY start_at`)
      .all() as { title: string; start_at: string }[];

    expect(blocks[0].title).toBe('High priority'); // priority wins over fp.position
    expect(blocks[1].title).toBe('Low priority');
  });

  it('links daily_plan.block_id for each placed task', async () => {
    const t = insertTask('Link me', 2, undefined, 30);
    stage(t, 0);
    sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, 0, 'deterministic')`).run(OWNER, DATE, t);

    await placeFlightPlan(OWNER, { date: DATE });

    const row = sqlite
      .prepare(`SELECT block_id FROM daily_plan WHERE owner_id = ? AND date = ? AND task_id = ?`)
      .get(OWNER, DATE, t) as { block_id: string | null };

    expect(row.block_id).not.toBeNull();

    // The block_id points to a real time_block for this task
    const block = sqlite
      .prepare(`SELECT task_id FROM time_blocks WHERE id = ?`)
      .get(row.block_id!) as { task_id: string } | undefined;
    expect(block?.task_id).toBe(t);
  });

  it('v1-regression guard: placed order survives a re-run (idempotent given same daily_plan)', async () => {
    // Ensure that if placeFlightPlan is called a second time with the same daily_plan,
    // the resulting block order is identical — the frozen order survives re-placement.
    const p1 = insertTask('First', 1, undefined, 30);
    const p3 = insertTask('Second', 3, undefined, 30);
    stage(p3, 0);
    stage(p1, 1);
    sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, 0, 'test')`).run(OWNER, DATE, p3);
    sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, 1, 'test')`).run(OWNER, DATE, p1);

    await placeFlightPlan(OWNER, { date: DATE });
    const firstOrder = (sqlite.prepare(`SELECT title FROM time_blocks WHERE is_auto = 1 AND block_kind = 'task' ORDER BY start_at`).all() as { title: string }[]).map(b => b.title);

    // Re-stage (as reflow would) and run again
    sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, p3);
    sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 1)`).run(OWNER, p1);

    await placeFlightPlan(OWNER, { date: DATE });
    const secondOrder = (sqlite.prepare(`SELECT title FROM time_blocks WHERE is_auto = 1 AND block_kind = 'task' ORDER BY start_at`).all() as { title: string }[]).map(b => b.title);

    expect(secondOrder).toEqual(firstOrder);
  });
});

describe('authorPlanOrder — LLM path (planning_mode = smart)', () => {
  it('writes source=llm or source=deterministic (never throws) when Ollama is available', async () => {
    if (!(await ollamaAvailable())) {
      // Skip — not a failure; loop.test.ts mocks cover the harness contract.
      return;
    }

    const p1 = insertTask('High', 1);
    const p2 = insertTask('Mid', 2);
    const p3 = insertTask('Low', 3);
    stage(p1, 0);
    stage(p2, 1);
    stage(p3, 2);

    sqlite.prepare(`UPDATE scheduling_prefs SET planning_mode = 'smart' WHERE owner_id = ?`).run(OWNER);
    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows();
    expect(rows).toHaveLength(3);
    expect(['llm', 'deterministic']).toContain(rows[0].source); // either is acceptable
    expect(rows.map(r => r.position)).toEqual([0, 1, 2]);

    // All tasks must be present exactly once
    const taskIds = new Set(rows.map(r => r.task_id));
    expect(taskIds.has(p1)).toBe(true);
    expect(taskIds.has(p2)).toBe(true);
    expect(taskIds.has(p3)).toBe(true);
  });
});
