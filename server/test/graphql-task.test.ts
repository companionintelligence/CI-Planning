import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createTask as svcCreateTask } from '../src/services/tasks.js';

/**
 * Phase W · W3.3b — TaskType end-to-end over HTTP. Mirrors graphql-tag.test.ts: the
 * `task`/`tasks` queries with Relay id-cursor pagination, the field resolvers
 * (parent/subtasks/dependsOn), the CRUD mutations reusing the SAME services the REST
 * routes use (a mutation fires the same SSE broadcast → a sync_events row), and
 * cross-owner isolation (a second owner's task id is invisible + unmutatable).
 */
let srv: TestServer;
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

/** Seed a task for an owner via the shared service; returns its id. */
async function seed(title: string, owner = SYSTEM_OWNER, extra: Parameters<typeof svcCreateTask>[1] = {}): Promise<string> {
  const res = await svcCreateTask(owner, { title, ...extra });
  if (!res.ok) throw new Error(`seed failed: ${res.error}`);
  return res.task.id;
}

function syncEventCount(owner: string, event: string): number {
  return (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE owner_id = ? AND event = ?`)
    .get(owner, event) as { n: number }).n;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('W3.3b — TaskType queries', () => {
  it('tasks connection: fields mapped, id-ordered, cursor-paginated', async () => {
    // The connection orders by id ascending. uuid7 is time-ordered ACROSS milliseconds
    // but its within-ms bytes are random (no monotonic counter — see lib/ids.ts), so
    // three tasks seeded in the same ms need not be in creation order. Assert against the
    // id-SORTED expectation, not creation order, or this flakes under load.
    const ids = [await seed('Alpha'), await seed('Beta'), await seed('Gamma')];
    const titleById = new Map([[ids[0], 'Alpha'], [ids[1], 'Beta'], [ids[2], 'Gamma']]);
    const sorted = [...ids].sort();

    const page1 = await gql('{ tasks(first: 2) { totalCount edges { cursor node { id title status priority subtype } } pageInfo { hasNextPage endCursor } } }');
    expect(page1.body.errors).toBeUndefined();
    const c = page1.body.data.tasks;
    expect(c.totalCount).toBe(3);
    expect(c.edges.map((e: any) => e.node.id)).toEqual(sorted.slice(0, 2));
    expect(c.edges[0].node).toMatchObject({ title: titleById.get(sorted[0]), status: 'open', priority: 3, subtype: 'STANDARD' });
    expect(c.pageInfo.hasNextPage).toBe(true);

    const page2 = await gql(`{ tasks(first: 2, after: "${c.pageInfo.endCursor}") { edges { node { id title } } pageInfo { hasNextPage } } }`);
    expect(page2.body.data.tasks.edges.map((e: any) => e.node.id)).toEqual(sorted.slice(2));
    expect(page2.body.data.tasks.pageInfo.hasNextPage).toBe(false);
  });

  it('tasks(status:) filters', async () => {
    await seed('open one');
    const doneId = await seed('done one');
    sqlite.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(doneId);
    const r = await gql('{ tasks(status: "done") { totalCount edges { node { title status } } } }');
    expect(r.body.data.tasks.totalCount).toBe(1);
    expect(r.body.data.tasks.edges[0].node).toEqual({ title: 'done one', status: 'done' });
  });

  it('task(id): full field set', async () => {
    const id = await seed('Solo', SYSTEM_OWNER, { notes: 'hi', priority: 2, estimated_minutes: 30, due_at: '2026-07-04T10:00:00.000Z', scheduled_for: '2026-07-04' });
    const r = await gql(`{ task(id: "${id}") { id title notes status priority subtype estimatedMinutes dueAt scheduledFor createdAt completedAt } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.task.createdAt).toBeTruthy(); // DateTime! serializes without throwing
    expect(r.body.data.task).toMatchObject({
      id, title: 'Solo', notes: 'hi', status: 'open', priority: 2, subtype: 'STANDARD',
      estimatedMinutes: 30, scheduledFor: '2026-07-04', completedAt: null,
    });
    // dueAt round-trips through the DateTime scalar to a UTC instant.
    expect(new Date(r.body.data.task.dueAt).toISOString()).toBe('2026-07-04T10:00:00.000Z');
  });

  it('task(id): unknown id returns null', async () => {
    const r = await gql('{ task(id: "nope") { id } }');
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.task).toBeNull();
  });
});

