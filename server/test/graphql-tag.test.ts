import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createTag as svcCreateTag, setTagDirections, setEntityTagIds } from '../src/services/tags.js';

/**
 * Phase W step 2 — TagType (Decision 6). Proves the pilot end-to-end over HTTP: the
 * `tag`/`tags` queries with Relay cursor pagination, the hierarchy connections
 * (parentDirections ↔ childIntentions), the CRUD mutations reusing the SAME services the
 * REST routes use (cross-checked via REST GET), owner-scoping, and CI-Server
 * diff-comparability of the shared TagType core.
 */
let srv: TestServer;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

/** Seed a tag for the system owner via the shared service; returns its id. */
function seed(name: string, kind: 'direction' | 'intention' | 'category' = 'intention'): string {
  const res = svcCreateTag(SYSTEM_OWNER, { name, kind });
  if (!res.ok) throw new Error('seed failed');
  return res.tag.id;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('W2 — TagType queries', () => {
  it('tags connection: kind mapped, ordered by name, cursor-paginated', async () => {
    seed('alpha'); seed('beta'); seed('gamma');
    const page1 = await gql('{ tags(first: 2) { totalCount edges { cursor node { label kind } } pageInfo { hasNextPage endCursor } } }');
    expect(page1.body.errors).toBeUndefined();
    const c = page1.body.data.tags;
    expect(c.totalCount).toBe(3);
    expect(c.edges.map((e: any) => e.node.label)).toEqual(['alpha', 'beta']);
    expect(c.edges[0].node.kind).toBe('INTENTION');
    expect(c.pageInfo.hasNextPage).toBe(true);

    const page2 = await gql(`{ tags(first: 2, after: "${c.pageInfo.endCursor}") { edges { node { label } } pageInfo { hasNextPage } } }`);
    expect(page2.body.data.tags.edges.map((e: any) => e.node.label)).toEqual(['gamma']);
    expect(page2.body.data.tags.pageInfo.hasNextPage).toBe(false);
  });

  it('tags(kind:) filters the axis', async () => {
    seed('work', 'direction'); seed('coding', 'intention'); seed('family', 'category');
    const r = await gql('{ tags(kind: DIRECTION) { totalCount edges { node { label kind } } } }');
    expect(r.body.data.tags.totalCount).toBe(1);
    expect(r.body.data.tags.edges[0].node).toEqual({ label: 'work', kind: 'DIRECTION' });
  });

  it('tag(id): label←name, description null, muted/isBase booleans', async () => {
    const id = seed('work', 'direction');
    const r = await gql(`{ tag(id: "${id}") { id label kind description muted isBase } }`);
    expect(r.body.data.tag).toEqual({ id, label: 'work', kind: 'DIRECTION', description: null, muted: false, isBase: false });
  });

  it('tag(id): unknown id returns null', async () => {
    const r = await gql('{ tag(id: "nope") { id } }');
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.tag).toBeNull();
  });

  it('hierarchy: pattern.childIntentions ↔ intention.parentDirections', async () => {
    const work = seed('work', 'direction');
    const coding = seed('coding', 'intention');
    const email = seed('email', 'intention');
    setTagDirections(coding, [work]);
    setTagDirections(email, [work]);

    const children = await gql(`{ tag(id: "${work}") { childIntentions { totalCount edges { node { label kind } } } } }`);
    expect(children.body.data.tag.childIntentions.totalCount).toBe(2);
    expect(children.body.data.tag.childIntentions.edges.map((e: any) => e.node.label)).toEqual(['coding', 'email']);
    expect(children.body.data.tag.childIntentions.edges[0].node.kind).toBe('INTENTION');

    const parents = await gql(`{ tag(id: "${coding}") { parentDirections { totalCount edges { node { label } } } } }`);
    expect(parents.body.data.tag.parentDirections.totalCount).toBe(1);
    expect(parents.body.data.tag.parentDirections.edges[0].node.label).toBe('work');
  });

  it('hierarchy edges are empty for the wrong kind (no error)', async () => {
    const coding = seed('coding', 'intention');
    // An intention has no childIntentions.
    const r = await gql(`{ tag(id: "${coding}") { childIntentions { totalCount edges { node { id } } } } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.tag.childIntentions).toEqual({ totalCount: 0, edges: [] });
  });
});

describe('W2 — TagType mutations reuse the REST services', () => {
  it('createTag is visible via REST GET (shared createTag service)', async () => {
    const m = await gql('mutation { createTag(input: { label: "focus", kind: INTENTION }) { success tag { label kind } } }');
    expect(m.body.data.createTag.success).toBe(true);
    expect(m.body.data.createTag.tag).toEqual({ label: 'focus', kind: 'INTENTION' });
    // The REST list endpoint sees it — same underlying tag row (no separate store).
    const rest = await api(srv.url, '/api/tags');
    expect((rest.body as { tags: { name: string }[] }).tags.some((t) => t.name === 'focus')).toBe(true);
  });

  it('updateTag renames + mutes', async () => {
    const id = seed('old');
    const m = await gql(`mutation { updateTag(input: { id: "${id}", label: "renamed", muted: true }) { success tag { label muted } } }`);
    expect(m.body.data.updateTag).toEqual({ success: true, tag: { label: 'renamed', muted: true } });
  });

  it('deleteTag removes an unused tag', async () => {
    const id = seed('temp');
    const m = await gql(`mutation { deleteTag(input: { id: "${id}" }) { success deletedId } }`);
    expect(m.body.data.deleteTag).toEqual({ success: true, deletedId: id });
    const after = await gql(`{ tag(id: "${id}") { id } }`);
    expect(after.body.data.tag).toBeNull();
  });

  it('deleteTag refuses a base tag and an in-use tag (shared guards)', async () => {
    // Base tag.
    const baseId = sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, 'home', 'direction', 1) RETURNING id`).get(SYSTEM_OWNER) as { id: string };
    const baseDel = await gql(`mutation { deleteTag(input: { id: "${baseId.id}" }) { success } }`);
    expect(baseDel.body.errors?.[0]?.message).toMatch(/base tags cannot be deleted/i);

    // In-use tag (applied to a task via entity_tags).
    const usedId = seed('used');
    setEntityTagIds('task', 'task-x', [usedId]);
    const usedDel = await gql(`mutation { deleteTag(input: { id: "${usedId}" }) { success } }`);
    expect(usedDel.body.errors?.[0]?.message).toMatch(/in use/i);
  });

  it('createTag with a blank label errors', async () => {
    const m = await gql('mutation { createTag(input: { label: "  " }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/name is required/i);
  });
});

describe('W2 — owner scoping', () => {
  it('tags/tag only see the current owner', async () => {
    const mine = seed('mine'); // system owner
    // A different owner (test-mode x-test-owner) sees none of the system owner's tags.
    const other = await gql('{ tags { totalCount } }', { 'x-test-owner': '00000000-0000-7000-8000-0000000000b2' });
    expect(other.body.data.tags.totalCount).toBe(0);
    const otherTag = await gql(`{ tag(id: "${mine}") { id } }`, { 'x-test-owner': '00000000-0000-7000-8000-0000000000b2' });
    expect(otherTag.body.data.tag).toBeNull(); // cross-owner id lookup is scoped out
  });
});

describe('W2 — CI-Server diff-comparability', () => {
  it('TagType exposes the CI-Server core (id, label, description) as a superset', async () => {
    const r = await gql('{ __type(name: "TagType") { fields { name } } }');
    const fields = (r.body.data.__type.fields as { name: string }[]).map((f) => f.name);
    // CI-Server's TagType core:
    for (const core of ['id', 'label', 'description']) expect(fields).toContain(core);
    // Our additive superset:
    for (const extra of ['kind', 'muted', 'isBase', 'parentDirections', 'childIntentions']) expect(fields).toContain(extra);
  });
});
