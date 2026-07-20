import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { applyOp } from '../src/sync/apply.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * #391 (mig 0133) — per-item colour threading: patterns + objectives round-trip
 * `color_token` through REST create/update (explicit null clears), the objective
 * field syncs (allowlist + camel map), and a backup export → wipe → import
 * preserves both columns with NO backup-code change (SELECT * + column-intersect).
 */
let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => resetDb());

describe('patterns.color_token', () => {
  it('create + update round-trip; explicit null clears back to inherit', async () => {
    const created = await api<{ pattern: { id: string; color_token: string | null } }>(
      srv.url, '/api/patterns', { method: 'POST', json: { name: 'Morning prep', color_token: 'tag-3' } });
    expect(created.status).toBe(201);
    expect(created.body.pattern.color_token).toBe('tag-3');

    const id = created.body.pattern.id;
    const recolored = await api<{ pattern: { color_token: string | null } }>(
      srv.url, `/api/patterns/${id}`, { method: 'PATCH', json: { color_token: 'chart-4' } });
    expect(recolored.body.pattern.color_token).toBe('chart-4');

    // A colour-less PATCH must not touch it (the !== undefined merge idiom)…
    const untouched = await api<{ pattern: { color_token: string | null } }>(
      srv.url, `/api/patterns/${id}`, { method: 'PATCH', json: { notes: 'hi' } });
    expect(untouched.body.pattern.color_token).toBe('chart-4');

    // …and explicit null clears (inherit the type's colour again).
    const cleared = await api<{ pattern: { color_token: string | null } }>(
      srv.url, `/api/patterns/${id}`, { method: 'PATCH', json: { color_token: null } });
    expect(cleared.body.pattern.color_token).toBeNull();
  });
});

describe('objectives.color_token', () => {
  it('create + update round-trip; explicit null clears', async () => {
    const created = await api<{ objective: { id: string; color_token: string | null } }>(
      srv.url, '/api/objectives', { method: 'POST', json: { title: 'Ship it', color_token: 'chart-2' } });
    expect(created.body.objective.color_token).toBe('chart-2');

    const id = created.body.objective.id;
    const cleared = await api<{ objective: { color_token: string | null } }>(
      srv.url, `/api/objectives/${id}`, { method: 'PATCH', json: { color_token: null } });
    expect(cleared.body.objective.color_token).toBeNull();
  });

  it('syncs through applyOp (allowlisted) while derived fields still drop', () => {
    sqlite.prepare(
      `INSERT INTO objectives (id, owner_id, title, level, created_at, updated_at)
       VALUES ('o-color', ?, 'Synced', 'objective', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    ).run(SYSTEM_OWNER);

    const result = applyOp(sqlite, {
      opId: 'op-color-1', entity: 'objective', entityId: 'o-color',
      fields: { color_token: 'tag-7', level: 'goal' },
      baseVersion: 1, clientTs: '2026-07-02T10:00:00.000Z',
    }, SYSTEM_OWNER);

    expect(result.applied).toEqual({ color_token: 'tag-7' }); // level still dropped
    const row = sqlite.prepare(`SELECT color_token, level FROM objectives WHERE id = 'o-color'`).get() as
      { color_token: string | null; level: string };
    expect(row.color_token).toBe('tag-7');
    expect(row.level).toBe('objective');
  });
});

describe('backup round-trip (no backup-code change needed)', () => {
  it('export → wipe → import preserves both colour columns', async () => {
    await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Colored routine', color_token: 'tag-5' } });
    await api(srv.url, '/api/objectives', { method: 'POST', json: { title: 'Colored objective', color_token: 'chart-3' } });

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    resetDb();
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: exp });
    expect(status).toBe(200);

    const p = sqlite.prepare(`SELECT color_token FROM patterns WHERE name = 'Colored routine'`).get() as { color_token: string | null };
    const o = sqlite.prepare(`SELECT color_token FROM objectives WHERE title = 'Colored objective'`).get() as { color_token: string | null };
    expect(p.color_token).toBe('tag-5');
    expect(o.color_token).toBe('chart-3');
  });
});