describe('W3.3b — TaskType field resolvers', () => {
  it('parent + subtasks connection', async () => {
    const parent = await seed('Parent');
    const s1 = await seed('Sub A', SYSTEM_OWNER, { parent_id: parent });
    const s2 = await seed('Sub B', SYSTEM_OWNER, { parent_id: parent });

    const r = await gql(`{ task(id: "${parent}") { subtasks { totalCount edges { node { id title } } } } }`);
    expect(r.body.data.task.subtasks.totalCount).toBe(2);
    expect(r.body.data.task.subtasks.edges.map((e: any) => e.node.id)).toEqual([s1, s2]);

    const child = await gql(`{ task(id: "${s1}") { parent { id title } } }`);
    expect(child.body.data.task.parent).toEqual({ id: parent, title: 'Parent' });
  });

  it('dependsOn lists the blocker tasks', async () => {
    const blocker = await seed('Blocker');
    const blocked = await seed('Blocked', SYSTEM_OWNER, { depends_on: [blocker] });
    const r = await gql(`{ task(id: "${blocked}") { dependsOn { id title } } }`);
    expect(r.body.data.task.dependsOn).toEqual([{ id: blocker, title: 'Blocker' }]);
    // No blockers → empty list, never null.
    const r2 = await gql(`{ task(id: "${blocker}") { dependsOn { id } } }`);
    expect(r2.body.data.task.dependsOn).toEqual([]);
  });
});

