/**
 * AF-2 — GET /api/objectives returns linked tasks per LEAF objective.
 *
 * Response-shape decision: `tasks` is ALWAYS present on every node (never absent),
 * populated only on leaves; non-leaf nodes always carry `tasks: []`. Active links only
 * (linked=1), cancelled tasks excluded, ONE batched query (no N+1). next_action and
 * has_tasks are unchanged — the client depends on them until Wave 2.
 *
 * Pinned dates avoid time-bomb failures under TZ=UTC (repo gotcha).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

const NOW = '2026-06-15T12:00:00.000Z';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM objective_tasks; DELETE FROM objectives;`);
});

// ── Helpers (mirror objectives.test.ts) ───────────────────────────────────────

function insertTask(
  title: string,
  opts: { status?: string; priority?: number; due_at?: string | null; owner?: string } = {},
): string {
  return (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, priority, due_at)
     VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING id`
  ).get(title, opts.owner ?? SYSTEM_OWNER, opts.status ?? 'open', opts.priority ?? 3, opts.due_at ?? null) as { id: string }).id;
}

function insertObjective(fields: { title: string; parent_id?: string | null; owner?: string }): string {
  return (sqlite.prepare(`
    INSERT INTO objectives (id, owner_id, parent_id, title, level, horizon, status,
      cadence, created_at, updated_at)
    VALUES (uuid7(), ?, ?, ?, 'objective', 'none', 'active', 'none', ?, ?)
    RETURNING id
  `).get(fields.owner ?? SYSTEM_OWNER, fields.parent_id ?? null, fields.title, NOW, NOW) as { id: string }).id;
}

function linkTask(objectiveId: string, taskId: string, linked = 1): void {
  sqlite.prepare(`INSERT INTO objective_tasks (objective_id, task_id, linked) VALUES (?, ?, ?)`).run(objectiveId, taskId, linked);
}

/** Depth-first find in the nested tree response. */
function findNode(nodes: any[], id: string): any {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children ?? [], id);
    if (f) return f;
  }
  return null;
}

async function tree(headers: Record<string, string> = {}): Promise<any[]> {
  const res = await api(srv.url, '/api/objectives', { headers });
  expect(res.status).toBe(200);
  return res.body.objectives;
}

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as { data?: any; errors?: { message: string }[] };
}

// ── Leaf task arrays ───────────────────────────────────────────────────────────

describe('GET /api/objectives — per-leaf tasks (AF-2)', () => {
  it('leaf includes its linked tasks with the minimal summary fields', async () => {
    const leaf = insertObjective({ title: 'Leaf' });
    const t = insertTask('Do the thing', { priority: 2, due_at: '2026-07-01T00:00:00.000Z' });
    linkTask(leaf, t);

    const node = findNode(await tree(), leaf);
    expect(node.tasks).toHaveLength(1);
    expect(node.tasks[0]).toEqual({
      id: t,
      title: 'Do the thing',
      status: 'open',
      priority: 2,
      due_at: '2026-07-01T00:00:00.000Z',
      scheduled_for: null,
      parent_id: null,
      completed_at: null,
    });
  });

  it('non-leaf nodes always carry tasks: [] (shape decision: always-present array)', async () => {
    const root = insertObjective({ title: 'Goal' });
    const mid = insertObjective({ title: 'Project', parent_id: root });
    const leaf = insertObjective({ title: 'Leaf', parent_id: mid });
    linkTask(leaf, insertTask('Leaf work'));

    const t = await tree();
    expect(findNode(t, root).tasks).toEqual([]);
    expect(findNode(t, mid).tasks).toEqual([]);
    expect(findNode(t, leaf).tasks).toHaveLength(1);
  });

  it('excludes tombstoned links (linked=0) and cancelled tasks; keeps done tasks', async () => {
    const leaf = insertObjective({ title: 'Filtered' });
    const open = insertTask('Open');
    const done = insertTask('Done', { status: 'done' });
    const cancelled = insertTask('Cancelled', { status: 'cancelled' });
    const tombstoned = insertTask('Tombstoned');
    linkTask(leaf, open);
    linkTask(leaf, done);
    linkTask(leaf, cancelled);
    linkTask(leaf, tombstoned, 0);

    const ids = findNode(await tree(), leaf).tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual([open, done].sort());
  });

  it('stable ordering: priority ASC, then due_at ASC with NULLs last, then id', async () => {
    const leaf = insertObjective({ title: 'Ordered' });
    const p1NoDue = insertTask('p1 no due', { priority: 1 });
    const p1Early = insertTask('p1 early', { priority: 1, due_at: '2026-06-20T00:00:00.000Z' });
    const p1Late = insertTask('p1 late', { priority: 1, due_at: '2026-06-25T00:00:00.000Z' });
    const p3 = insertTask('p3', { priority: 3, due_at: '2026-06-01T00:00:00.000Z' });
    for (const t of [p3, p1NoDue, p1Late, p1Early]) linkTask(leaf, t);

    const ids = findNode(await tree(), leaf).tasks.map((t: any) => t.id);
    expect(ids).toEqual([p1Early, p1Late, p1NoDue, p3]);
  });

  it('next_action and has_tasks are unchanged alongside the new tasks array', async () => {
    const leaf = insertObjective({ title: 'Compat' });
    const empty = insertObjective({ title: 'Empty' });
    const t = insertTask('Next up');
    linkTask(leaf, t);

    const nodes = await tree();
    const bearing = findNode(nodes, leaf);
    expect(bearing.has_tasks).toBe(true);
    expect(bearing.next_action?.id).toBe(t);
    const bare = findNode(nodes, empty);
    expect(bare.has_tasks).toBe(false);
    expect(bare.next_action).toBeNull();
    expect(bare.tasks).toEqual([]);
  });
});

