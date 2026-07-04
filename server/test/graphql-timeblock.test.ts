import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createBlock as svcCreateBlock, type CreateBlockInput } from '../src/services/blocks.js';

/**
 * Phase W · W3.3c — TimeBlockType end-to-end over HTTP. Mirrors graphql-task.test.ts:
 * the `timeBlock`/`timeBlocks` queries with Relay id-cursor pagination (incl. recurring
 * instances materializing + templates being dropped), the field resolvers
 * (task/parentBlock/category), the CRUD mutations reusing the SAME services the REST
 * routes use (a mutation fires the same SSE broadcast → a sync_events row), a
 * version-bump assertion proving stampRow moved INTO updateBlock (W3.3c commit 1), and
 * cross-owner isolation (a second owner's block id is invisible + unmutatable).
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

// Anchor to *today* so the lazy recurring materializer (which skips past days) fires.
const pad = (n: number) => String(n).padStart(2, '0');
function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const T0 = isoDay(0), T2 = isoDay(2);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

/** Seed a block for an owner via the shared service; returns its id. */
async function seed(over: Partial<CreateBlockInput> = {}, owner = OWNER): Promise<string> {
  const res = await svcCreateBlock(owner, {
    title: 'Block', start_at: at(T0, '10:00'), end_at: at(T0, '11:00'), ...over,
  });
  if (!res.ok) throw new Error(`seed failed: ${res.error}`);
  return res.block.id;
}

function syncEventCount(owner: string, event: string): number {
  return (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE owner_id = ? AND event = ?`)
    .get(owner, event) as { n: number }).n;
}

/** A category tag for the owner (for the `category` field resolver). */
function makeCategory(owner: string, name: string): string {
  return (sqlite
    .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`)
    .get(owner, name) as { id: string }).id;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});

