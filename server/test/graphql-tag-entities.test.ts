import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createTag as svcCreateTag, setEntityTagIds, syncLeveledEntityTags } from '../src/services/tags.js';
import { createTask as svcCreateTask } from '../src/services/tasks.js';
import { createBlock as svcCreateBlock } from '../src/services/blocks.js';

/**
 * Phase W · W4b — TagType.entities reverse edge + the TaggedEntity (Task ∪ TimeBlock)
 * union, end-to-end over HTTP. Covers: the union resolving both concrete types, the
 * `kind` filter, Relay (entity_kind, entity_id) cursor pagination, multi-level dedup,
 * routine-kind exclusion (RoutineType doesn't exist yet), and — the load-bearing lens
 * for this phase — owner-scoping: a tag can't surface another owner's entity even when
 * an entity_tags row points across the boundary.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

const pad = (n: number) => String(n).padStart(2, '0');
function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const T0 = isoDay(0);
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

/** Create/resolve a tag for an owner; returns its id. */
function tag(name: string, owner = OWNER): string {
  const res = svcCreateTag(owner, { name, kind: 'intention' });
  if (!res.ok) throw new Error('tag seed failed');
  return res.tag.id;
}
async function seedTask(title: string, tags: string[], owner = OWNER): Promise<string> {
  const res = await svcCreateTask(owner, { title, tags });
  if (!res.ok) throw new Error(`task seed failed: ${res.error}`);
  return res.task.id;
}
async function seedBlock(title: string, tagName: string, owner = OWNER): Promise<string> {
  const res = await svcCreateBlock(owner, { title, start_at: at(T0, '10:00'), end_at: at(T0, '11:00'), tag: tagName });
  if (!res.ok) throw new Error(`block seed failed: ${res.error}`);
  return res.block.id;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

const ENTITIES = `
  entities { totalCount edges { cursor node {
    __typename
    ... on TaskType { id title }
    ... on TimeBlockType { id title }
  } } }
`;

describe('W4b — TagType.entities reverse edge', () => {
  it('returns both a Task and a TimeBlock tagged with the tag (union resolves each type)', async () => {
    const focus = tag('focus');
    const taskId = await seedTask('Write report', ['focus']);
    const blockId = await seedBlock('Deep work', 'focus');

    const r = await gql(`{ tag(id: "${focus}") { ${ENTITIES} } }`);
    expect(r.body.errors).toBeUndefined();
    const conn = r.body.data.tag.entities;
    expect(conn.totalCount).toBe(2);
    const byType = new Map(conn.edges.map((e: any) => [e.node.__typename, e.node]));
    expect(byType.get('TaskType')).toMatchObject({ id: taskId, title: 'Write report' });
    expect(byType.get('TimeBlockType')).toMatchObject({ id: blockId, title: 'Deep work' });
  });

  it('kind filter narrows to one entity type', async () => {
    const focus = tag('focus');
    const taskId = await seedTask('T', ['focus']);
    const blockId = await seedBlock('B', 'focus');

    const tasksOnly = await gql(`{ tag(id: "${focus}") { entities(kind: TASK) { totalCount edges { node { ... on TaskType { id } } } } } }`);
    expect(tasksOnly.body.data.tag.entities.totalCount).toBe(1);
    expect(tasksOnly.body.data.tag.entities.edges[0].node.id).toBe(taskId);

    const blocksOnly = await gql(`{ tag(id: "${focus}") { entities(kind: TIME_BLOCK) { totalCount edges { node { ... on TimeBlockType { id } } } } } }`);
    expect(blocksOnly.body.data.tag.entities.totalCount).toBe(1);
    expect(blocksOnly.body.data.tag.entities.edges[0].node.id).toBe(blockId);
  });

  it('paginates on the (kind, id) keyset', async () => {
    const focus = tag('focus');
    // Two tasks + one block → 'task' rows sort before 'time_block'.
    await seedTask('T1', ['focus']);
    await seedTask('T2', ['focus']);
    await seedBlock('B1', 'focus');

    const page1 = await gql(`{ tag(id: "${focus}") { entities(first: 2) { totalCount edges { cursor node { __typename } } pageInfo { hasNextPage endCursor } } } }`);
    const c1 = page1.body.data.tag.entities;
    expect(c1.totalCount).toBe(3);
    expect(c1.edges.map((e: any) => e.node.__typename)).toEqual(['TaskType', 'TaskType']);
    expect(c1.pageInfo.hasNextPage).toBe(true);

    const page2 = await gql(`{ tag(id: "${focus}") { entities(first: 2, after: "${c1.pageInfo.endCursor}") { edges { node { __typename } } pageInfo { hasNextPage } } } }`);
    const c2 = page2.body.data.tag.entities;
    expect(c2.edges.map((e: any) => e.node.__typename)).toEqual(['TimeBlockType']);
    expect(c2.pageInfo.hasNextPage).toBe(false);
  });

  it('dedups an entity tagged at multiple levels (UNION collapse)', async () => {
    const focus = tag('focus');
    const taskId = await seedTask('T', []);
    // Same tag id applied at level 1 AND level 2 to the one task.
    syncLeveledEntityTags('task', taskId, [{ level: 1, names: ['focus'] }, { level: 2, names: ['focus'] }], OWNER);

    const r = await gql(`{ tag(id: "${focus}") { entities { totalCount edges { node { ... on TaskType { id } } } } } }`);
    expect(r.body.data.tag.entities.totalCount).toBe(1);
    expect(r.body.data.tag.entities.edges).toHaveLength(1);
    expect(r.body.data.tag.entities.edges[0].node.id).toBe(taskId);
  });

  it('excludes routine-kind associations (no RoutineType until W6)', async () => {
    const focus = tag('focus');
    const taskId = await seedTask('T', ['focus']);
    // A routine-tagged row (entity_kind='routine') must never surface in this union.
    setEntityTagIds('routine', 'routine-x', [focus]);

    const r = await gql(`{ tag(id: "${focus}") { entities { totalCount edges { node { ... on TaskType { id } } } } } }`);
    expect(r.body.data.tag.entities.totalCount).toBe(1);
    expect(r.body.data.tag.entities.edges[0].node.id).toBe(taskId);
  });

  it('empty when the tag has no entities', async () => {
    const lonely = tag('lonely');
    const r = await gql(`{ tag(id: "${lonely}") { entities { totalCount edges { cursor } pageInfo { hasNextPage endCursor } } } }`);
    expect(r.body.data.tag.entities).toEqual({ totalCount: 0, edges: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });
});

describe('W4b — owner scoping', () => {
  it('does NOT surface another owner\'s entity even when an entity_tags row crosses the boundary', async () => {
    createOwner(OTHER);
    const focus = tag('focus', OWNER);              // owner A's tag
    const mine = await seedTask('Mine', ['focus'], OWNER);
    // Owner B's task, force-linked to owner A's tag id via a raw entity_tags row (the
    // leak the join must block — entity_tags.entity_id has no FK / no owner column).
    const theirs = await seedTask('Theirs', [], OTHER);
    sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(theirs, focus);

    const r = await gql(`{ tag(id: "${focus}") { entities { totalCount edges { node { ... on TaskType { id } } } } } }`);
    expect(r.body.data.tag.entities.totalCount).toBe(1);
    expect(r.body.data.tag.entities.edges[0].node.id).toBe(mine);
    expect(r.body.data.tag.entities.edges.map((e: any) => e.node.id)).not.toContain(theirs);
  });

  it('a cross-owner tag id is invisible (entities never reached — tag resolves null)', async () => {
    const focus = tag('focus', OWNER);
    await seedTask('Mine', ['focus'], OWNER);
    const r = await gql(`{ tag(id: "${focus}") { entities { totalCount } } }`, { 'x-test-owner': OTHER });
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.tag).toBeNull();
  });
});

describe('W4b — schema shape', () => {
  it('TaggedEntity is a union of TaskType + TimeBlockType', async () => {
    const r = await gql('{ __type(name: "TaggedEntity") { kind possibleTypes { name } } }');
    expect(r.body.data.__type.kind).toBe('UNION');
    expect((r.body.data.__type.possibleTypes as { name: string }[]).map((t) => t.name).sort()).toEqual(['TaskType', 'TimeBlockType']);
  });
});
