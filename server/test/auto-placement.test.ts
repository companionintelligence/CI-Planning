import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placeFlightPlan, fillFlightPlanCandidates } from '../src/engine/autoplan.js';

/**
 * Auto placement priority (PR-C+, Workstream A): Plans-first, then a toggleable
 * workday fallback, on a shared "don't double-book" obstacle set.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertTask(title: string, est = 30, tag?: string, priority = 3): string {
  const id = (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, ?) RETURNING id`)
    .get(title, OWNER, est, priority) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id`).get(tag) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
function stage(taskId: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
async function makePlan(srv: TestServer, tag: string, start: string, end: string) {
  return (await api(srv.url, '/api/blocks', {
    method: 'POST',
    json: { title: `${tag} plan`, block_kind: 'timeblock', block_type: 'scheduled', tag, start_at: start, end_at: end },
  })).body.block;
}
const agentBlocks = () =>
  sqlite.prepare(`SELECT title, start_at, end_at, parent_block_id FROM time_blocks WHERE source_kind = 'agent' ORDER BY start_at`).all() as
    { title: string; start_at: string; end_at: string; parent_block_id: string | null }[];
const overlaps = (a: { start_at: string; end_at: string }, b: { start_at: string; end_at: string }) =>
  Date.parse(a.start_at) < Date.parse(b.end_at) && Date.parse(a.end_at) > Date.parse(b.start_at);

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 1 WHERE owner_id = ?`).run(OWNER);
});

describe('Plans-first placement', () => {
  it('places a tag-matched task INSIDE its Plan (as a grouped member)', async () => {
    const plan = await makePlan(srv, 'errands', at('14:00'), at('16:00'));
    const errand = insertTask('Post office', 30, 'errands');
    stage(errand);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBe(1);
    const blk = agentBlocks().find((b) => b.title === 'Post office')!;
    expect(blk.parent_block_id).toBe(plan.id);
    expect(blk.start_at >= at('14:00') && blk.end_at <= at('16:00')).toBe(true);
  });

  it('routes each task to the Plan whose tag it shares; untagged-by-plan tasks fall to the workday', async () => {
    const work = await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const errands = await makePlan(srv, 'errands', at('14:00'), at('16:00'));
    const t1 = insertTask('Write code', 60, 'work');
    const t2 = insertTask('Post office', 30, 'errands');
    const t3 = insertTask('Untagged thing', 30); // no plan tag → workday fallback
    [t1, t2, t3].forEach(stage);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placed).toBe(3);
    expect(r.placedInPlans).toBe(2);
    expect(r.placedInWorkday).toBe(1);
    const byTitle = Object.fromEntries(agentBlocks().map((b) => [b.title, b]));
    expect(byTitle['Write code'].parent_block_id).toBe(work.id);
    expect(byTitle['Post office'].parent_block_id).toBe(errands.id);
    expect(byTitle['Untagged thing'].parent_block_id).toBeNull();
  });

  it('higher-priority tag-matched task wins the earlier slot inside a Plan', async () => {
    await makePlan(srv, 'work', at('09:00'), at('11:00'));
    const low = insertTask('Low', 60, 'work', 5);
    const high = insertTask('High', 60, 'work', 1);
    stage(low); stage(high);

    placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks[0].title).toBe('High'); // earliest slot
    expect(blocks[1].title).toBe('Low');
  });
});

describe('no double-booking (shared obstacle set)', () => {
  it('does not stack on a manually-placed task block; workday fallback flows around it', () => {
    // a manual block 09:00–10:00 (source_kind manual, not agent → survives re-place)
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, status) VALUES (uuid7(), 'Manual', 'task', ?, ?, 0, 'manual', 'planned')`)
      .run(at('09:00'), at('10:00'));
    const t = insertTask('Auto task', 60);
    stage(t);

    placeFlightPlan(OWNER, { date: DAY });
    const auto = agentBlocks().find((b) => b.title === 'Auto task')!;
    expect(auto).toBeTruthy();
    expect(overlaps(auto, { start_at: at('09:00'), end_at: at('10:00') })).toBe(false); // around the manual block
  });

  it('two workday tasks never overlap each other', () => {
    const a = insertTask('A', 90);
    const b = insertTask('B', 90);
    stage(a); stage(b);
    placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(overlaps(blocks[0], blocks[1])).toBe(false);
  });

  it('workday fallback does not place inside a Plan window (Plans are reserved for their tag)', async () => {
    const plan = await makePlan(srv, 'errands', at('09:00'), at('17:00')); // a big plan covering most of the day
    const t = insertTask('Unrelated', 30); // not tagged errands
    stage(t);
    placeFlightPlan(OWNER, { date: DAY });
    const blk = agentBlocks().find((b) => b.title === 'Unrelated');
    // 09:00–17:00 is reserved; the only free workday time is 17:00–18:00.
    expect(blk).toBeTruthy();
    expect(blk!.start_at >= at('17:00')).toBe(true);
    expect(plan.id).toBeTruthy();
  });
});

describe('auto_fill_workday toggle', () => {
  it('OFF → tasks with no matching Plan are NOT placed (only Plans get filled)', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET auto_fill_workday = 0 WHERE owner_id = ?`).run(OWNER);
    await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const inPlan = insertTask('Coding', 30, 'work');
    const loose = insertTask('Loose', 30); // no plan tag
    stage(inPlan); stage(loose);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBe(1);
    expect(r.placedInWorkday).toBe(0);
    expect(r.unplaced).toBe(1); // 'Loose' had nowhere to go
    expect(agentBlocks().some((b) => b.title === 'Loose')).toBe(false);
  });

  it('ON (default) → the loose task lands in the workday', async () => {
    await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const loose = insertTask('Loose', 30);
    stage(loose);
    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInWorkday).toBe(1);
  });
});

describe('habit exclusion from flight-plan candidates', () => {
  // Regression: the exclusion filter read COALESCE(is_habit,0)=0; after 2B it reads
  // subtype IS NOT 'habit' so the canonical subtype drives the gate, not the alias.
  function insertWithSubtype(title: string, subtype: string, isHabit: 0 | 1): string {
    return (sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, subtype, is_habit)
         VALUES (uuid7(), ?, ?, 'open', 30, ?, ?) RETURNING id`,
      )
      .get(title, OWNER, subtype, isHabit) as { id: string }).id;
  }

  it("a habit task (subtype='habit') is not added as a candidate", () => {
    const standard = insertWithSubtype('Standard', 'standard', 0);
    const habit = insertWithSubtype('Habit', 'habit', 1);

    const added = fillFlightPlanCandidates(OWNER);

    expect(added).toBe(1);
    const staged = sqlite
      .prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`)
      .all(OWNER) as { task_id: string }[];
    expect(staged.some((r) => r.task_id === standard)).toBe(true);
    expect(staged.some((r) => r.task_id === habit)).toBe(false);
  });

  it('exclusion is driven by subtype, not the is_habit alias (coherence check)', () => {
    // subtype='habit' wins regardless of the boolean alias value.
    const subtypeHabitOnly = insertWithSubtype('SubtypeHabit', 'habit', 0); // alias disagrees
    const subtypeStandardOnly = insertWithSubtype('SubtypeStd', 'standard', 1); // alias disagrees

    const added = fillFlightPlanCandidates(OWNER);
    expect(added).toBe(1); // only the standard-subtype task staged

    const staged = sqlite
      .prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`)
      .all(OWNER) as { task_id: string }[];
    expect(staged.some((r) => r.task_id === subtypeHabitOnly)).toBe(false);   // excluded by subtype
    expect(staged.some((r) => r.task_id === subtypeStandardOnly)).toBe(true); // included by subtype
  });
});

describe('idempotent re-place', () => {
  it('re-running Auto clears prior agent blocks but preserves pattern + manual blocks', async () => {
    const plan = await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const t = insertTask('Coding', 30, 'work');
    stage(t);
    // a pattern-marked block + a manual block must survive a re-place
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, source_ref, status) VALUES (uuid7(), 'Routine task', 'task', ?, ?, 1, 'pattern', '999', 'planned')`)
      .run(at('13:00'), at('13:30'));
    sqlite.prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, status) VALUES (uuid7(), 'Manual', 'task', ?, ?, 0, 'manual', 'planned')`)
      .run(at('16:00'), at('16:30'));

    placeFlightPlan(OWNER, { date: DAY });
    placeFlightPlan(OWNER, { date: DAY }); // re-run
    const titles = (sqlite.prepare(`SELECT title FROM time_blocks WHERE block_kind = 'task'`).all() as { title: string }[]).map((t) => t.title);
    expect(titles.filter((t) => t === 'Coding').length).toBe(1); // not duplicated
    expect(titles).toContain('Routine task'); // pattern survived
    expect(titles).toContain('Manual');       // manual survived
    expect(plan.id).toBeTruthy();
  });
});
