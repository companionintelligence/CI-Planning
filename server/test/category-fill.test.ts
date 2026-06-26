import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { ensureRecurringBlocksForRange } from '../src/engine/blocks-recur.js';

/**
 * 0069 — the auto-scheduler fills a category Plan (a timeblock with category_id) with
 * tasks whose SECONDARY tag (entity_tags level>1) is in the category, excluding tasks
 * whose direction is opted out for that category. Deterministic; disjoint from tag-Plans.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function makeCategory(name: string): string {
  return (sqlite.prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (uuid7(), ?, 'category', 0) RETURNING id`).get(name) as { id: string }).id;
}
function tagId(name: string, kind: 'intention' | 'pattern'): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: string } | undefined;
  return found ? found.id : (sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), ?, ?) RETURNING id`).get(name, kind) as { id: string }).id;
}
function fileUnderCategory(intention: string, categoryId: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO tag_categories (intention_tag_id, category_tag_id) VALUES (?, ?)`).run(tagId(intention, 'intention'), categoryId);
}
function optOut(categoryId: string, direction: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO category_direction_optouts (category_tag_id, pattern_tag_id) VALUES (?, ?)`).run(categoryId, tagId(direction, 'pattern'));
}
/** A task with optional level-1 direction + level-2 secondary intention tags. */
function insertTask(title: string, opts: { direction?: string; secondary?: string[]; secondaryL1?: string[] } = {}): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', 30, 3) RETURNING id`).get(title, OWNER) as { id: string }).id;
  const link = sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`);
  if (opts.direction) link.run(id, tagId(opts.direction, 'pattern'), 1);
  for (const s of opts.secondary ?? []) link.run(id, tagId(s, 'intention'), 2);
  for (const s of opts.secondaryL1 ?? []) link.run(id, tagId(s, 'intention'), 1); // level 1 — should NOT match a category
  return id;
}
function stage(taskId: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);
}
async function makeCategoryPlan(srv: TestServer, categoryId: string, start: string, end: string) {
  return (await api(srv.url, '/api/blocks', {
    method: 'POST',
    json: { title: 'Category plan', block_kind: 'timeblock', block_type: 'scheduled', category_id: categoryId, start_at: start, end_at: end },
  })).body.block;
}
const childOf = (planId: string) =>
  sqlite.prepare(`SELECT title, start_at FROM time_blocks WHERE parent_block_id = ? AND source_kind = 'agent' ORDER BY start_at`).all(planId) as { title: string; start_at: string }[];

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM tag_categories; DELETE FROM category_direction_optouts;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 0 WHERE owner_id = ?`).run(OWNER);
});

describe('category-Plan fill (0069)', () => {
  it('fills a category Plan with a SECONDARY-tag match, not a level-1 match', async () => {
    const family = makeCategory('family');
    fileUnderCategory('kids', family);
    const match = insertTask('Plan birthday', { secondary: ['kids'] });          // level-2 'kids' → matches
    const nonMatch = insertTask('Has kids at L1', { secondaryL1: ['kids'] });     // level-1 'kids' → no match
    const unrelated = insertTask('Unrelated', { secondary: ['budget'] });         // not in category
    [match, nonMatch, unrelated].forEach(stage);
    const plan = await makeCategoryPlan(srv, family, at('14:00'), at('16:00'));

    const r = placeFlightPlan(OWNER, { date: DAY });
    const kids = childOf(plan.id);
    expect(kids.map((c) => c.title)).toEqual(['Plan birthday']);
    expect(r.placedInPlans).toBe(1);
  });

  it('excludes a task whose ONLY direction is opted out; keeps direction-less + enabled-direction tasks', async () => {
    const family = makeCategory('family');
    fileUnderCategory('kids', family);
    optOut(family, 'work'); // Family Time does not pull Work-direction tasks
    const workTask = insertTask('Work kids thing', { direction: 'work', secondary: ['kids'] });   // excluded
    const homeTask = insertTask('Home kids thing', { direction: 'home', secondary: ['kids'] });   // kept
    const looseTask = insertTask('Loose kids thing', { secondary: ['kids'] });                    // kept (no direction)
    [workTask, homeTask, looseTask].forEach(stage);
    const plan = await makeCategoryPlan(srv, family, at('09:00'), at('17:00'));

    placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id).map((c) => c.title).sort()).toEqual(['Home kids thing', 'Loose kids thing']);
  });

  it('is deterministic — a re-stage + re-run reproduces identical placement', async () => {
    const family = makeCategory('family');
    fileUnderCategory('kids', family);
    const ids = [insertTask('A', { secondary: ['kids'] }), insertTask('B', { secondary: ['kids'] }), insertTask('C', { secondary: ['kids'] })];
    ids.forEach(stage);
    const plan = await makeCategoryPlan(srv, family, at('09:00'), at('17:00'));

    placeFlightPlan(OWNER, { date: DAY });
    const first = childOf(plan.id);
    ids.forEach(stage); // placed tasks were de-staged; re-stage to replay
    placeFlightPlan(OWNER, { date: DAY }); // clearPriorAuto wipes the prior run, then re-places
    expect(childOf(plan.id)).toEqual(first); // same titles, same start times
  });

  it('a category Plan and a tag Plan are filled by disjoint axes (no double-fill)', async () => {
    const family = makeCategory('family');
    fileUnderCategory('kids', family);
    const catPlan = await makeCategoryPlan(srv, family, at('09:00'), at('11:00'));
    const tagPlan = (await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'Work', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('13:00'), end_at: at('15:00') } })).body.block;
    const catTask = insertTask('Kids', { secondary: ['kids'] });
    const tagTask = insertTask('Code', { direction: 'work' }); // level-1 'work' tag matches the tag Plan
    [catTask, tagTask].forEach(stage);

    placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(catPlan.id).map((c) => c.title)).toEqual(['Kids']);
    // the category task must NOT also land in the tag Plan, and vice-versa
    expect(childOf(tagPlan.id).map((c) => c.title)).not.toContain('Kids');
  });

  it('recurrence: a recurring category template propagates category_id + frozen color_token to instances', async () => {
    const family = makeCategory('family');
    await api(srv.url, `/api/category-prefs/${family}`, { method: 'PUT', json: { color_token: 'chart-1' } });
    // A future recurring category template (no backfill for past days).
    const future = '2099-03-02'; // a Monday
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: {
        title: 'Family evening', block_kind: 'timeblock', block_type: 'scheduled', category_id: family,
        start_at: `${future}T18:00:00.000Z`, end_at: `${future}T19:00:00.000Z`, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      },
    });
    ensureRecurringBlocksForRange(OWNER, `${future}T00:00:00.000Z`, `2099-03-09T00:00:00.000Z`);
    const inst = sqlite
      .prepare(`SELECT category_id, color_token FROM time_blocks WHERE recurrence_parent_id IS NOT NULL AND category_id IS NOT NULL`)
      .get() as { category_id: string; color_token: string } | undefined;
    expect(inst?.category_id).toBe(family);
    expect(inst?.color_token).toBe('chart-1'); // frozen stamp copied verbatim
  });
});