describe('W3.3c — TimeBlockType queries', () => {
  it('timeBlocks connection: fields mapped, id-ordered, cursor-paginated', async () => {
    // The connection orders by id ascending. uuid7 is time-ordered ACROSS milliseconds
    // but random within a ms (no monotonic counter — see lib/ids.ts), so three blocks
    // seeded in the same ms need not be in creation order. Assert against the id-SORTED
    // expectation, not creation order, or this flakes under full-suite load.
    const ids = [
      await seed({ title: 'Alpha', start_at: at(T0, '09:00'), end_at: at(T0, '10:00') }),
      await seed({ title: 'Beta', start_at: at(T0, '10:00'), end_at: at(T0, '11:00') }),
      await seed({ title: 'Gamma', start_at: at(T0, '11:00'), end_at: at(T0, '12:00') }),
    ];
    const titleById = new Map([[ids[0], 'Alpha'], [ids[1], 'Beta'], [ids[2], 'Gamma']]);
    const sorted = [...ids].sort();

    const range = `from: "${at(T0, '00:00')}", to: "${at(T0, '23:59')}"`;
    const page1 = await gql(`{ timeBlocks(first: 2, ${range}) { totalCount edges { cursor node { id title blockKind status allDay isLocked isAuto } } pageInfo { hasNextPage endCursor } } }`);
    expect(page1.body.errors).toBeUndefined();
    const c = page1.body.data.timeBlocks;
    expect(c.totalCount).toBe(3);
    expect(c.edges.map((e: any) => e.node.id)).toEqual(sorted.slice(0, 2));
    expect(c.edges[0].node).toMatchObject({ title: titleById.get(sorted[0]), blockKind: 'task', status: 'planned', allDay: false, isLocked: false, isAuto: false });
    expect(c.pageInfo.hasNextPage).toBe(true);

    const page2 = await gql(`{ timeBlocks(first: 2, after: "${c.pageInfo.endCursor}", ${range}) { edges { node { id } } pageInfo { hasNextPage } } }`);
    expect(page2.body.data.timeBlocks.edges.map((e: any) => e.node.id)).toEqual(sorted.slice(2));
    expect(page2.body.data.timeBlocks.pageInfo.hasNextPage).toBe(false);
  });

  it('timeBlocks materializes recurring instances and drops the template', async () => {
    // A DAILY recurring container template (rule set, no parent → never rendered).
    const tplId = await seed({
      title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', tag: 'focus',
      start_at: at(T0, '09:00'), end_at: at(T0, '11:00'), recurrence_rule: 'FREQ=DAILY',
    });
    const range = `from: "${at(T0, '00:00')}", to: "${at(T2, '23:59')}"`;
    const r = await gql(`{ timeBlocks(first: 50, ${range}) { totalCount edges { node { id title } } } }`);
    expect(r.body.errors).toBeUndefined();
    const ids = r.body.data.timeBlocks.edges.map((e: any) => e.node.id);
    // 3 materialized instances (T0/T1/T2), template excluded.
    expect(r.body.data.timeBlocks.totalCount).toBe(3);
    expect(ids).not.toContain(tplId);
    expect(r.body.data.timeBlocks.edges.every((e: any) => e.node.title === 'Deep Work')).toBe(true);
  });

  it('timeBlock(id): full field set, DateTime scalars serialize', async () => {
    const id = await seed({ title: 'Solo', note: 'hi', duration_minutes: 45, block_type: 'someday' });
    const r = await gql(`{ timeBlock(id: "${id}") { id title blockKind startAt endAt allDay isLocked isAuto status createdAt note blockType durationMinutes colorToken } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.timeBlock.createdAt).toBeTruthy(); // DateTime! serializes without throwing
    expect(r.body.data.timeBlock).toMatchObject({
      id, title: 'Solo', blockKind: 'task', status: 'planned', allDay: false, isLocked: false,
      isAuto: false, note: 'hi', blockType: 'someday', durationMinutes: 45, colorToken: null,
    });
    // startAt round-trips through the DateTime scalar to a UTC instant.
    expect(new Date(r.body.data.timeBlock.startAt).toISOString()).toBe(at(T0, '10:00'));
  });

  it('timeBlock(id): unknown id returns null', async () => {
    const r = await gql('{ timeBlock(id: "nope") { id } }');
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.timeBlock).toBeNull();
  });
});

describe('W3.3c — TimeBlockType field resolvers', () => {
  it('task → the linked task, else null', async () => {
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'Linked task', 'open') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const withTask = await seed({ title: 'Has task', task_id: taskId });
    const withoutTask = await seed({ title: 'No task' });

    const r = await gql(`{ timeBlock(id: "${withTask}") { task { id title } } }`);
    expect(r.body.data.timeBlock.task).toEqual({ id: taskId, title: 'Linked task' });
    const r2 = await gql(`{ timeBlock(id: "${withoutTask}") { task { id } } }`);
    expect(r2.body.data.timeBlock.task).toBeNull();
  });

  it('parentBlock → the container, else null', async () => {
    const parent = await seed({ title: 'Container', block_kind: 'timeblock', start_at: at(T0, '09:00'), end_at: at(T0, '12:00') });
    const child = await seed({ title: 'Member' });
    sqlite.prepare(`UPDATE time_blocks SET parent_block_id = ? WHERE id = ?`).run(parent, child);

    const r = await gql(`{ timeBlock(id: "${child}") { parentBlock { id title } } }`);
    expect(r.body.data.timeBlock.parentBlock).toEqual({ id: parent, title: 'Container' });
    const r2 = await gql(`{ timeBlock(id: "${parent}") { parentBlock { id } } }`);
    expect(r2.body.data.timeBlock.parentBlock).toBeNull();
  });

  it('category → the TagType, else null', async () => {
    const catId = makeCategory(OWNER, 'Deep Focus');
    const withCat = await seed({ title: 'Categorized', category_id: catId });
    const withoutCat = await seed({ title: 'Uncategorized' });

    const r = await gql(`{ timeBlock(id: "${withCat}") { category { id label kind muted isBase } } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.timeBlock.category).toMatchObject({ id: catId, label: 'Deep Focus', kind: 'CATEGORY', muted: false });
    const r2 = await gql(`{ timeBlock(id: "${withoutCat}") { category { id } } }`);
    expect(r2.body.data.timeBlock.category).toBeNull();
  });
});

describe('W3.3c — TimeBlockType mutations reuse the REST services + fire SSE', () => {
  it('createTimeBlock persists (visible via query) + broadcasts block:created', async () => {
    const m = await gql(`mutation { createTimeBlock(input: { title: "Made in GraphQL", startAt: "${at(T0, '13:00')}", endAt: "${at(T0, '14:00')}", tag: "gq" }) { success timeBlock { id title } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createTimeBlock.success).toBe(true);
    const id = m.body.data.createTimeBlock.timeBlock.id;
    expect(m.body.data.createTimeBlock.timeBlock.title).toBe('Made in GraphQL');
    // Same underlying row — the query sees it.
    const q = await gql(`{ timeBlock(id: "${id}") { title } }`);
    expect(q.body.data.timeBlock.title).toBe('Made in GraphQL');
    expect(syncEventCount(OWNER, 'block:created')).toBe(1);
  });

  it('createTimeBlock rejects tag + category together', async () => {
    const catId = makeCategory(OWNER, 'Work');
    const m = await gql(`mutation { createTimeBlock(input: { title: "X", startAt: "${at(T0, '13:00')}", endAt: "${at(T0, '14:00')}", tag: "work", categoryId: "${catId}" }) { success } }`);
    expect(m.body.errors?.[0]?.message).toMatch(/not both/i);
  });

  it('updateTimeBlock edits columns + versions (stampRow now in service) + broadcasts', async () => {
    const id = await seed({ title: 'To edit' });
    const before = sqlite.prepare(`SELECT version FROM time_blocks WHERE id = ?`).get(id) as { version: number };
    const m = await gql(`mutation { updateTimeBlock(input: { id: "${id}", title: "Edited", isLocked: true }) { success timeBlock { title isLocked } } }`);
    expect(m.body.data.updateTimeBlock).toEqual({ success: true, timeBlock: { title: 'Edited', isLocked: true } });
    const after = sqlite.prepare(`SELECT version, field_ts FROM time_blocks WHERE id = ?`).get(id) as { version: number; field_ts: string | null };
    expect(after.version).toBe(before.version + 1); // Phase-L stamp fired INSIDE updateBlock
    expect(JSON.parse(after.field_ts ?? '{}')).toHaveProperty('title');
    expect(syncEventCount(OWNER, 'block:updated')).toBe(1);
  });

  it('updateTimeBlock on an unknown id errors NOT_FOUND', async () => {
    const m = await gql('mutation { updateTimeBlock(input: { id: "ghost", title: "x" }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/not found/i);
  });

  it('updateTimeBlock rejects explicit null on a non-nullable field (isLocked) but accepts false', async () => {
    const id = await seed({ title: 'Toggle', start_at: at(T0, '09:00'), end_at: at(T0, '10:00'), is_locked: true });
    // Explicit null on a non-nullable column errors (not a silent no-op).
    const bad = await gql(`mutation { updateTimeBlock(input: { id: "${id}", isLocked: null }) { success } }`);
    expect(bad.body.errors?.[0]?.message).toMatch(/isLocked cannot be null/i);
    expect((sqlite.prepare(`SELECT is_locked FROM time_blocks WHERE id = ?`).get(id) as { is_locked: number }).is_locked).toBe(1); // unchanged
    // `false` is a legitimate value and still works.
    const ok = await gql(`mutation { updateTimeBlock(input: { id: "${id}", isLocked: false }) { success timeBlock { isLocked } } }`);
    expect(ok.body.data.updateTimeBlock).toEqual({ success: true, timeBlock: { isLocked: false } });
  });

  it('updateTimeBlock rejects a title/time edit on an inbound-mirrored block (read-only)', async () => {
    const id = await seed({ title: 'Standup' });
    sqlite.prepare(`INSERT INTO external_events (owner_id, block_id, direction, provider, account, external_id) VALUES (?, ?, 'inbound', 'google', 'me@example.com', 'evt-1')`).run(OWNER, id);
    const m = await gql(`mutation { updateTimeBlock(input: { id: "${id}", title: "Hijacked" }) { success } }`);
    expect(m.body.errors?.[0]?.message).toMatch(/read-only/i);
    expect((sqlite.prepare(`SELECT title FROM time_blocks WHERE id = ?`).get(id) as { title: string }).title).toBe('Standup');
  });

  it('moveBlockGroup shifts the block + broadcasts', async () => {
    const id = await seed({ title: 'Move me', start_at: at(T0, '10:00'), end_at: at(T0, '11:00') });
    const m = await gql(`mutation { moveBlockGroup(input: { id: "${id}", deltaMinutes: 30 }) { success parentId timeBlocks { id startAt } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.moveBlockGroup.success).toBe(true);
    expect(m.body.data.moveBlockGroup.timeBlocks).toHaveLength(1);
    expect(new Date(m.body.data.moveBlockGroup.timeBlocks[0].startAt).toISOString()).toBe(at(T0, '10:30'));
    expect(syncEventCount(OWNER, 'block:updated')).toBe(1);
  });

  it('promoteBlockToScheduled turns a concept into a scheduled plan + broadcasts', async () => {
    const id = await seed({ title: 'Concept', block_type: 'someday', duration_minutes: 30 });
    const m = await gql(`mutation { promoteBlockToScheduled(input: { id: "${id}", startAt: "${at(T0, '14:00')}" }) { success timeBlock { blockType startAt endAt } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.promoteBlockToScheduled.timeBlock.blockType).toBe('scheduled');
    expect(new Date(m.body.data.promoteBlockToScheduled.timeBlock.endAt).toISOString()).toBe(at(T0, '14:30'));
    expect(syncEventCount(OWNER, 'block:updated')).toBe(1);
  });

  it('deleteTimeBlock removes the block + broadcasts block:deleted', async () => {
    const id = await seed({ title: 'To delete' });
    const m = await gql(`mutation { deleteTimeBlock(input: { id: "${id}" }) { success deletedId } }`);
    expect(m.body.data.deleteTimeBlock).toEqual({ success: true, deletedId: id });
    expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(id)).toBeFalsy();
    expect(syncEventCount(OWNER, 'block:deleted')).toBe(1);
  });

  it('deleteTimeBlock reverts a placed task to open (task:updated)', async () => {
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status, estimated_minutes) VALUES (uuid7(), ?, 'Placed', 'open', 30) RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const id = await seed({ title: 'Placement', task_id: taskId, start_at: at(T0, '09:00'), end_at: at(T0, '09:30') });
    // create synced the task to scheduled; deleting the block reverts it.
    const m = await gql(`mutation { deleteTimeBlock(input: { id: "${id}" }) { success } }`);
    expect(m.body.data.deleteTimeBlock.success).toBe(true);
    expect((sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status).toBe('open');
    expect(syncEventCount(OWNER, 'task:updated')).toBeGreaterThanOrEqual(1);
  });
});

describe('W3.3c — owner scoping (cross-owner isolation)', () => {
  it("a second owner's block is invisible to timeBlock/timeBlocks and unmutatable", async () => {
    createOwner();
    const mine = await seed({ title: 'Mine' }); // system owner
    const theirs = await seed({ title: 'Theirs' }, OTHER); // second owner

    const range = `from: "${at(T0, '00:00')}", to: "${at(T0, '23:59')}"`;

    // The other owner sees only their own block.
    const list = await gql(`{ timeBlocks(${range}) { totalCount edges { node { id title } } } }`, { 'x-test-owner': OTHER });
    expect(list.body.data.timeBlocks.totalCount).toBe(1);
    expect(list.body.data.timeBlocks.edges[0].node.title).toBe('Theirs');
    expect(list.body.data.timeBlocks.edges.map((e: any) => e.node.id)).not.toContain(mine);

    // The other owner cannot read the system owner's block by id.
    const foreignRead = await gql(`{ timeBlock(id: "${mine}") { id } }`, { 'x-test-owner': OTHER });
    expect(foreignRead.body.data.timeBlock).toBeNull();

    // ...nor update/delete/move/promote it — each errors not_found, foreign row unchanged.
    const foreignUpd = await gql(`mutation { updateTimeBlock(input: { id: "${mine}", title: "Hijacked" }) { success } }`, { 'x-test-owner': OTHER });
    expect(foreignUpd.body.errors?.[0]?.message).toMatch(/not found/i);
    expect((sqlite.prepare(`SELECT title FROM time_blocks WHERE id = ?`).get(mine) as { title: string }).title).toBe('Mine');

    const foreignMove = await gql(`mutation { moveBlockGroup(input: { id: "${mine}", deltaMinutes: 30 }) { success } }`, { 'x-test-owner': OTHER });
    expect(foreignMove.body.errors?.[0]?.message).toMatch(/not found/i);
    expect((sqlite.prepare(`SELECT start_at FROM time_blocks WHERE id = ?`).get(mine) as { start_at: string }).start_at).toBe(at(T0, '10:00'));

    const foreignPromote = await gql(`mutation { promoteBlockToScheduled(input: { id: "${mine}", startAt: "${at(T0, '14:00')}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(foreignPromote.body.errors?.[0]?.message).toMatch(/not found/i);

    const foreignDel = await gql(`mutation { deleteTimeBlock(input: { id: "${mine}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(foreignDel.body.errors?.[0]?.message).toMatch(/not found/i);
    expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(mine)).toBeTruthy(); // never deleted

    // The system owner, meanwhile, cannot see the other owner's block.
    const mineList = await gql(`{ timeBlocks(${range}) { totalCount } }`);
    expect(mineList.body.data.timeBlocks.totalCount).toBe(1);
    void theirs;
  });
});
