import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W — BlockTemplateType end-to-end over HTTP. Proves the `blockTemplates`/
 * `blockTemplate` queries + create/update/delete mutations reuse the SAME
 * services/block-templates.ts the REST routes use (cross-checked via REST GET), the
 * `tasks` JSON field, error mapping (blank name, unknown id), SSE parity (a mutation
 * fires block_template:*), and cross-owner isolation.
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

function insertTemplate(name: string, owner = OWNER, tag: string | null = null, defaultMinutes = 60, tasks: unknown[] | null = null): string {
  return (sqlite
    .prepare(`INSERT INTO block_templates (id, owner_id, name, tag, default_minutes, tasks) VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING id`)
    .get(owner, name, tag, defaultMinutes, tasks ? JSON.stringify(tasks) : null) as { id: string }).id;
}
function syncEventCount(owner: string, event: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE owner_id = ? AND event = ?`).get(owner, event) as { n: number }).n;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('BlockTemplateType — queries', () => {
  it('lists the owner\'s templates (by name) with the tasks JSON resolved', async () => {
    insertTemplate('Zeta');
    insertTemplate('Alpha', OWNER, 'work', 90, [{ title: 'Warm up', tag: null, estimated_minutes: 15, offset_minutes: 0 }]);

    const r = await gql('{ blockTemplates { id name tag defaultMinutes tasks } }');
    expect(r.body.errors).toBeUndefined();
    const bt = r.body.data.blockTemplates;
    expect(bt).toHaveLength(2);
    expect(bt.map((t: any) => t.name)).toEqual(['Alpha', 'Zeta']); // name order
    expect(bt[0]).toMatchObject({ name: 'Alpha', tag: 'work', defaultMinutes: 90 });
    expect(bt[0].tasks).toEqual([{ title: 'Warm up', tag: null, estimated_minutes: 15, offset_minutes: 0 }]);
    expect(bt[1].tasks).toEqual([]); // no tasks → [] not null
  });

  it('blockTemplate(id) fetches one; unknown id is null', async () => {
    const id = insertTemplate('Solo');
    const r = await gql(`{ blockTemplate(id: "${id}") { id name } }`);
    expect(r.body.data.blockTemplate).toEqual({ id, name: 'Solo' });
    const miss = await gql('{ blockTemplate(id: "nope") { id } }');
    expect(miss.body.data.blockTemplate).toBeNull();
  });

  it('blockTemplates is empty when the owner has none', async () => {
    const r = await gql('{ blockTemplates { id } }');
    expect(r.body.data.blockTemplates).toEqual([]);
  });
});

describe('BlockTemplateType — mutations reuse the REST service', () => {
  it('createBlockTemplate persists, is visible via REST GET (shared service) + fires SSE', async () => {
    const before = syncEventCount(OWNER, 'block_template:created');
    const m = await gql(
      `mutation { createBlockTemplate(input: { name: "Gym", tag: "health", defaultMinutes: 120, tasks: [{ title: "Lift", estimatedMinutes: 45, offsetMinutes: 20 }] }) { success blockTemplate { id name tag defaultMinutes tasks } } }`,
    );
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createBlockTemplate).toMatchObject({ success: true });
    const created = m.body.data.createBlockTemplate.blockTemplate;
    expect(created).toMatchObject({ name: 'Gym', tag: 'health', defaultMinutes: 120 });
    expect(created.tasks).toEqual([{ title: 'Lift', tag: null, estimated_minutes: 45, offset_minutes: 20 }]);

    // REST sees the same row (one store).
    const rest = await api(srv.url, '/api/block-templates');
    expect(rest.body.block_templates.map((x: any) => x.id)).toContain(created.id);
    const restRow = rest.body.block_templates.find((x: any) => x.id === created.id);
    expect(restRow).toMatchObject({ name: 'Gym', tag: 'health', default_minutes: 120 });
    expect(syncEventCount(OWNER, 'block_template:created')).toBe(before + 1);
  });

  it('createBlockTemplate defaults defaultMinutes to 60 and tasks to []', async () => {
    const m = await gql('mutation { createBlockTemplate(input: { name: "Bare" }) { blockTemplate { defaultMinutes tasks tag } } }');
    expect(m.body.data.createBlockTemplate.blockTemplate).toEqual({ defaultMinutes: 60, tasks: [], tag: null });
  });

  it('updateBlockTemplate patches name/tag/defaultMinutes (only sent keys) + fires SSE', async () => {
    const id = insertTemplate('Old', OWNER, 'work', 60);
    const before = syncEventCount(OWNER, 'block_template:updated');
    const m = await gql(`mutation { updateBlockTemplate(input: { id: "${id}", name: "New", defaultMinutes: 45 }) { success blockTemplate { name tag defaultMinutes } } }`);
    expect(m.body.data.updateBlockTemplate.success).toBe(true);
    // tag preserved (not sent); name + minutes updated.
    expect(m.body.data.updateBlockTemplate.blockTemplate).toEqual({ name: 'New', tag: 'work', defaultMinutes: 45 });
    expect(syncEventCount(OWNER, 'block_template:updated')).toBe(before + 1);
  });

  it('updateBlockTemplate can clear the tag (explicit null)', async () => {
    const id = insertTemplate('Tagged', OWNER, 'work');
    const m = await gql(`mutation { updateBlockTemplate(input: { id: "${id}", tag: null }) { blockTemplate { tag } } }`);
    expect(m.body.data.updateBlockTemplate.blockTemplate.tag).toBeNull();
  });

  it('deleteBlockTemplate removes the row + fires SSE', async () => {
    const id = insertTemplate('Doomed');
    const before = syncEventCount(OWNER, 'block_template:deleted');
    const m = await gql(`mutation { deleteBlockTemplate(input: { id: "${id}" }) { success deletedId } }`);
    expect(m.body.data.deleteBlockTemplate).toEqual({ success: true, deletedId: id });
    expect((await gql('{ blockTemplates { id } }')).body.data.blockTemplates).toEqual([]);
    expect(syncEventCount(OWNER, 'block_template:deleted')).toBe(before + 1);
  });
});

describe('BlockTemplateType — error mapping', () => {
  it('createBlockTemplate rejects a blank name', async () => {
    const m = await gql('mutation { createBlockTemplate(input: { name: "   " }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/name is required/i);
  });

  it('updateBlockTemplate 404s an unknown id', async () => {
    const m = await gql('mutation { updateBlockTemplate(input: { id: "nope", name: "X" }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/not found/i);
  });

  it('updateBlockTemplate rejects blanking the name', async () => {
    const id = insertTemplate('Keep');
    const m = await gql(`mutation { updateBlockTemplate(input: { id: "${id}", name: "  " }) { success } }`);
    expect(m.body.errors?.[0]?.message).toMatch(/name is required/i);
  });

  it('deleteBlockTemplate 404s an unknown id', async () => {
    const m = await gql('mutation { deleteBlockTemplate(input: { id: "nope" }) { success } }');
    expect(m.body.errors?.[0]?.message).toMatch(/not found/i);
  });
});

describe('BlockTemplateType — owner scoping', () => {
  it('another owner cannot see, update, or delete this owner\'s template', async () => {
    createOwner(OTHER);
    const mine = insertTemplate('Mine', OWNER);

    // Owner B's list is empty and fetching owner A's id by id is null (cross-owner invisible).
    const otherList = await gql('{ blockTemplates { id } }', { 'x-test-owner': OTHER });
    expect(otherList.body.data.blockTemplates).toEqual([]);
    const otherGet = await gql(`{ blockTemplate(id: "${mine}") { id } }`, { 'x-test-owner': OTHER });
    expect(otherGet.body.data.blockTemplate).toBeNull();

    // Owner B updating/deleting owner A's template 404s (cross-owner invisible).
    const upd = await gql(`mutation { updateBlockTemplate(input: { id: "${mine}", name: "Hijack" }) { success } }`, { 'x-test-owner': OTHER });
    expect(upd.body.errors?.[0]?.message).toMatch(/not found/i);
    const del = await gql(`mutation { deleteBlockTemplate(input: { id: "${mine}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(del.body.errors?.[0]?.message).toMatch(/not found/i);

    // Owner A still sees their template, untouched.
    const a = await gql('{ blockTemplates { id name } }');
    expect(a.body.data.blockTemplates).toEqual([{ id: mine, name: 'Mine' }]);
  });

  it('two owners\' templates never bleed into each other\'s list', async () => {
    createOwner(OTHER);
    insertTemplate('A-one', OWNER);
    insertTemplate('B-one', OTHER);
    insertTemplate('B-two', OTHER);

    expect((await gql('{ blockTemplates { name } }')).body.data.blockTemplates).toEqual([{ name: 'A-one' }]);
    const b = await gql('{ blockTemplates { name } }', { 'x-test-owner': OTHER });
    expect(b.body.data.blockTemplates.map((t: any) => t.name)).toEqual(['B-one', 'B-two']);
  });
});
