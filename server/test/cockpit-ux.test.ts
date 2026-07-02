import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
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
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 1, fill_order = 'priority' WHERE owner_id = ?`).run(OWNER);
});

// ── 1. Fill Flight Plan only fills, never places ──────────────────────────────
describe('Fill Flight Plan', () => {
  it('proposes candidates into the flight-plan without creating any time blocks', () => {
    insertTask('Task A'); insertTask('Task B');

    const added = fillFlightPlanCandidates(OWNER);

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

    const r = placeFlightPlan(OWNER, { date: DAY });
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
  it('priority → P1 placed first into earliest workday slot', () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'priority' WHERE owner_id = ?`).run(OWNER);
    const lo = insertTask('Low',  60, { priority: 5 });
    const hi = insertTask('High', 60, { priority: 1 });
    stage(lo); stage(hi);

    placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(blocks[0].title).toBe('High'); // P1 → earliest slot
  });

  it('overdue → most-overdue task placed first (due_at ASC)', () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
    const newer = insertTask('Newer due', 60, { dueAt: '2026-06-20T00:00:00.000Z' });
    const older = insertTask('Older due', 60, { dueAt: '2026-06-01T00:00:00.000Z' });
    stage(newer); stage(older);

    placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(blocks[0].title).toBe('Older due'); // oldest due_at → earliest slot
  });

  it('overdue with no overdue tasks does not throw, places undated tasks last', () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
    const a = insertTask('No due A', 30, { priority: 1 });
    const b = insertTask('No due B', 30, { priority: 3 });
    stage(a); stage(b);

    expect(() => placeFlightPlan(OWNER, { date: DAY })).not.toThrow();
    expect(agentBlocks().length).toBe(2);
  });

  it('undated tasks come after dated tasks in overdue order', () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE owner_id = ?`).run(OWNER);
    const dated   = insertTask('Dated',   30, { dueAt: '2026-06-10T00:00:00.000Z' });
    const undated = insertTask('Undated', 30);
    stage(undated); stage(dated);

    placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks[0].title).toBe('Dated');
    expect(blocks[1].title).toBe('Undated');
  });
});

// ── 4. Per-direction fill setting ─────────────────────────────────────────────
describe('per-direction fill gate', () => {
  it('fill off for one direction stops its tasks from being placed; others unaffected', async () => {
    // Create two direction-tagged tasks; turn off auto_fill for 'work' direction
    const workTag = (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'work', 'pattern', ?) RETURNING id`).get(OWNER) as { id: string }).id;
    const homeTag = (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'home', 'pattern', ?) RETURNING id`).get(OWNER) as { id: string }).id;
    // Pattern prefs: work fill = off, home fill = on
    sqlite.prepare(`INSERT OR REPLACE INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill) VALUES (uuid7(), ?, ?, 'pattern', 0)`).run(OWNER, workTag);
    sqlite.prepare(`INSERT OR REPLACE INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill) VALUES (uuid7(), ?, ?, 'pattern', 1)`).run(OWNER, homeTag);
    // Pattern blocks (windows) for both directions
    const makeRange = (tagId: string) =>
      sqlite.prepare(`INSERT INTO pattern_blocks (id, owner_id, pattern_tag_id, day_type, start_time, end_time) VALUES (uuid7(), ?, ?, 'workday', '13:00', '17:00')`).run(OWNER, tagId);
    makeRange(workTag); makeRange(homeTag);

    const workTask = insertTask('Work task', 60, { tag: 'work' });
    const homeTask = insertTask('Home task', 60, { tag: 'home' });
    stage(workTask); stage(homeTask);

    placeFlightPlan(OWNER, { date: DAY });
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

    placeFlightPlan(OWNER, { date: DAY });
    expect(agentBlocks().length).toBe(2); // both placed

    const result = undoLastAuto(OWNER);
    expect(result.removed).toBe(2);   // both blocks removed
    expect(result.restaged).toBe(2);  // both tasks re-staged
    expect(agentBlocks().length).toBe(0);
    expect(flightPlanRows().length).toBe(2);
  });

  it('undo is a no-op on a second call (single-step, no stack)', () => {
    const t = insertTask('Task', 30);
    stage(t);
    placeFlightPlan(OWNER, { date: DAY });
    undoLastAuto(OWNER); // first undo
    const r = undoLastAuto(OWNER); // second undo → no-op
    expect(r.removed).toBe(0);
    expect(r.restaged).toBe(0);
  });
});

// ── 6. No-overlap: workday fill flows around existing blocks ───────────────────
describe('no overlap on workday fill', () => {
  it('does not stack on a manual block', () => {
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, status, owner_id) VALUES (uuid7(), 'Manual', 'task', ?, ?, 0, 'manual', 'planned', ?)`)
      .run(at('09:00'), at('12:00'), OWNER);
    const t = insertTask('Auto task', 60);
    stage(t);
    placeFlightPlan(OWNER, { date: DAY });
    const auto = agentBlocks().find((b) => b.title === 'Auto task')!;
    expect(auto).toBeTruthy();
    // Must start at or after 12:00 (clear of the manual block)
    expect(Date.parse(auto.start_at) >= Date.parse(at('12:00'))).toBe(true);
  });

  it('re-run is idempotent (prior auto blocks cleared, result same)', () => {
    const t = insertTask('Task', 30);
    stage(t);
    placeFlightPlan(OWNER, { date: DAY });
    stage(t); // re-stage (undo-less re-run scenario)
    placeFlightPlan(OWNER, { date: DAY });
    const titles = agentBlocks().map((b) => b.title);
    expect(titles.filter((x) => x === 'Task').length).toBeLessThanOrEqual(1);
  });
});

// ── 7. Draggable auto blocks: is_auto cleared on timing PATCH ────────────────
describe('auto block drag (global constraint)', () => {
  it('PATCH start_at on an auto block sets is_auto=false so it survives clearPriorAuto', async () => {
    const t = insertTask('Dragged', 30);
    stage(t);
    placeFlightPlan(OWNER, { date: DAY });
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
    placeFlightPlan(OWNER, { date: DAY });
    const autoBlock = agentBlocks()[0];

    await api(srv.url, `/api/blocks/${autoBlock.id}`, { method: 'PATCH', json: { title: 'Renamed' } });
    const updated = sqlite.prepare(`SELECT is_auto FROM time_blocks WHERE id = ?`).get(autoBlock.id) as { is_auto: number };
    expect(updated.is_auto).toBe(1); // unchanged
  });
});
