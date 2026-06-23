import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Flight-plan + two-step Auto (Phase G, G4). The flight-plan is the persisted,
 * owner-scoped staging area; Auto only ever touches it (empty → propose candidates;
 * selected → place them, scoped to a Time-Block's window + tag when given).
 */

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, est = 30, tag?: string): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id`).get(tag) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}
function makePattern(name: string, taskIds: string[]): string {
  const ht = sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND owner_id = ?`).get(OWNER) as { id: string };
  const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(OWNER, ht.id, name) as { id: string }).id;
  taskIds.forEach((tid, i) => sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(pid, tid, i));
  return pid;
}
const taskBlocks = () =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1`).get() as { n: number }).n;
const blockTitles = () =>
  (sqlite.prepare(`SELECT title FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1`).all() as { title: string }[]).map((b) => b.title);

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan; DELETE FROM pattern_tasks; DELETE FROM patterns;`);
});

describe('flight-plan CRUD + persistence', () => {
  it('stages a task (selected), persists it, toggles, removes, resets', async () => {
    const t = insertTask('Review PRs');
    const add = await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: t } });
    expect(add.status).toBe(201);
    // persisted: a fresh GET returns it
    const got = await api(srv.url, '/api/flight-plan');
    expect(got.body.flight_plan).toHaveLength(1);
    expect(got.body.flight_plan[0]).toMatchObject({ task_id: t, selected: true });

    await api(srv.url, `/api/flight-plan/${t}`, { method: 'PATCH', json: { selected: false } });
    expect((await api(srv.url, '/api/flight-plan')).body.flight_plan[0].selected).toBe(false);

    await api(srv.url, `/api/flight-plan/${t}`, { method: 'DELETE' });
    expect((await api(srv.url, '/api/flight-plan')).body.flight_plan).toHaveLength(0);
  });

  it('staging a pattern stages its member tasks (tagged with the source pattern)', async () => {
    const a = insertTask('check ingredients');
    const b = insertTask('grocery shopping');
    const p = makePattern('Family dinner', [a, b]);
    const add = await api(srv.url, '/api/flight-plan', { method: 'POST', json: { pattern_id: p } });
    expect(add.body.added).toBe(2);
    const fp = (await api(srv.url, '/api/flight-plan')).body.flight_plan;
    expect(fp.map((x: any) => x.task_id).sort()).toEqual([a, b].sort());
    expect(fp.every((x: any) => x.source_pattern_id === p)).toBe(true);
  });

  it('reset clears the whole flight-plan', async () => {
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: insertTask('a') } });
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: insertTask('b') } });
    const r = await api(srv.url, '/api/flight-plan/reset', { method: 'POST' });
    expect(r.body.cleared).toBe(2);
    expect((await api(srv.url, '/api/flight-plan')).body.flight_plan).toHaveLength(0);
  });

  it('422 when neither task_id nor pattern_id is given', async () => {
    expect((await api(srv.url, '/api/flight-plan', { method: 'POST', json: {} })).status).toBe(422);
  });
});

describe('two-step Auto', () => {
  it('STEP 1: empty flight-plan → proposes candidates (all selected), schedules nothing', async () => {
    insertTask('Write spec');
    insertTask('Fix bug');
    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(r.body.result.step).toBe('fill');
    expect(r.body.result.candidatesAdded).toBe(2);
    expect(taskBlocks()).toBe(0); // nothing scheduled
    expect(r.body.flight_plan.every((x: any) => x.selected === true)).toBe(true); // proposed, selected (deselect-to-exclude)
  });

  it('step rule keys off emptiness: a non-empty flight-plan places (no re-fill), even if all deselected', async () => {
    insertTask('A');
    insertTask('B');
    const fill = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(fill.body.result.step).toBe('fill');
    expect(fill.body.flight_plan.every((x: any) => x.selected === true)).toBe(true);

    // Deselect everything — the flight-plan is still non-empty.
    for (const x of fill.body.flight_plan) {
      await api(srv.url, `/api/flight-plan/${x.task_id}`, { method: 'PATCH', json: { selected: false } });
    }

    // Next tap must PLACE (non-empty), not silently re-FILL. Nothing selected → nothing placed.
    const next = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(next.body.result.step).toBe('place');
    expect(taskBlocks()).toBe(0);
    expect(next.body.flight_plan).toHaveLength(2); // not re-filled / duplicated
    expect(next.body.flight_plan.every((x: any) => x.selected === false)).toBe(true);
  });

  it('STEP 2 + priority tap: an untagged staged task lands only on the explicit priority tap; non-staged is never placed', async () => {
    const staged = insertTask('Deep work', 60);
    const notStaged = insertTask('Unrelated', 60);
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: staged } }); // selected by default

    // Tap 2 is tag-matched only: an untagged task with no Plan/window stays open.
    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(r.body.result.step).toBe('place');
    expect(blockTitles()).not.toContain('Deep work');

    // Tap 3 (explicit priority): fills the workday window.
    const p = await api(srv.url, '/api/auto/priority', { method: 'POST', json: { date: '2026-06-22' } });
    expect(p.body.result.blocksCreated).toBeGreaterThanOrEqual(1);
    expect(blockTitles()).toContain('Deep work');
    expect(blockTitles()).not.toContain('Unrelated'); // never staged
    expect(notStaged).toBeTruthy();
  });

  it('STEP 2 with a Time-Block: only staged tasks matching its tag are placed in its window', async () => {
    // a container block tagged 'errands', 16:00–18:00
    const block = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Errands', block_kind: 'timeblock', tag: 'errands', start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T18:00:00.000Z' },
    })).body.block;
    const errand = insertTask('Post office', 30, 'errands');
    const work = insertTask('Write code', 30, 'work');
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: errand } });
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: work } });

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22', block_id: block.id } });
    expect(r.body.result.step).toBe('place');
    expect(blockTitles()).toContain('Post office'); // tag matches the block
    expect(blockTitles()).not.toContain('Write code'); // filtered out
    // placed inside the block window
    const placed = sqlite.prepare(`SELECT start_at, end_at FROM time_blocks WHERE title = 'Post office'`).get() as { start_at: string; end_at: string };
    expect(placed.start_at >= '2026-06-22T16:00:00.000Z').toBe(true);
    expect(placed.end_at <= '2026-06-22T18:00:00.000Z').toBe(true);
  });
});
