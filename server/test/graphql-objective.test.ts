import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W8a — ObjectiveType end-to-end over HTTP. Proves the objectives/objective
 * queries, the parent/children/tasks/category field resolvers, the CRUD mutations reusing
 * the SAME services the REST routes use (cross-checked via REST GET), bottom-up hierarchy
 * leveling, the cycle + leaf-only-link guards, and cross-owner isolation.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

const insertTask = (title: string, owner = OWNER): string =>
  (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), ?, ?, 'open', 3) RETURNING id`).get(title, owner) as { id: string }).id;
const makeCategory = (name: string, owner = OWNER): string =>
  (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`).get(owner, name) as { id: string }).id;

/** create an objective via GraphQL, returning its id. */
async function create(fields: string, headers: Record<string, string> = {}): Promise<string> {
  const m = await gql(`mutation { createObjective(input: { ${fields} }) { success objective { id } } }`, headers);
  if (!m.body.data?.createObjective?.success) throw new Error(`create failed: ${JSON.stringify(m.body.errors)}`);
  return m.body.data.createObjective.objective.id;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM objective_tasks; DELETE FROM objectives;`);
});

describe('W8a — ObjectiveType queries + leveling', () => {
  it('a lone objective is a leaf (level=objective); visible via REST GET', async () => {
    const id = await create('title: "Ship v1"');
    const r = await gql(`{ objective(id: "${id}") { title level status } }`);
    expect(r.body.data.objective).toEqual({ title: 'Ship v1', level: 'objective', status: 'active' });
    const rest = await api(srv.url, '/api/objectives');
    expect((rest.body.objectives as { id: string }[]).some((o) => o.id === id)).toBe(true);
  });

  it('nesting builds levels bottom-up: parent becomes project, and parent/children resolve', async () => {
    const goal = await create('title: "Grow"');
    const child = await create(`title: "Q3", parentId: "${goal}"`);

    const parent = await gql(`{ objective(id: "${goal}") { level children { id level } } }`);
    expect(parent.body.data.objective.level).toBe('project');            // gained a child → height 1
    expect(parent.body.data.objective.children).toEqual([{ id: child, level: 'objective' }]);

    const kid = await gql(`{ objective(id: "${child}") { level parent { id } } }`);
    expect(kid.body.data.objective).toEqual({ level: 'objective', parent: { id: goal } });
  });

  it('objectives lists all the owner\'s nodes flat', async () => {
    const a = await create('title: "A"');
    const b = await create('title: "B"');
    const keys = (await gql('{ objectives { id title } }')).body.data.objectives.map((o: any) => o.id).sort();
    expect(keys).toEqual([a, b].sort());
  });
});

describe('W8a — mutations reuse the REST services', () => {
  it('updateObjective renames; deleteObjective archives (0129) — gone from the graph, row kept', async () => {
    const id = await create('title: "Old"');
    const u = await gql(`mutation { updateObjective(input: { id: "${id}", title: "New", status: "paused" }) { objective { title status } } }`);
    expect(u.body.data.updateObjective.objective).toEqual({ title: 'New', status: 'paused' });
    const d = await gql(`mutation { deleteObjective(input: { id: "${id}" }) { success deletedId } }`);
    expect(d.body.data.deleteObjective).toEqual({ success: true, deletedId: id });
    // The graph is the LIVE graph, so it resolves to null exactly as before…
    expect((await gql(`{ objective(id: "${id}") { id } }`)).body.data.objective).toBeNull();
    // …but the row survives and is restorable: GraphQL delete now means archive, the
    // same as REST DELETE, because both go through archiveObjective.
    const row = sqlite.prepare(`SELECT archived_at FROM objectives WHERE id = ?`).get(id) as { archived_at: string | null } | undefined;
    expect(row?.archived_at).toBeTruthy();
  });

  it('rejects a title-less create, an unknown parent, and a cycle', async () => {
    expect((await gql('mutation { createObjective(input: { title: "  " }) { success } }')).body.errors?.[0]?.message).toMatch(/title is required/i);
    expect((await gql('mutation { createObjective(input: { title: "x", parentId: "nope" }) { success } }')).body.errors?.[0]?.message).toMatch(/parent_id not found/i);

    const a = await create('title: "A"');
    const b = await create(`title: "B", parentId: "${a}"`);
    // Re-parent A under its own descendant B → cycle.
    const cycle = await gql(`mutation { updateObjective(input: { id: "${a}", parentId: "${b}" }) { success } }`);
    expect(cycle.body.errors?.[0]?.message).toMatch(/cycle/i);
  });

  it('links a task to a leaf objective; rejects linking to a non-leaf', async () => {
    const leaf = await create('title: "Leaf"');
    const t = insertTask('Do it');
    const link = await gql(`mutation { linkObjectiveTask(input: { objectiveId: "${leaf}", taskId: "${t}" }) { success objective { tasks { id title } } } }`);
    expect(link.body.data.linkObjectiveTask.success).toBe(true);
    expect(link.body.data.linkObjectiveTask.objective.tasks).toEqual([{ id: t, title: 'Do it' }]);

    // Give `parent` a child → it's a non-leaf now; linking a task to it is rejected.
    const parent = await create('title: "Parent"');
    await create(`title: "Kid", parentId: "${parent}"`);
    const bad = await gql(`mutation { linkObjectiveTask(input: { objectiveId: "${parent}", taskId: "${insertTask('x')}" }) { success } }`);
    expect(bad.body.errors?.[0]?.message).toMatch(/leaf objective/i);

    // Unlink is idempotent + clears the tasks edge.
    const unlink = await gql(`mutation { unlinkObjectiveTask(input: { objectiveId: "${leaf}", taskId: "${t}" }) { success objective { tasks { id } } } }`);
    expect(unlink.body.data.unlinkObjectiveTask).toEqual({ success: true, objective: { tasks: [] } });
  });

  it('category resolves the category tag', async () => {
    const cat = makeCategory('Health');
    const id = await create(`title: "Fitness", categoryId: "${cat}"`);
    const r = await gql(`{ objective(id: "${id}") { category { id label } } }`);
    expect(r.body.data.objective.category).toEqual({ id: cat, label: 'Health' });
  });

  it('TaskType.objective resolves the first linked objective (null when none)', async () => {
    const obj = await create('title: "Ship"');
    const t = insertTask('Do it');
    await gql(`mutation { linkObjectiveTask(input: { objectiveId: "${obj}", taskId: "${t}" }) { success } }`);
    const linked = await gql(`{ task(id: "${t}") { objective { id title } } }`);
    expect(linked.body.data.task.objective).toEqual({ id: obj, title: 'Ship' });

    const t2 = insertTask('Unlinked');
    expect((await gql(`{ task(id: "${t2}") { objective { id } } }`)).body.data.task.objective).toBeNull();
  });
});

describe('W8a — owner scoping', () => {
  it('another owner cannot see or mutate this owner\'s objective', async () => {
    createOwner(OTHER);
    const id = await create('title: "Mine"');

    expect((await gql('{ objectives { id } }', { 'x-test-owner': OTHER })).body.data.objectives).toEqual([]);
    expect((await gql(`{ objective(id: "${id}") { id } }`, { 'x-test-owner': OTHER })).body.data.objective).toBeNull();
    const del = await gql(`mutation { deleteObjective(input: { id: "${id}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(del.body.errors?.[0]?.message).toMatch(/not found/i);
    // A cross-owner link attempt fails at the objective ownership check.
    const link = await gql(`mutation { linkObjectiveTask(input: { objectiveId: "${id}", taskId: "${insertTask('t', OTHER)}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(link.body.errors?.[0]?.message).toMatch(/objective not found/i);

    expect((await gql(`{ objective(id: "${id}") { title } }`)).body.data.objective.title).toBe('Mine');
  });
});
