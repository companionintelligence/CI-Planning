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
  it('STEP 1: Fill adds candidates without scheduling anything', async () => {
    insertTask('Write spec');
    insertTask('Fix bug');
    const r = await api(srv.url, '/api/auto/fill', { method: 'POST', json: {} });
    expect(r.body.result.step).toBe('fill');
    expect(r.body.result.candidatesAdded).toBe(2);
    expect(taskBlocks()).toBe(0); // nothing scheduled
    expect(r.body.flight_plan.every((x: any) => x.selected === true)).toBe(true); // proposed, selected (deselect-to-exclude)
  });

  it('Fill and Run are independent: deselecting all then running places nothing', async () => {
    insertTask('A');
    insertTask('B');
    const fill = await api(srv.url, '/api/auto/fill', { method: 'POST', json: {} });
    expect(fill.body.result.step).toBe('fill');
    expect(fill.body.flight_plan.every((x: any) => x.selected === true)).toBe(true);

    // Deselect everything — the flight-plan is still non-empty.
    for (const x of fill.body.flight_plan) {
      await api(srv.url, `/api/flight-plan/${x.task_id}`, { method: 'PATCH', json: { selected: false } });
    }

    // Run must PLACE (never re-FILL). Nothing selected → nothing placed.
    const run = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(run.body.result.step).toBe('place');
    expect(taskBlocks()).toBe(0);
    expect(run.body.flight_plan).toHaveLength(2); // not re-filled / duplicated
    expect(run.body.flight_plan.every((x: any) => x.selected === false)).toBe(true);
  });

  it('Auto Schedule places staged tasks via workday fill; non-staged tasks are never placed', async () => {
    const staged = insertTask('Deep work', 60);
    const notStaged = insertTask('Unrelated', 60);
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: staged } }); // selected by default

    // Auto Schedule includes workday fill for untagged staged tasks.
    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(r.body.result.step).toBe('place');
    expect(blockTitles()).toContain('Deep work'); // placed via workday fill
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

describe('placed tasks are removed from the flight plan (item 5)', () => {
  it('a task placed by the priority tap is removed from the flight plan', async () => {
    const t = insertTask('Priority placed', 60);
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: t } });

    const r = await api(srv.url, '/api/auto/priority', { method: 'POST', json: { date: '2026-06-22' } });
    expect(r.body.result.blocksCreated).toBeGreaterThanOrEqual(1);

    const fp = (await api(srv.url, '/api/flight-plan')).body.flight_plan;
    expect(fp.find((x: any) => x.task_id === t)).toBeUndefined();
    expect(blockTitles()).toContain('Priority placed');
  });

  it('tasks placed by workday fill are removed from the flight plan', async () => {
    const t = insertTask('Untagged', 60);
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: t } });

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: '2026-06-22' } });
    expect(r.body.result.placed).toBeGreaterThanOrEqual(1);

    const fp = (await api(srv.url, '/api/flight-plan')).body.flight_plan;
    expect(fp.find((x: any) => x.task_id === t)).toBeUndefined(); // removed after workday fill
  });
});

describe('recurring task indicator (item 6)', () => {
  function insertTemplate(title: string): string {
    return (sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id, status, priority, recurrence_rule) VALUES (uuid7(), ?, ?, 'open', 3, 'FREQ=DAILY') RETURNING id`
    ).get(title, OWNER) as { id: string }).id;
  }
  function insertInstance(parentId: string, title: string): string {
    return (sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id, status, priority, recurrence_parent_id, occurrence_date) VALUES (uuid7(), ?, ?, 'open', 3, ?, '2026-06-22') RETURNING id`
    ).get(title, OWNER, parentId) as { id: string }).id;
  }

  it('fillFlightPlanCandidates includes templates but excludes recurrence instances', async () => {
    const template = insertTemplate('Morning run');
    const instance = insertInstance(template, 'Morning run');

    const r = await api(srv.url, '/api/auto/fill', { method: 'POST', json: {} });
    expect(r.body.result.step).toBe('fill');

    const ids = r.body.flight_plan.map((x: any) => x.task_id);
    expect(ids).toContain(template);
    expect(ids).not.toContain(instance);
  });

  it('is_recurring is true for tasks with a recurrence_rule and false otherwise', async () => {
    const template = insertTemplate('Weekly review');
    const normal = insertTask('Normal task');

    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: template } });
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: normal } });

    const fp = (await api(srv.url, '/api/flight-plan')).body.flight_plan;
    expect(fp.find((x: any) => x.task_id === template)?.is_recurring).toBe(true);
    expect(fp.find((x: any) => x.task_id === normal)?.is_recurring).toBe(false);
  });

  it('POST /api/flight-plan rejects staging a recurrence instance with 422', async () => {
    const template = insertTemplate('Daily standup');
    const instance = insertInstance(template, 'Daily standup');

    const r = await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: instance } });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/template/i);

    // The instance must not have been added.
    const fp = (await api(srv.url, '/api/flight-plan')).body.flight_plan;
    expect(fp.find((x: any) => x.task_id === instance)).toBeUndefined();
  });

  it('POST /api/flight-plan 404s for an unknown task_id', async () => {
    const r = await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: 'nonexistent-id' } });
    expect(r.status).toBe(404);
  });
});
