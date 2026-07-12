/**
 * §H/§I — auto-promoting a task with subtasks into a leaf objective, and exposing
 * `objective_id` on the task payload (drives the task list's 8-pointed star).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM objective_tasks; DELETE FROM objectives;`);
});

const objectivesOf = (taskId: string): string[] =>
  (sqlite.prepare(`SELECT objective_id FROM objective_tasks WHERE task_id = ?`).all(taskId) as { objective_id: string }[]).map((r) => r.objective_id);

async function createTask(title: string, parent_id?: string): Promise<string> {
  const r = await api(srv.url, '/api/tasks', { method: 'POST', json: { title, ...(parent_id ? { parent_id } : {}) } });
  return r.body.task.id;
}

describe('auto-promote task-with-subtasks → objective', () => {
  it('adding the first subtask creates one leaf objective linking parent + subtask', async () => {
    const parent = await createTask('Ship v2');
    expect(objectivesOf(parent)).toHaveLength(0); // not promoted until it has a subtask

    const sub1 = await createTask('Write RFC', parent);
    const objs = objectivesOf(parent);
    expect(objs).toHaveLength(1);
    const objId = objs[0];
    // The auto-created node is a leaf objective titled after the parent.
    const obj = sqlite.prepare(`SELECT title, level FROM objectives WHERE id = ?`).get(objId) as { title: string; level: string };
    expect(obj.level).toBe('objective');
    expect(obj.title).toBe('Ship v2');
    // Both parent and subtask are linked to it.
    expect(objectivesOf(sub1)).toEqual([objId]);
  });

  it('a second subtask links to the SAME objective (no duplicate)', async () => {
    const parent = await createTask('Ship v2');
    await createTask('Write RFC', parent);
    const objId = objectivesOf(parent)[0];
    const sub2 = await createTask('Build API', parent);
    // No new objective spawned; the second subtask joins the existing one.
    const allObjs = sqlite.prepare(`SELECT COUNT(*) AS n FROM objectives`).get() as { n: number };
    expect(allObjs.n).toBe(1);
    expect(objectivesOf(sub2)).toEqual([objId]);
  });

  it('re-parenting an existing task under another promotes that parent (PATCH)', async () => {
    const parent = await createTask('Umbrella');
    const loose = await createTask('Loose task');
    expect(objectivesOf(parent)).toHaveLength(0);
    await api(srv.url, `/api/tasks/${loose}`, { method: 'PATCH', json: { parent_id: parent } });
    expect(objectivesOf(parent)).toHaveLength(1);
    expect(objectivesOf(loose)).toEqual(objectivesOf(parent));
  });

  it('GET /api/tasks carries objective_id for a promoted task, null otherwise', async () => {
    const parent = await createTask('Has plan');
    await createTask('a sub', parent);
    const soloId = await createTask('Solo');

    const list = (await api(srv.url, '/api/tasks', { method: 'GET' })).body.tasks as { id: string; objective_id: string | null }[];
    const parentRow = list.find((t) => t.id === parent)!;
    const soloRow = list.find((t) => t.id === soloId)!;
    expect(parentRow.objective_id).toBeTruthy();
    expect(soloRow.objective_id).toBeNull();
  });

  it('does not reuse an unrelated manually-linked objective (keyed on source_task_id)', async () => {
    const other = (sqlite.prepare(`INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, created_at, updated_at) VALUES (uuid7(), ?, 'Unrelated', 'objective', 'none', 'active', 'none', '2026-01-01', '2026-01-01') RETURNING id`).get(SYSTEM_OWNER) as { id: string }).id;
    const parent = await createTask('Manually linked');
    await api(srv.url, `/api/objectives/${other}/tasks`, { method: 'POST', json: { task_id: parent } });
    // Now add a subtask → a FRESH objective is created (not the unrelated one).
    await createTask('sub', parent);
    const objs = objectivesOf(parent);
    expect(objs).toContain(other);
    const auto = objs.find((o) => o !== other)!;
    const src = sqlite.prepare(`SELECT source_task_id FROM objectives WHERE id = ?`).get(auto) as { source_task_id: string };
    expect(src.source_task_id).toBe(parent);
  });

  it('excludes quick subtasks from the promoted objective', async () => {
    const parent = await createTask('Ritual host');
    await createTask('normal sub', parent);
    const objId = objectivesOf(parent)[0];
    // A quick (ritual-local) child should NOT be linked.
    const quick = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, subtype, parent_id) VALUES (uuid7(), 'quicky', ?, 'open', 'quick', ?) RETURNING id`).get(SYSTEM_OWNER, parent) as { id: string }).id;
    // Re-trigger promotion via another normal subtask add.
    await createTask('another sub', parent);
    const linked = sqlite.prepare(`SELECT 1 FROM objective_tasks WHERE objective_id = ? AND task_id = ?`).get(objId, quick);
    expect(linked).toBeUndefined();
  });

  it('GC: cancelling the last subtask removes the pristine auto-objective', async () => {
    const parent = await createTask('Will empty out');
    const sub = await createTask('only sub', parent);
    const objId = objectivesOf(parent)[0];
    expect(objId).toBeTruthy();
    // Cancel the only subtask → parent has no active subtasks → objective GC'd.
    await api(srv.url, `/api/tasks/${sub}`, { method: 'DELETE' });
    const still = sqlite.prepare(`SELECT 1 FROM objectives WHERE id = ?`).get(objId);
    expect(still).toBeUndefined();
    expect(objectivesOf(parent)).toHaveLength(0);
  });

  it('GC: an organized (nested) objective is NOT auto-deleted when emptied', async () => {
    const parent = await createTask('Organized');
    const sub = await createTask('sub', parent);
    const objId = objectivesOf(parent)[0];
    // User organizes it under a project (give it a parent) — now it's theirs to keep.
    const proj = (sqlite.prepare(`INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, created_at, updated_at) VALUES (uuid7(), ?, 'Project', 'project', 'none', 'active', 'none', '2026-01-01', '2026-01-01') RETURNING id`).get(SYSTEM_OWNER) as { id: string }).id;
    await api(srv.url, `/api/objectives/${objId}`, { method: 'PATCH', json: { parent_id: proj } });
    await api(srv.url, `/api/tasks/${sub}`, { method: 'DELETE' });
    // Still present — nesting made it non-pristine, so GC leaves it alone.
    expect(sqlite.prepare(`SELECT 1 FROM objectives WHERE id = ?`).get(objId)).toBeTruthy();
  });

  it('subtasks endpoint carries objective_ids alongside objective_id', async () => {
    const parent = await createTask('Promoted parent');
    const sub = await createTask('a sub', parent);
    const objId = objectivesOf(parent)[0];
    const subs = (await api(srv.url, `/api/tasks/${parent}/subtasks`, { method: 'GET' })).body
      .subtasks as { id: string; objective_id: string | null; objective_ids: string[] }[];
    const row = subs.find((s) => s.id === sub)!;
    expect(row.objective_ids).toEqual([objId]);
    expect(row.objective_id).toBe(objId);
  });

  it('cancelling a linked task does not inflate objective progress', async () => {
    const parent = await createTask('Progress host');
    const s1 = await createTask('s1', parent);
    await createTask('s2', parent);
    const objId = objectivesOf(parent)[0];
    await api(srv.url, `/api/objectives/${objId}/recompute`, { method: 'POST' });
    // Cancel one subtask → it should DROP from the rollup, not count as done.
    await api(srv.url, `/api/tasks/${s1}`, { method: 'DELETE' });
    const p = (sqlite.prepare(`SELECT progress_cache FROM objectives WHERE id = ?`).get(objId) as { progress_cache: number | null }).progress_cache;
    // Remaining linked tasks (parent + s2) are all open → 0, never inflated by the cancel.
    expect(p === null || p === 0).toBe(true);
  });
});

/**
 * AF-10 — `objective_ids` surfaces ALL links (M:N made honest) with the same
 * semantics as GraphQL TaskType.objective: owner-scoped, linked=1 only,
 * ORDER BY objectives.created_at, id; objective_id stays = objective_ids[0].
 */
