import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';

/**
 * cockpit-v2 Phase 5 — tag levels + dilution (REQUIRES CON-3 `entity_tags`).
 *  - Blocks carry a top-level tag (the `time_blocks.tag` mirror) plus N secondary
 *    tags (entity_tags level>1).
 *  - Auto matches a task via ANY of a Plan's tags, but a top-tag match outweighs a
 *    secondary one: `weight = top ? 1 : 1/totalTags`. Flat/single-tag behavior is
 *    unchanged (proven by auto-placement.test.ts staying green).
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
const stage = (taskId: string) =>
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, taskId);

async function makePlan(srv: TestServer, tag: string, secondary: string[], start: string, end: string) {
  return (await api(srv.url, '/api/blocks', {
    method: 'POST',
    json: { title: `${tag} plan`, block_kind: 'timeblock', block_type: 'scheduled', tag, secondary_tags: secondary, start_at: start, end_at: end },
  })).body.block;
}
const agentBlocks = () =>
  sqlite.prepare(`SELECT title, start_at, parent_block_id FROM time_blocks WHERE source_kind = 'agent' ORDER BY start_at`).all() as
    { title: string; start_at: string; parent_block_id: string | null }[];
const levelRows = (kind: string, id: string) =>
  (sqlite
    .prepare(`SELECT t.name AS name, et.level AS level FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_kind = ? AND et.entity_id = ? ORDER BY et.level, t.name`)
    .all(kind, id) as { name: string; level: number }[]);

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00', auto_fill_workday = 0 WHERE owner_id = ?`).run(OWNER);
});

describe('Phase 5 — block secondary tags (write + read)', () => {
  it('stores top tag in the mirror + entity_tags L1, secondary in entity_tags L2; read exposes secondary_tags', async () => {
    const plan = await makePlan(srv, 'work', ['email', 'review'], at('09:00'), at('12:00'));
    expect(plan.tag).toBe('work');               // mirror = top only
    expect(plan.secondary_tags.sort()).toEqual(['email', 'review']);
    expect(levelRows('time_block', plan.id)).toEqual([
      { name: 'work', level: 1 },
      { name: 'email', level: 2 },
      { name: 'review', level: 2 },
    ]);
    const got = (await api(srv.url, `/api/blocks?from=${at('00:00')}&to=${at('23:59')}`)).body.blocks.find((b: any) => b.id === plan.id);
    expect(got.secondary_tags.sort()).toEqual(['email', 'review']);
  });

  it('partial PATCH preserves the untouched level', async () => {
    const plan = await makePlan(srv, 'work', ['email'], at('09:00'), at('12:00'));
    // PATCH secondary only → top 'work' preserved.
    await api(srv.url, `/api/blocks/${plan.id}`, { method: 'PATCH', json: { secondary_tags: ['review'] } });
    expect(levelRows('time_block', plan.id)).toEqual([{ name: 'work', level: 1 }, { name: 'review', level: 2 }]);
    // PATCH tag only → secondary 'review' preserved.
    await api(srv.url, `/api/blocks/${plan.id}`, { method: 'PATCH', json: { tag: 'deep' } });
    expect(levelRows('time_block', plan.id)).toEqual([{ name: 'deep', level: 1 }, { name: 'review', level: 2 }]);
  });
});

describe('Phase 5 — dilution in Auto placement', () => {
  it('matches via a secondary tag, but a top-tag task outranks a secondary-only one', async () => {
    const plan = await makePlan(srv, 'work', ['email'], at('09:00'), at('12:00'));
    // `secondaryTask` is created FIRST → its uuid7 sorts before `topTask`, so the
    // pre-dilution id-tiebreak would place it first. Dilution must override that.
    const secondaryTask = insertTask('Triage inbox', 60, 'email');
    const topTask = insertTask('Write code', 60, 'work');
    [secondaryTask, topTask].forEach(stage);

    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBe(2); // both matched the Plan (top + secondary)
    const inPlan = agentBlocks().filter((b) => b.parent_block_id === plan.id);
    expect(inPlan.map((b) => b.title)).toEqual(['Write code', 'Triage inbox']); // top first
  });

  it('a single-tag Plan still matches only its tag (dilution is a no-op there)', async () => {
    const plan = await makePlan(srv, 'work', [], at('09:00'), at('12:00'));
    const a = insertTask('Work thing', 60, 'work');
    const b = insertTask('Errand', 60, 'errands');
    [a, b].forEach(stage);
    const r = placeFlightPlan(OWNER, { date: DAY });
    expect(r.placedInPlans).toBe(1); // only the 'work' task matched (workday fallback off)
    expect(agentBlocks().filter((x) => x.parent_block_id === plan.id).map((x) => x.title)).toEqual(['Work thing']);
  });
});

describe('Phase 5 — recall clone carries entity_tags', () => {
  it('a recalled task is tagged in the normalized store, not just task_tags', async () => {
    const created = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Shelf me', tags: ['research'] } });
    const srcId = created.body.task.id as string;
    expect(levelRows('task', srcId)).toEqual([{ name: 'research', level: 1 }]);

    const recalled = await api(srv.url, `/api/tasks/${srcId}/recall`, { method: 'POST' });
    const newId = recalled.body.task.id as string;
    expect(newId).not.toBe(srcId);
    expect(levelRows('task', newId)).toEqual([{ name: 'research', level: 1 }]);
  });
});
