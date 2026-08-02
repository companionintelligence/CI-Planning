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
  return (sqlite.prepare(`INSERT INTO tags (id, name, kind, is_base, owner_id) VALUES (uuid7(), ?, 'category', 0, ?) RETURNING id`).get(name, OWNER) as { id: string }).id;
}
function tagId(name: string, kind: 'intention' | 'direction'): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as { id: string } | undefined;
  return found ? found.id : (sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(name, kind, OWNER) as { id: string }).id;
}
function fileUnderCategory(intention: string, categoryId: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO tag_categories (intention_tag_id, category_tag_id) VALUES (?, ?)`).run(tagId(intention, 'intention'), categoryId);
}
function optOut(categoryId: string, direction: string) {
  sqlite.prepare(`INSERT OR IGNORE INTO category_direction_optouts (category_tag_id, direction_tag_id) VALUES (?, ?)`).run(categoryId, tagId(direction, 'direction'));
}
/** A task with optional level-1 direction + level-2 secondary intention tags. */
function insertTask(title: string, opts: { direction?: string; secondary?: string[]; secondaryL1?: string[] } = {}): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', 30, 3) RETURNING id`).get(title, OWNER) as { id: string }).id;
  const link = sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`);
  if (opts.direction) link.run(id, tagId(opts.direction, 'direction'), 1);
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

    const r = await placeFlightPlan(OWNER, { date: DAY });
    const kids = childOf(plan.id);
    expect(kids.map((c) => c.title)).toEqual(['Plan birthday']);
    expect(r.placedInPlans).toBe(1);
  });

  // ── Phase B route: the task carries the category directly (entity_categories) ──────
  // The block's category has always come from entity_categories, but candidates were
  // matched ONLY through the 0069 intention→tag_categories grouping. So a task tagged
  // via the wizard's 1–3 category picker (or the quick-add classifier) was never placed
  // into a matching category block — the picker looked wired and did nothing.

  /** Tag a task with a category the way the picker/classifier does (Phase B, 0134). */
  function pickCategory(taskId: string, categoryId: string, position = 0) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, ?)`)
      .run(taskId, categoryId, position);
  }

  it('fills a category Plan from the task\'s OWN categories (entity_categories), with no intention grouping at all', async () => {
    // Regression: this is the exact reported gap. `tag_categories` is left empty, so the
    // only possible match is the direct one — before the fix nothing was placed.
    const relationships = makeCategory('relationships');
    const match = insertTask('Call Mum');
    pickCategory(match, relationships);
    const unrelated = insertTask('Unrelated');
    [match, unrelated].forEach(stage);
    const plan = await makeCategoryPlan(srv, relationships, at('14:00'), at('16:00'));

    const r = await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id).map((c) => c.title)).toEqual(['Call Mum']);
    expect(r.placedInPlans).toBe(1);
  });

  it('matches a task carrying the category at a non-zero position (1–3 picker, not just the first)', async () => {
    const relationships = makeCategory('relationships');
    const match = insertTask('Anniversary dinner');
    pickCategory(match, makeCategory('health'), 0); // primary is a different category
    pickCategory(match, relationships, 1);          // secondary — must still match
    stage(match);
    const plan = await makeCategoryPlan(srv, relationships, at('14:00'), at('16:00'));

    await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id).map((c) => c.title)).toEqual(['Anniversary dinner']);
  });

  it('unions the two routes — a direct match and a grouping match both land, once each', async () => {
    const family = makeCategory('family');
    fileUnderCategory('kids', family);
    const viaGrouping = insertTask('Grouping match', { secondary: ['kids'] });
    const viaCategory = insertTask('Direct match');
    pickCategory(viaCategory, family);
    const both = insertTask('Both routes', { secondary: ['kids'] });
    pickCategory(both, family); // UNION must not duplicate it
    [viaGrouping, viaCategory, both].forEach(stage);
    const plan = await makeCategoryPlan(srv, family, at('09:00'), at('17:00'));

    await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id).map((c) => c.title).sort()).toEqual(['Both routes', 'Direct match', 'Grouping match']);
  });

  it('still honors the direction opt-out for a directly-tagged task', async () => {
    // The new route must not become a bypass around category_direction_optouts.
    const family = makeCategory('family');
    optOut(family, 'work');
    const workTask = insertTask('Work thing', { direction: 'work' });
    pickCategory(workTask, family);
    const homeTask = insertTask('Home thing', { direction: 'home' });
    pickCategory(homeTask, family);
    [workTask, homeTask].forEach(stage);
    const plan = await makeCategoryPlan(srv, family, at('09:00'), at('17:00'));

    await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id).map((c) => c.title)).toEqual(['Home thing']);
  });

  it('does not match a category the task does not carry', async () => {
    const relationships = makeCategory('relationships');
    const health = makeCategory('health');
    const other = insertTask('Gym session');
    pickCategory(other, health);
    stage(other);
    const plan = await makeCategoryPlan(srv, relationships, at('09:00'), at('17:00'));

    await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id)).toEqual([]);
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

    await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(plan.id).map((c) => c.title).sort()).toEqual(['Home kids thing', 'Loose kids thing']);
  });

  it('is deterministic — a re-stage + re-run reproduces identical placement', async () => {
    const family = makeCategory('family');
    fileUnderCategory('kids', family);
    const ids = [insertTask('A', { secondary: ['kids'] }), insertTask('B', { secondary: ['kids'] }), insertTask('C', { secondary: ['kids'] })];
    ids.forEach(stage);
    const plan = await makeCategoryPlan(srv, family, at('09:00'), at('17:00'));

    await placeFlightPlan(OWNER, { date: DAY });
    const first = childOf(plan.id);
    ids.forEach(stage); // placed tasks were de-staged; re-stage to replay
    await placeFlightPlan(OWNER, { date: DAY }); // clearPriorAuto wipes the prior run, then re-places
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

    await placeFlightPlan(OWNER, { date: DAY });
    expect(childOf(catPlan.id).map((c) => c.title)).toEqual(['Kids']);
    // the category task must NOT also land in the tag Plan, and vice-versa
    expect(childOf(tagPlan.id).map((c) => c.title)).not.toContain('Kids');
  });

  it('recurrence: a recurring category template propagates its categories + frozen color_token to instances', async () => {
    const family = makeCategory('family');
    await api(srv.url, `/api/category-prefs/${family}`, { method: 'PUT', json: { color_token: 'chart-1' } });
    // A near-future recurring category template. Must be WITHIN the recurrence
    // horizon (Phase P, default 7) — the engines no longer materialize far-future
    // days. Use tomorrow + FREQ=DAILY so this holds regardless of run date/weekday.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    const future = d.toISOString().slice(0, 10);
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: {
        title: 'Family evening', block_kind: 'timeblock', block_type: 'scheduled', category_id: family,
        start_at: `${future}T18:00:00.000Z`, end_at: `${future}T19:00:00.000Z`, recurrence_rule: 'FREQ=DAILY',
      },
    });
    await ensureRecurringBlocksForRange(OWNER, `${future}T00:00:00.000Z`, `${future}T23:59:59.999Z`);
    // Phase B (0135): the category axis rides entity_categories (copied template →
    // instance, position preserved); color_token is still the frozen column stamp.
    const inst = sqlite
      .prepare(
        `SELECT tb.id, tb.color_token, ec.category_tag_id
           FROM time_blocks tb
           JOIN entity_categories ec ON ec.entity_kind = 'time_block' AND ec.entity_id = tb.id
          WHERE tb.recurrence_parent_id IS NOT NULL`,
      )
      .get() as { id: string; color_token: string; category_tag_id: string } | undefined;
    expect(inst?.category_tag_id).toBe(family);
    expect(inst?.color_token).toBe('chart-1'); // frozen stamp copied verbatim
  });
});
