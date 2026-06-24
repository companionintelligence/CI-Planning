import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placeFlightPlan, fillByPriority, fillFlightPlanCandidates } from '../src/engine/autoplan.js';

/**
 * Auto placement priority (PR-C+, Workstream A; D5 split): placeFlightPlan does
 * tag-matched placement (Plans + direction windows) only — leftover capacity stays
 * open. fillByPriority is the explicit priority top-up that fills the workday window
 * P1-first, around everything already placed. Shared "don't double-book" obstacle set.
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

  it('routes each task to the Plan whose tag it shares; tap 2 leaves untagged-by-plan tasks open until the priority tap', async () => {
    const work = await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const errands = await makePlan(srv, 'errands', at('14:00'), at('16:00'));
    const t1 = insertTask('Write code', 60, 'work');
    const t2 = insertTask('Post office', 30, 'errands');
    const t3 = insertTask('Untagged thing', 30); // no plan tag → stays open at tap 2
    [t1, t2, t3].forEach(stage);

    // Tap 2: only the tag-matched tasks land (in their Plans). The untagged one is left open.
    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placed).toBe(2);
    expect(r.placedInPlans).toBe(2);
    expect(agentBlocks().some((b) => b.title === 'Untagged thing')).toBe(false);

    // Tap 3 (explicit): the priority top-up fills the untagged one into the workday.
    const pr = fillByPriority(OWNER, { date: DAY });
    expect(pr.placedInWorkday).toBe(1);
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

    fillByPriority(OWNER, { date: DAY });
    const auto = agentBlocks().find((b) => b.title === 'Auto task')!;
    expect(auto).toBeTruthy();
    expect(overlaps(auto, { start_at: at('09:00'), end_at: at('10:00') })).toBe(false); // around the manual block
  });

  it('two workday tasks never overlap each other', () => {
    const a = insertTask('A', 90);
    const b = insertTask('B', 90);
    stage(a); stage(b);
    fillByPriority(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks.length).toBe(2);
    expect(overlaps(blocks[0], blocks[1])).toBe(false);
  });

  it('priority fill does not place inside a Plan window (Plans are reserved for their tag)', async () => {
    const plan = await makePlan(srv, 'errands', at('09:00'), at('17:00')); // a big plan covering most of the day
    const t = insertTask('Unrelated', 30); // not tagged errands
    stage(t);
    fillByPriority(OWNER, { date: DAY });
    const blk = agentBlocks().find((b) => b.title === 'Unrelated');
    // 09:00–17:00 is reserved; the only free workday time is 17:00–18:00.
    expect(blk).toBeTruthy();
    expect(blk!.start_at >= at('17:00')).toBe(true);
    expect(plan.id).toBeTruthy();
  });
});

describe('priority fill (tap 3) + auto_fill_workday gate', () => {
  it('tap 2 never auto-fills leftover capacity by priority (D5)', async () => {
    await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const inPlan = insertTask('Coding', 30, 'work');
    const loose = insertTask('Loose', 30); // no plan tag
    stage(inPlan); stage(loose);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBe(1);
    expect(r.placedInWorkday).toBe(0); // tag-matched only
    expect(agentBlocks().some((b) => b.title === 'Loose')).toBe(false); // left open
  });

  it('priority fill OFF (auto_fill_workday=0) → a no-op even on an explicit tap', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET auto_fill_workday = 0 WHERE owner_id = ?`).run(OWNER);
    await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const inPlan = insertTask('Coding', 30, 'work');
    const loose = insertTask('Loose', 30);
    stage(inPlan); stage(loose);

    placeFlightPlan(OWNER, { date: DAY }); // Coding → work Plan
    const pr = fillByPriority(OWNER, { date: DAY });
    expect(pr.placedInWorkday).toBe(0);
    expect(agentBlocks().some((b) => b.title === 'Loose')).toBe(false);
  });

  it('priority fill ON → the loose task lands in the workday, P1 first', async () => {
    await makePlan(srv, 'work', at('09:00'), at('12:00'));
    const lo = insertTask('Low', 60, undefined, 5);
    const hi = insertTask('High', 60, undefined, 1);
    stage(lo); stage(hi);

    placeFlightPlan(OWNER, { date: DAY }); // nothing tag-matched
    const pr = fillByPriority(OWNER, { date: DAY });
    expect(pr.placedInWorkday).toBe(2);
    const blocks = agentBlocks();
    expect(blocks[0].title).toBe('High'); // highest priority gets the earliest slot
  });
});

describe('habit exclusion from flight-plan candidates', () => {
  function insertWithSubtype(title: string, subtype: string): string {
    return (sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, subtype)
         VALUES (uuid7(), ?, ?, 'open', 30, ?) RETURNING id`,
      )
      .get(title, OWNER, subtype) as { id: string }).id;
  }

  it("a habit task (subtype='habit') is not added as a candidate", () => {
    const standard = insertWithSubtype('Standard', 'standard');
    const habit = insertWithSubtype('Habit', 'habit');

    const added = fillFlightPlanCandidates(OWNER);

    expect(added).toBe(1);
    const staged = sqlite
      .prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`)
      .all(OWNER) as { task_id: string }[];
    expect(staged.some((r) => r.task_id === standard)).toBe(true);
    expect(staged.some((r) => r.task_id === habit)).toBe(false);
  });

  it('exclusion is driven by subtype alone (columns dropped in 0048)', () => {
    const habitTask = insertWithSubtype('Habit', 'habit');
    const standardTask = insertWithSubtype('Standard', 'standard');

    const added = fillFlightPlanCandidates(OWNER);
    expect(added).toBe(1);

    const staged = sqlite
      .prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`)
      .all(OWNER) as { task_id: string }[];
    expect(staged.some((r) => r.task_id === habitTask)).toBe(false);
    expect(staged.some((r) => r.task_id === standardTask)).toBe(true);
  });
});

describe('catch-all Plan (Community pattern type)', () => {
  function makeCommunityPlan(start: string, end: string) {
    return (sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status)
         VALUES (uuid7(), 'Community', 'timeblock', 'scheduled', 'Community', ?, ?, 0, 'manual', 'planned') RETURNING id`,
      )
      .get(start, end) as { id: string }).id;
  }

  it('accepts every staged task regardless of tag, placed in priority order', async () => {
    makeCommunityPlan(at('10:00'), at('14:00'));
    const tagged = insertTask('Work task', 60, 'work', 3);
    const untagged = insertTask('Untagged task', 60, undefined, 2);
    const otherTag = insertTask('Errands task', 60, 'errands', 1);
    stage(tagged); stage(untagged); stage(otherTag);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBeGreaterThanOrEqual(2); // at least some placed
    const titles = agentBlocks().map((b) => b.title);
    // All three should land — Community accepts any tag (or no tag).
    expect(titles).toContain('Work task');
    expect(titles).toContain('Untagged task');
    expect(titles).toContain('Errands task');
  });

  it('priority order: P1 gets the earliest slot inside a catch-all Plan', () => {
    makeCommunityPlan(at('09:00'), at('12:00'));
    const lo = insertTask('Low', 60, undefined, 5);
    const hi = insertTask('High', 60, undefined, 1);
    stage(lo); stage(hi);

    placeFlightPlan(OWNER, { date: DAY });
    const blocks = agentBlocks();
    expect(blocks[0].title).toBe('High');
    expect(blocks[1].title).toBe('Low');
  });

  it('a non-catch-all Plan (e.g. errands) still filters by tag', async () => {
    makeCommunityPlan(at('10:00'), at('12:00'));
    await makePlan(srv, 'errands', at('14:00'), at('16:00'));
    const work = insertTask('Work task', 30, 'work');
    const errand = insertTask('Errand task', 30, 'errands');
    stage(work); stage(errand);

    placeFlightPlan(OWNER, { date: DAY });
    const comBlocks = agentBlocks().filter((b) => b.start_at >= at('10:00') && b.end_at <= at('12:00'));
    const errBlocks = agentBlocks().filter((b) => b.start_at >= at('14:00') && b.end_at <= at('16:00'));
    // Errands (non-catch-all) runs first, picks the errand-tagged task.
    // Community (catch-all) runs after, absorbs whatever remains.
    expect(comBlocks.length).toBeGreaterThanOrEqual(1);
    expect(errBlocks.map((b) => b.title)).toContain('Errand task');
    expect(errBlocks.map((b) => b.title)).not.toContain('Work task');
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

    placeFlightPlan(OWNER, { date: DAY }); // first run: places 'Coding', removes it from flight plan (item 5)
    placeFlightPlan(OWNER, { date: DAY }); // second run: clearPriorAuto removes the prior block; not re-placed (de-staged)
    const titles = (sqlite.prepare(`SELECT title FROM time_blocks WHERE block_kind = 'task'`).all() as { title: string }[]).map((t) => t.title);
    expect(titles.filter((t) => t === 'Coding').length).toBe(0); // cleared on second run; never duplicated
    expect(titles).toContain('Routine task'); // pattern survived
    expect(titles).toContain('Manual');       // manual survived
    expect(plan.id).toBeTruthy();
  });
});
