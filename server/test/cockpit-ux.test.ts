import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer, seedFallbackFillWindow } from './helpers.js';
import { fillFlightPlanCandidates, placeFlightPlan, undoLastAuto } from '../src/engine/autoplan.js';

/**
 * Cockpit UX redesign (Wave 3): explicit Fill / Auto Schedule split, Priority /
 * Over-Due toggle, auto_fill_workday gate, draggable auto blocks, Undo coverage.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertTask(title: string, est = 30, opts: { tag?: string; priority?: number; dueAt?: string } = {}): string {
  const id = (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority, due_at) VALUES (uuid7(), ?, ?, 'open', ?, ?, ?) RETURNING id`)
    .get(title, OWNER, est, opts.priority ?? 3, opts.dueAt ?? null) as { id: string }).id;
  if (opts.tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(opts.tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?) RETURNING id`).get(opts.tag, OWNER) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
function stage(taskId: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
const agentBlocks = () =>
  sqlite.prepare(`SELECT id, title, start_at, end_at, auto_run_id, is_auto FROM time_blocks WHERE source_kind = 'agent' ORDER BY start_at`).all() as
    { id: string; title: string; start_at: string; end_at: string; auto_run_id: string | null; is_auto: number }[];
const flightPlanRows = () =>
  sqlite.prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`).all(OWNER) as { task_id: string }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  seedFallbackFillWindow(); // 0156: Auto's fallback fill needs work/community windows
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', auto_fill_workday = 1, fill_order = 'priority' WHERE owner_id = ?`).run(OWNER);
});

// ── 1. Fill Flight Plan only fills, never places ──────────────────────────────
describe('Fill Flight Plan', () => {
  it('proposes candidates into the flight-plan without creating any time blocks', async () => {
    insertTask('Task A'); insertTask('Task B');

    const added = await fillFlightPlanCandidates(OWNER);

    expect(added).toBe(2);
    const inFp = flightPlanRows();
    expect(inFp.length).toBe(2);
    const blocks = sqlite.prepare(`SELECT * FROM time_blocks WHERE block_kind = 'task'`).all();
    expect(blocks.length).toBe(0); // no blocks created
  });

  it('fill via POST /api/auto/fill never places blocks', async () => {
    insertTask('Via API');
    const r = await api(srv.url, '/api/auto/fill', { method: 'POST', json: {} });
    expect(r.status).toBe(200);
    expect(r.body.result.step).toBe('fill');
    expect(r.body.result.candidatesAdded).toBe(1);
    const blocks = sqlite.prepare(`SELECT * FROM time_blocks WHERE block_kind = 'task'`).all();
    expect(blocks.length).toBe(0);
  });
});

// ── 2. Auto Schedule places + workday fill ────────────────────────────────────
describe('Auto Schedule', () => {
  it('places staged tasks tag-matched first, then fills workday with leftover', async () => {
    // A tagged Plan 09:00–12:00
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Work Plan', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('09:00'), end_at: at('12:00') },
    });
    const inPlan = insertTask('Coding', 30, { tag: 'work' });
    const loose  = insertTask('Loose',  30);
    stage(inPlan); stage(loose);

    const r = await placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBe(1);
    expect(r.placedInWorkday).toBe(1);
    expect(r.placed).toBe(2);
    // Both tasks removed from flight-plan
    expect(flightPlanRows().length).toBe(0);
  });

  it('via POST /api/auto/run always places (never fills)', async () => {
    insertTask('Solo');
    stage(insertTask('Staged', 30));

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: DAY } });
    expect(r.status).toBe(200);
    expect(r.body.result.step).toBe('place');
  });
});

// ── 3. Priority / Over-Due toggle ─────────────────────────────────────────────
describe('fill_order toggle', () => {
  it('priority → P1 placed first into earliest workday slot', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'priority' WHERE owner_id = ?`).run(OWNER);
    const lo = insertTask('Low',  60, { priority: 5 });
    const hi = insertTask('High', 60, { priority: 1 });
    stage(lo); stage(hi);

    await placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(blocks[0].title).toBe('High'); // P1 → earliest slot
  });

  it('overdue → most-overdue task placed first (due_at ASC)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
    const newer = insertTask('Newer due', 60, { dueAt: '2026-06-20T00:00:00.000Z' });
    const older = insertTask('Older due', 60, { dueAt: '2026-06-01T00:00:00.000Z' });
    stage(newer); stage(older);

    await placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(blocks[0].title).toBe('Older due'); // oldest due_at → earliest slot
  });

  // fill_order='new_today' — tasks that arrived on the owner's REAL today take the
  // earliest slots. `created_at` is forced via SQL because the column is defaulted by
  // CURRENT_TIMESTAMP; the helper leaves it as "now", which IS today.
  const backdate = (taskId: string, days: number) =>
    sqlite
      .prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - days * 86_400_000).toISOString(), taskId);

  it('new_today → a task created today beats an older task with an earlier due date', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'new_today' WHERE owner_id = ?`).run(OWNER);
    // The old task is MORE overdue, so under 'overdue' it would win the earliest slot —
    // which is exactly what makes this assertion prove the new band is doing the work.
    const old = insertTask('Old but overdue', 60, { dueAt: '2026-06-01T00:00:00.000Z' });
    backdate(old, 10);
    const fresh = insertTask('Arrived today', 60, { dueAt: '2026-12-31T00:00:00.000Z' });
    stage(old); stage(fresh);

    await placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(blocks[0].title).toBe('Arrived today');
    expect(blocks[1].title).toBe('Old but overdue');
  });

  it('new_today keeps each half deadline-first (it layers on overdue, not replaces it)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'new_today' WHERE owner_id = ?`).run(OWNER);
    const freshLate = insertTask('Today late-due', 30, { dueAt: '2026-12-31T00:00:00.000Z' });
    const freshSoon = insertTask('Today soon-due', 30, { dueAt: '2026-06-05T00:00:00.000Z' });
    const oldSoon = insertTask('Old soon-due', 30, { dueAt: '2026-06-02T00:00:00.000Z' });
    backdate(oldSoon, 5);
    stage(freshLate); stage(freshSoon); stage(oldSoon);

    await placeFlightPlan(OWNER, { date: DAY });
    // Both of today's arrivals lead, ordered by due date between themselves; the older
    // task follows despite having the earliest due date of all three.
    expect(agentBlocks().map((b) => b.title)).toEqual(['Today soon-due', 'Today late-due', 'Old soon-due']);
  });

  it('new_today with nothing created today degrades to plain deadline-first', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'new_today' WHERE owner_id = ?`).run(OWNER);
    const newer = insertTask('Newer due', 60, { dueAt: '2026-06-20T00:00:00.000Z' });
    const older = insertTask('Older due', 60, { dueAt: '2026-06-01T00:00:00.000Z' });
    backdate(newer, 3); backdate(older, 3);
    stage(newer); stage(older);

    await placeFlightPlan(OWNER, { date: DAY });
    expect(agentBlocks().map((b) => b.title)).toEqual(['Older due', 'Newer due']);
  });

  it('new_today reads the zone-less CURRENT_TIMESTAMP spelling as UTC, not local', async () => {
    // The stored default spelling ('YYYY-MM-DD HH:MM:SS', UTC, no zone marker) must be
    // recognised as today. Parsed as LOCAL it shifts by the server offset and an
    // evening-created task would fall out of its own day.
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'new_today' WHERE owner_id = ?`).run(OWNER);
    const fresh = insertTask('Arrived today', 60, { dueAt: '2026-12-31T00:00:00.000Z' });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19); // UTC, no zone
    sqlite.prepare(`UPDATE tasks SET created_at = ? WHERE id = ?`).run(stamp, fresh);
    const old = insertTask('Old but overdue', 60, { dueAt: '2026-06-01T00:00:00.000Z' });
    backdate(old, 10);
    stage(old); stage(fresh);

    await placeFlightPlan(OWNER, { date: DAY });
    expect(agentBlocks()[0].title).toBe('Arrived today');
  });

  it('overdue with no overdue tasks does not throw, places undated tasks last', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
    const a = insertTask('No due A', 30, { priority: 1 });
    const b = insertTask('No due B', 30, { priority: 3 });
    stage(a); stage(b);

    // `expect(() => f()).not.toThrow()` passes vacuously once f is async.
    await expect(placeFlightPlan(OWNER, { date: DAY })).resolves.toBeDefined();
    expect(agentBlocks().length).toBe(2);
  });

  it('undated tasks come after dated tasks in overdue order', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
    const dated   = insertTask('Dated',   30, { dueAt: '2026-06-10T00:00:00.000Z' });
    const undated = insertTask('Undated', 30);
    stage(undated); stage(dated);

    await placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks[0].title).toBe('Dated');
    expect(blocks[1].title).toBe('Undated');
  });
});

// ── 4. Per-direction fill setting ─────────────────────────────────────────────
describe('per-direction fill gate', () => {
  it('fill off for one direction stops its tasks from being placed; others unaffected', async () => {
    // Create two direction-tagged tasks; turn off auto_fill for 'work' direction.
    // 0156: the beforeEach's seedFallbackFillWindow() already owns the 'work' tag name
    // (UNIQUE(owner_id, name)) — reuse it instead of inserting a second row, and
    // clear its pre-seeded fallback-fill window so only this test's own range applies.
    const workTag = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'work'`).get(OWNER) as { id: string }).id;
    sqlite.prepare(`DELETE FROM pattern_blocks WHERE owner_id = ? AND direction_tag_id = ?`).run(OWNER, workTag);
    const homeTag = (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'home', 'direction', ?) RETURNING id`).get(OWNER) as { id: string }).id;
    // Pattern prefs: work fill = off, home fill = on
    sqlite.prepare(`INSERT OR REPLACE INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill) VALUES (uuid7(), ?, ?, 'direction', 0)`).run(OWNER, workTag);
    sqlite.prepare(`INSERT OR REPLACE INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill) VALUES (uuid7(), ?, ?, 'direction', 1)`).run(OWNER, homeTag);
    // Pattern blocks (windows) for both directions
    const makeRange = (tagId: string) =>
      sqlite.prepare(`INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time) VALUES (uuid7(), ?, ?, 'workday', '13:00', '17:00')`).run(OWNER, tagId);
    makeRange(workTag); makeRange(homeTag);

    const workTask = insertTask('Work task', 60, { tag: 'work' });
    const homeTask = insertTask('Home task', 60, { tag: 'home' });
    stage(workTask); stage(homeTask);

    await placeFlightPlan(OWNER, { date: DAY });
    const titles = agentBlocks().map((b) => b.title);
    expect(titles).not.toContain('Work task');  // fill off for work
    expect(titles).toContain('Home task');       // home still fills
  });
});

// ── 5. Undo reverts both Plan-placed and workday-placed blocks ─────────────────
describe('Undo', () => {
  it('reverts all blocks from the last run (Plans + workday fill share one run_id)', async () => {
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Work Plan', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('09:00'), end_at: at('12:00') },
    });
    const inPlan = insertTask('Coding', 30, { tag: 'work' });
    const loose  = insertTask('Loose',  30);
    stage(inPlan); stage(loose);

    await placeFlightPlan(OWNER, { date: DAY });
    expect(agentBlocks().length).toBe(2); // both placed

    const result = await undoLastAuto(OWNER);
    expect(result.removed).toBe(2);   // both blocks removed
    expect(result.restaged).toBe(2);  // both tasks re-staged
    expect(agentBlocks().length).toBe(0);
    expect(flightPlanRows().length).toBe(2);
  });

  it('undo is a no-op on a second call (single-step, no stack)', async () => {
    const t = insertTask('Task', 30);
    stage(t);
    await placeFlightPlan(OWNER, { date: DAY });
    await undoLastAuto(OWNER); // first undo
    const r = await undoLastAuto(OWNER); // second undo → no-op
    expect(r.removed).toBe(0);
    expect(r.restaged).toBe(0);
  });
});

// ── 6. No-overlap: workday fill flows around existing blocks ───────────────────
describe('no overlap on workday fill', () => {
  it('does not stack on a manual block', async () => {
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Manual', 'task', ?, ?, 0, 'manual', 'planned', ?)`)
      .run(at('09:00'), at('12:00'), OWNER);
    const t = insertTask('Auto task', 60);
    stage(t);
    await placeFlightPlan(OWNER, { date: DAY });
    const auto = agentBlocks().find((b) => b.title === 'Auto task')!;
    expect(auto).toBeTruthy();
    // Must start at or after 12:00 (clear of the manual block)
    expect(Date.parse(auto.start_at) >= Date.parse(at('12:00'))).toBe(true);
  });

  it('re-run is idempotent (prior auto blocks cleared, result same)', async () => {
    const t = insertTask('Task', 30);
    stage(t);
    await placeFlightPlan(OWNER, { date: DAY });
    stage(t); // re-stage (undo-less re-run scenario)
    await placeFlightPlan(OWNER, { date: DAY });
    const titles = agentBlocks().map((b) => b.title);
    expect(titles.filter((x) => x === 'Task').length).toBeLessThanOrEqual(1);
  });
});

// ── 7. Draggable auto blocks: is_auto cleared on timing PATCH ────────────────
describe('auto block drag (global constraint)', () => {
  it('PATCH start_at on an auto block sets is_auto=false so it survives clearPriorAuto', async () => {
    const t = insertTask('Dragged', 30);
    stage(t);
    await placeFlightPlan(OWNER, { date: DAY });
    const autoBlock = agentBlocks()[0];
    expect(autoBlock).toBeTruthy();
    expect(autoBlock.is_auto).toBe(1);

    // Simulate a drag: PATCH the block's timing
    const newStart = at('15:00');
    const newEnd   = at('15:30');
    const r = await api(srv.url, `/api/blocks/${autoBlock.id}`, {
      method: 'PATCH',
      json: { start_at: newStart, end_at: newEnd },
    });
    expect(r.status).toBe(200);

    const updated = sqlite.prepare(`SELECT is_auto FROM time_blocks WHERE id = ?`).get(autoBlock.id) as { is_auto: number };
    expect(updated.is_auto).toBe(0); // promoted to manual — survives next Auto run
  });

  it('non-timing PATCH (e.g. title) does not clear is_auto', async () => {
    const t = insertTask('Keep auto', 30);
    stage(t);
    await placeFlightPlan(OWNER, { date: DAY });
    const autoBlock = agentBlocks()[0];

    await api(srv.url, `/api/blocks/${autoBlock.id}`, { method: 'PATCH', json: { title: 'Renamed' } });
    const updated = sqlite.prepare(`SELECT is_auto FROM time_blocks WHERE id = ?`).get(autoBlock.id) as { is_auto: number };
    expect(updated.is_auto).toBe(1); // unchanged
  });
});
