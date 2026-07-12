/**
 * AF-8 — "save as template" upserts by name. POST /api/block-templates with
 * `upsert: true` refreshes the owner's existing same-named template (trimmed,
 * case-insensitive match; contents fully replaced) instead of duplicating it;
 * without the flag the historical create-always semantics are byte-identical.
 * Response convention: 201 + `updated: false` (created) vs 200 + `updated: true`
 * (refreshed); the default path carries NO `updated` key. The GraphQL
 * createBlockTemplate mutation is untouched (locked by graphql-block-template.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

const rows = (owner = SYSTEM_OWNER) =>
  sqlite.prepare(`SELECT * FROM block_templates WHERE owner_id = ? ORDER BY name`).all(owner) as
    { id: string; owner_id: string; name: string; tag: string | null; default_minutes: number; tasks: string | null }[];
const syncEventCount = (event: string, owner = SYSTEM_OWNER) =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE owner_id = ? AND event = ?`).get(owner, event) as { n: number }).n;
const post = (json: unknown, headers: Record<string, string> = {}) =>
  api(srv.url, '/api/block-templates', { method: 'POST', json, headers });

describe('POST /api/block-templates with upsert: true', () => {
  it('creates when no same-named template exists (201, updated: false) + fires created SSE', async () => {
    const res = await post({ name: 'Gym morning', tag: 'health', default_minutes: 120, tasks: [{ title: 'Lift', estimated_minutes: 45, offset_minutes: 20 }], upsert: true });
    expect(res.status).toBe(201);
    expect(res.body.updated).toBe(false);
    expect(res.body.block_template).toMatchObject({ name: 'Gym morning', tag: 'health', default_minutes: 120 });
    expect(rows()).toHaveLength(1);
    expect(syncEventCount('block_template:created')).toBe(1);
    expect(syncEventCount('block_template:updated')).toBe(0);
  });

  it('updates the existing same-named template — one row, contents fully replaced (200, updated: true) + fires updated SSE', async () => {
    const first = await post({ name: 'Gym morning', tag: 'health', default_minutes: 120, tasks: [{ title: 'Lift', estimated_minutes: 45, offset_minutes: 20 }], upsert: true });
    const id = first.body.block_template.id;

    const res = await post({ name: 'Gym morning', tag: 'fitness', default_minutes: 90, tasks: [{ title: 'Row', estimated_minutes: 30, offset_minutes: 0 }], upsert: true });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.block_template.id).toBe(id); // same row, refreshed

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, name: 'Gym morning', tag: 'fitness', default_minutes: 90 });
    expect(JSON.parse(all[0].tasks!)).toEqual([{ title: 'Row', estimated_minutes: 30, offset_minutes: 0 }]);
    expect(syncEventCount('block_template:created')).toBe(1);
    expect(syncEventCount('block_template:updated')).toBe(1);
  });

  it('full replace: absent tag/minutes/tasks reset to create defaults (NULL / 60 / no tasks)', async () => {
    await post({ name: 'Deep work', tag: 'focus', default_minutes: 120, tasks: [{ title: 'Plan', estimated_minutes: 10, offset_minutes: 0 }], upsert: true });
    const res = await post({ name: 'Deep work', upsert: true });
    expect(res.status).toBe(200);
    const [row] = rows();
    expect(row).toMatchObject({ tag: null, default_minutes: 60, tasks: null });
    expect(res.body.block_template.tasks).toEqual([]); // serialized payload parity with create
  });

  it('matches case-insensitively and trims whitespace; the stored name keeps its original casing', async () => {
    await post({ name: 'Gym Morning', default_minutes: 120, upsert: true });
    const res = await post({ name: '  gym morning  ', default_minutes: 45, upsert: true });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Gym Morning'); // original casing preserved
    expect(all[0].default_minutes).toBe(45);
  });

  it('different names still create separate templates', async () => {
    await post({ name: 'Morning', upsert: true });
    const res = await post({ name: 'Evening', upsert: true });
    expect(res.status).toBe(201);
    expect(rows().map((r) => r.name)).toEqual(['Evening', 'Morning']);
  });

  it('owner isolation: the same name under two owners yields two rows', async () => {
    createOwner();
    await post({ name: 'Gym morning', default_minutes: 120, upsert: true });
    const res = await post({ name: 'Gym morning', default_minutes: 30, upsert: true }, { 'x-test-owner': SECOND_OWNER_ID });
    expect(res.status).toBe(201); // created for owner B, NOT an update of owner A's
    expect(res.body.updated).toBe(false);
    expect(rows(SYSTEM_OWNER)).toHaveLength(1);
    expect(rows(SECOND_OWNER_ID)).toHaveLength(1);
    expect(rows(SYSTEM_OWNER)[0].default_minutes).toBe(120); // owner A untouched
  });

  it('rejects a blank name exactly like create (422)', async () => {
    const res = await post({ name: '   ', upsert: true });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'name is required' });
    expect(rows()).toHaveLength(0);
  });
});

describe('POST /api/block-templates without the flag — regression', () => {
  it('two same-named POSTs still create two rows (create-always), response shape has no updated key', async () => {
    const a = await post({ name: 'Gym morning', default_minutes: 120 });
    const b = await post({ name: 'Gym morning', default_minutes: 90 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(Object.keys(a.body)).toEqual(['block_template']); // byte-identical shape: no `updated`
    expect(Object.keys(b.body)).toEqual(['block_template']);
    expect(rows()).toHaveLength(2);
    expect(syncEventCount('block_template:created')).toBe(2);
  });

  it('upsert: false behaves like the flag being absent', async () => {
    await post({ name: 'Gym morning', upsert: false });
    const res = await post({ name: 'Gym morning', upsert: false });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['block_template']);
    expect(rows()).toHaveLength(2);
  });
});