describe('W4a — TaskType Taggable forward edge', () => {
  it('tags: returns the applied tags (all levels) with a non-null taggedAt', async () => {
    const id = await seed('Tagged', SYSTEM_OWNER, { tags: ['work'], secondary_tags: ['deep'] });
    const r = await gql(`{ task(id: "${id}") { tags { id label taggedAt } } }`);
    expect(r.body.errors).toBeUndefined();
    const tags = r.body.data.task.tags as { id: string; label: string; taggedAt: string }[];
    // Level 1 (work) + level 2 (deep) both surface — the honest "tags on this entity".
    expect(tags.map((t) => t.label).sort()).toEqual(['deep', 'work']);
    for (const t of tags) {
      expect(t.id).toBeTruthy();
      // taggedAt is non-null (DateTime!) and a real UTC instant.
      expect(t.taggedAt).toBeTruthy();
      expect(new Date(t.taggedAt).toISOString()).toBe(t.taggedAt);
    }
  });

  it('tags: an untagged task returns [] (never null)', async () => {
    const id = await seed('Bare');
    const r = await gql(`{ task(id: "${id}") { tags { id } } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.task.tags).toEqual([]);
  });
});

describe('W3.3b — TaskType mutations reuse the REST services + fire SSE', () => {
  it('createTask persists (visible via query) + broadcasts task:created', async () => {
    const m = await gql('mutation { createTask(input: { title: "Made in GraphQL", priority: 1, tags: ["gq"] }) { success task { id title priority } } }');
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createTask.success).toBe(true);
    const id = m.body.data.createTask.task.id;
    expect(m.body.data.createTask.task).toMatchObject({ title: 'Made in GraphQL', priority: 1 });
    // Same underlying row — the query sees it.
    const q = await gql(`{ task(id: "${id}") { title } }`);
    expect(q.body.data.task.title).toBe('Made in GraphQL');
    // SSE broadcast fired (sync_events row for the owner).
    expect(syncEventCount(SYSTEM_OWNER, 'task:created')).toBe(1);
  });

  it('updateTask edits columns + versions (stampRow now in service) + broadcasts', async () => {
    const id = await seed('To edit');
    const before = sqlite.prepare(`SELECT version FROM tasks WHERE id = ?`).get(id) as { version: number };
    const m = await gql(`mutation { updateTask(input: { id: "${id}", title: "Edited", priority: 5 }) { success task { title priority } } }`);
    expect(m.body.data.updateTask).toEqual({ success: true, task: { title: 'Edited', priority: 5 } });
    const after = sqlite.prepare(`SELECT version, field_ts FROM tasks WHERE id = ?`).get(id) as { version: number; field_ts: string | null };
    expect(after.version).toBe(before.version + 1); // Phase-L stamp fired inside updateTask
    expect(JSON.parse(after.field_ts ?? '{}')).toHaveProperty('title');
    expect(syncEventCount(SYSTEM_OWNER, 'task:updated')).toBe(1);
  });

  it('updateTask reverse-syncs a placed block → also emits block:updated (REST parity)', async () => {
    // A task with a linked planned block: editing the estimate resizes that block in
    // lockstep (services/tasks.ts → syncBlockFromTask, scope=instance). REST fires
    // block:updated for the synced block (routes/tasks.ts); the GraphQL mutation must too,
    // or other devices render a stale block. Regression for the W-close audit finding.
    const id = await seed('Scheduled', SYSTEM_OWNER, { scheduled_for: '2026-07-04', estimated_minutes: 30 });
    const blockId = (sqlite
      .prepare(
        `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, status, all_day, owner_id)
         VALUES (uuid7(), ?, 'Placed', 'task', '2026-07-04T09:00:00.000Z', '2026-07-04T09:30:00.000Z', 'planned', 0, ?)
         RETURNING id`,
      )
      .get(id, SYSTEM_OWNER) as { id: string }).id;

    const m = await gql(`mutation { updateTask(input: { id: "${id}", estimatedMinutes: 60 }) { success } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.updateTask.success).toBe(true);
    // The linked block was resized in lockstep (span 30 → 60 min)...
    const blk = sqlite.prepare(`SELECT start_at, end_at FROM time_blocks WHERE task_id = ?`).get(id) as { start_at: string; end_at: string };
    expect(Date.parse(blk.end_at) - Date.parse(blk.start_at)).toBe(60 * 60_000);
    // ...and exactly one block:updated event fired, targeting THAT block (clients refresh by
    // entity_id, so a wrong/empty payload would leave the correct block stale — assert the id).
    const events = sqlite
      .prepare(`SELECT entity_id, payload FROM sync_events WHERE owner_id = ? AND event = 'block:updated'`)
      .all(SYSTEM_OWNER) as { entity_id: string; payload: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].entity_id).toBe(blockId);
    expect(JSON.parse(events[0].payload)).toEqual({ id: blockId });
  });

  it('updateTask on an unknown id errors NOT_FOUND', async () => {
    const m = await gql('mutation { updateTask(input: { id: "ghost", title: "x" }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/not found/i);
  });

  // Regression: a DateTime input (dueAt/completedAt) must reach the ISO-string TEXT column
  // as a string. The DateTime scalar parseValue used to return a Date, which threw
  // "SQLite3 can only bind numbers, strings, bigints, buffers, and null" — a latent 500 on
  // every date-valued create/update. Fixed at the scalar (normalizes inputs to ISO strings).
  it('createTask + updateTask accept a DateTime input (dueAt/completedAt) — no bind error', async () => {
    const c = await gql('mutation { createTask(input: { title: "Dated", dueAt: "2026-07-04T10:00:00.000Z" }) { success task { id dueAt } } }');
    expect(c.body.errors).toBeUndefined();
    expect(c.body.data.createTask.success).toBe(true);
    const id = c.body.data.createTask.task.id;
    expect(new Date(c.body.data.createTask.task.dueAt).toISOString()).toBe('2026-07-04T10:00:00.000Z');

    const u = await gql(`mutation { updateTask(input: { id: "${id}", dueAt: "2026-07-05T09:30:00.000Z", completedAt: "2026-07-05T12:00:00.000Z" }) { success task { dueAt completedAt } } }`);
    expect(u.body.errors).toBeUndefined();
    expect(new Date(u.body.data.updateTask.task.dueAt).toISOString()).toBe('2026-07-05T09:30:00.000Z');
    expect(new Date(u.body.data.updateTask.task.completedAt).toISOString()).toBe('2026-07-05T12:00:00.000Z');
  });

  it('deleteTask soft-cancels + broadcasts', async () => {
    const id = await seed('To delete');
    const m = await gql(`mutation { deleteTask(input: { id: "${id}" }) { success deletedId } }`);
    expect(m.body.data.deleteTask).toEqual({ success: true, deletedId: id });
    const row = sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe('cancelled');
    expect(syncEventCount(SYSTEM_OWNER, 'task:updated')).toBe(1); // soft-delete emits task:updated
  });

  it('createTask with a blank title errors', async () => {
    const m = await gql('mutation { createTask(input: { title: "  " }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/title is required/i);
  });

  it('createTask with a dependency cycle errors', async () => {
    const a = await seed('A');
    const b = await seed('B', SYSTEM_OWNER, { depends_on: [a] });
    // New task depending on b while b depends on a is fine; force a cycle via update instead.
    const upd = await gql(`mutation { updateTask(input: { id: "${a}", dependsOn: ["${b}"] }) { success } }`);
    expect(upd.body.errors?.[0]?.message).toMatch(/dependency cycle/i);
  });
});

describe('W3.3b — owner scoping (cross-owner isolation)', () => {
  it("a second owner's task is invisible to task/tasks and unmutatable", async () => {
    createOwner();
    const mine = await seed('Mine'); // system owner
    const theirs = await seed('Theirs', OTHER); // second owner

    // The other owner sees only their own task.
    const list = await gql('{ tasks { totalCount edges { node { title } } } }', { 'x-test-owner': OTHER });
    expect(list.body.data.tasks.totalCount).toBe(1);
    expect(list.body.data.tasks.edges[0].node.title).toBe('Theirs');

    // The other owner cannot read the system owner's task by id.
    const foreignRead = await gql(`{ task(id: "${mine}") { id } }`, { 'x-test-owner': OTHER });
    expect(foreignRead.body.data.task).toBeNull();

    // ...nor mutate it (updateTask/deleteTask 404 as not_found, no mutation).
    const foreignUpd = await gql(`mutation { updateTask(input: { id: "${mine}", title: "Hijacked" }) { success } }`, { 'x-test-owner': OTHER });
    expect(foreignUpd.body.errors?.[0]?.message).toMatch(/not found/i);
    expect((sqlite.prepare(`SELECT title FROM tasks WHERE id = ?`).get(mine) as { title: string }).title).toBe('Mine');

    const foreignDel = await gql(`mutation { deleteTask(input: { id: "${mine}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(foreignDel.body.errors?.[0]?.message).toMatch(/not found/i);
    expect((sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(mine) as { status: string }).status).toBe('open');

    // The system owner, meanwhile, cannot see the other owner's task.
    const mineList = await gql('{ tasks { totalCount } }');
    expect(mineList.body.data.tasks.totalCount).toBe(1);
    void theirs;
  });
});