// ── REST ↔ GraphQL parity ─────────────────────────────────────────────────────

describe('REST/GraphQL task-set parity', () => {
  it('per-leaf REST task id set matches GraphQL ObjectiveType.tasks for the same fixture', async () => {
    const leafA = insertObjective({ title: 'Leaf A' });
    const leafB = insertObjective({ title: 'Leaf B' });
    const a1 = insertTask('A1');
    const a2 = insertTask('A2', { status: 'done' });
    const b1 = insertTask('B1');
    linkTask(leafA, a1);
    linkTask(leafA, a2);
    linkTask(leafB, b1);

    const nodes = await tree();
    for (const leaf of [leafA, leafB]) {
      const restIds = findNode(nodes, leaf).tasks.map((t: any) => t.id).sort();
      const g = await gql(`{ objective(id: "${leaf}") { tasks { id } } }`);
      const gqlIds = g.data.objective.tasks.map((t: any) => t.id).sort();
      expect(restIds).toEqual(gqlIds);
    }
  });
});

// ── Multi-owner isolation ─────────────────────────────────────────────────────

describe('multi-owner isolation', () => {
  it('each owner sees only their own objectives and tasks', async () => {
    createOwner(SECOND_OWNER_ID);
    const mine = insertObjective({ title: 'Mine' });
    const myTask = insertTask('My task');
    linkTask(mine, myTask);

    const theirs = insertObjective({ title: 'Theirs', owner: SECOND_OWNER_ID });
    const theirTask = insertTask('Their task', { owner: SECOND_OWNER_ID });
    linkTask(theirs, theirTask);

    const myTree = await tree();
    expect(findNode(myTree, theirs)).toBeNull();
    expect(findNode(myTree, mine).tasks.map((t: any) => t.id)).toEqual([myTask]);

    const theirTree = await tree({ 'x-test-owner': SECOND_OWNER_ID });
    expect(findNode(theirTree, mine)).toBeNull();
    expect(findNode(theirTree, theirs).tasks.map((t: any) => t.id)).toEqual([theirTask]);
  });

  it('a dangling link to another owner\'s task does not leak into my tree', async () => {
    createOwner(SECOND_OWNER_ID);
    const mine = insertObjective({ title: 'Mine' });
    const foreignTask = insertTask('Foreign', { owner: SECOND_OWNER_ID });
    linkTask(mine, foreignTask); // stray row (sync/import) — no write path creates this

    expect(findNode(await tree(), mine).tasks).toEqual([]);
  });
});

// ── Promotion flow end-to-end ─────────────────────────────────────────────────

describe('subtask auto-promotion appears in the tree with tasks', () => {
  it('creating a subtask via POST /api/tasks promotes the parent and the tree shows its tasks', async () => {
    const parentRes = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Plan the launch' } });
    expect(parentRes.status).toBe(201);
    const parentId = parentRes.body.task.id;

    const subRes = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Draft announcement', parent_id: parentId } });
    expect(subRes.status).toBe(201);
    const subId = subRes.body.task.id;

    const nodes = await tree();
    const auto = nodes.find((o: any) => o.source_task_id === parentId);
    expect(auto).toBeDefined();
    expect(auto.title).toBe('Plan the launch');
    expect(auto.level).toBe('objective'); // promoted objectives are guaranteed leaves
    const ids = auto.tasks.map((t: any) => t.id).sort();
    expect(ids).toEqual([parentId, subId].sort());
    expect(auto.has_tasks).toBe(true);
  });
});