describe('AF-10 — objective_ids on task payloads', () => {
  const insertObjective = (id: string, title: string, createdAt: string, owner = SYSTEM_OWNER): string => {
    sqlite
      .prepare(`INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, created_at, updated_at) VALUES (?, ?, ?, 'objective', 'none', 'active', 'none', ?, ?)`)
      .run(id, owner, title, createdAt, createdAt);
    return id;
  };
  const link = (objectiveId: string, taskId: string, linked = 1): void => {
    sqlite.prepare(`INSERT INTO objective_tasks (objective_id, task_id, linked) VALUES (?, ?, ?)`).run(objectiveId, taskId, linked);
  };
  const taskRow = async (taskId: string) => {
    const list = (await api(srv.url, '/api/tasks', { method: 'GET' })).body.tasks as {
      id: string; objective_id: string | null; objective_ids: string[];
    }[];
    return list.find((t) => t.id === taskId)!;
  };

  it('carries ALL links ordered by created_at then id; objective_id === objective_ids[0]', async () => {
    const taskId = await createTask('Serves three objectives');
    // created_at is the primary sort key (NOT the surrogate id): give the
    // LATEST-sorting id the EARLIEST created_at so id-ordering would misplace it.
    const late = insertObjective('00000000-0000-7000-8000-00000000000f', 'earliest created', '2026-01-01');
    const a = insertObjective('00000000-0000-7000-8000-00000000000a', 'tiebreak a', '2026-02-01');
    const b = insertObjective('00000000-0000-7000-8000-00000000000b', 'tiebreak b', '2026-02-01');
    // Scrambled insertion order — must not leak into the response order.
    link(b, taskId); link(late, taskId); link(a, taskId);

    const row = await taskRow(taskId);
    expect(row.objective_ids).toEqual([late, a, b]); // created_at first, then id tiebreak
    expect(row.objective_id).toBe(row.objective_ids[0]);
  });

  it('excludes tombstoned links (linked=0)', async () => {
    const taskId = await createTask('Had two, kept one');
    const kept = insertObjective('00000000-0000-7000-8000-000000000001', 'kept', '2026-01-01');
    const dropped = insertObjective('00000000-0000-7000-8000-000000000002', 'dropped', '2026-01-02');
    link(kept, taskId); link(dropped, taskId, 0);

    const row = await taskRow(taskId);
    expect(row.objective_ids).toEqual([kept]);
    expect(row.objective_id).toBe(kept);
  });

  it("owner isolation: a stray link to another owner's objective never surfaces", async () => {
    createOwner(SECOND_OWNER_ID);
    const taskId = await createTask('Mine');
    const mine = insertObjective('00000000-0000-7000-8000-000000000011', 'mine', '2026-01-02');
    const foreign = insertObjective('00000000-0000-7000-8000-000000000010', 'foreign', '2026-01-01', SECOND_OWNER_ID);
    // Dangling cross-owner row (sync/import corruption) — must be invisible even
    // though its objective sorts FIRST (earlier created_at).
    link(foreign, taskId); link(mine, taskId);

    const row = await taskRow(taskId);
    expect(row.objective_ids).toEqual([mine]);
    expect(row.objective_id).toBe(mine);
  });

  it('no links → objective_ids [] and objective_id null', async () => {
    const row = await taskRow(await createTask('Loose'));
    expect(row.objective_ids).toEqual([]);
    expect(row.objective_id).toBeNull();
  });

  it('REST objective_id agrees with GraphQL TaskType.objective on a multi-linked task', async () => {
    const taskId = await createTask('Parity check');
    const first = insertObjective('00000000-0000-7000-8000-000000000022', 'first by created_at', '2026-01-01');
    const second = insertObjective('00000000-0000-7000-8000-000000000021', 'second despite lower id', '2026-01-02');
    link(second, taskId); link(first, taskId);

    const rest = await taskRow(taskId);
    const res = await fetch(`${srv.url}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `{ task(id: "${taskId}") { objective { id } } }` }),
    });
    const gqlObjective = ((await res.json()) as { data: { task: { objective: { id: string } | null } } }).data.task.objective;
    expect(gqlObjective?.id).toBe(first);
    expect(rest.objective_id).toBe(gqlObjective?.id ?? null); // REST ↔ GraphQL same first pick
  });
});
