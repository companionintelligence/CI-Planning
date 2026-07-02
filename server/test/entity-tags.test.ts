import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { syncEntityTags, normalizeTagName } from '../src/services/tags.js';

/**
 * CON-3 — the normalized `entity_tags` store, now the SOLE task-tag store
 * (`task_tags` dropped in migration 0041). Two gates:
 *  1. write paths keep entity_tags in sync (replace semantics) for tasks/blocks/routines;
 *  2. **no orphans** — every HARD delete of a tagged entity clears its rows.
 * (The 0033 task→entity backfill is exercised by the migration runner, not here —
 * it reads task_tags, which no longer exists in the live schema.)
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

const tagRows = (kind: string, id: string) =>
  (sqlite
    .prepare(`SELECT t.name FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_kind = ? AND et.entity_id = ? ORDER BY t.name`)
    .all(kind, id) as { name: string }[]).map((r) => r.name);

/** App-enforced integrity gate: zero entity_tags rows pointing at a missing entity. */
function orphanCount(): number {
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM entity_tags et WHERE
           (et.entity_kind = 'task'       AND NOT EXISTS (SELECT 1 FROM tasks       WHERE id = et.entity_id)) OR
           (et.entity_kind = 'time_block' AND NOT EXISTS (SELECT 1 FROM time_blocks WHERE id = et.entity_id)) OR
           (et.entity_kind = 'routine'    AND NOT EXISTS (SELECT 1 FROM patterns    WHERE id = et.entity_id))`,
      )
      .get() as { c: number }
  ).c;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM pattern_tasks; DELETE FROM patterns;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});

describe('CON-3 normalizeTagName', () => {
  it('trims, strips a leading #, lowercases, dashes spaces, caps at 32', () => {
    expect(normalizeTagName('  #Deep Work  ')).toBe('deep-work');
    expect(normalizeTagName('WORK')).toBe('work');
    expect(normalizeTagName('a'.repeat(40))).toHaveLength(32);
  });
});

describe('CON-3 write-sync (through the routes)', () => {
  it('task create + tag-replace keeps entity_tags correct (the sole task-tag store)', async () => {
    const created = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Tagged', tags: ['Work', 'Errands'] } });
    const id = created.body.task.id as string;
    expect(tagRows('task', id).sort()).toEqual(['errands', 'work']);

    // PATCH replaces the set; entity_tags follows (replace, not append).
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { tags: ['focus'] } });
    expect(tagRows('task', id)).toEqual(['focus']);
    // clearing to empty clears the mirror.
    await api(srv.url, `/api/tasks/${id}`, { method: 'PATCH', json: { tags: [] } });
    expect(tagRows('task', id)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });

  it('block create/update syncs the comma-split tag string; null clears it', async () => {
    const created = await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'Plan', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work, deep', start_at: at('09:00'), end_at: at('11:00') } });
    const id = created.body.block.id as string;
    expect(tagRows('time_block', id)).toEqual(['deep', 'work']);
    await api(srv.url, `/api/blocks/${id}`, { method: 'PATCH', json: { tag: 'health' } });
    expect(tagRows('time_block', id)).toEqual(['health']);
    await api(srv.url, `/api/blocks/${id}`, { method: 'PATCH', json: { tag: null } });
    expect(tagRows('time_block', id)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });

  it('routine create syncs its tag', async () => {
    const created = await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Evening', tag: 'wind-down' } });
    const id = created.body.pattern.id as string;
    expect(tagRows('routine', id)).toEqual(['wind-down']);
  });
});

describe('CON-3 orphan-free cascade (the integrity gate)', () => {
  it('block delete clears its tag rows', async () => {
    const created = await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'P', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('09:00'), end_at: at('10:00') } });
    const id = created.body.block.id as string;
    expect(tagRows('time_block', id)).toEqual(['work']);
    await api(srv.url, `/api/blocks/${id}`, { method: 'DELETE' });
    expect(tagRows('time_block', id)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });

  it('block delete with ?children=delete clears members tag rows too', async () => {
    const parent = await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'Plan', block_kind: 'timeblock', block_type: 'scheduled', tag: 'work', start_at: at('09:00'), end_at: at('12:00') } });
    const parentId = parent.body.block.id as string;
    const child = await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'Member', block_kind: 'task', tag: 'sub', start_at: at('09:00'), end_at: at('09:30') } });
    const childId = child.body.block.id as string;
    await api(srv.url, `/api/blocks/${childId}`, { method: 'PATCH', json: { parent_block_id: parentId } });
    expect(tagRows('time_block', childId)).toEqual(['sub']);

    await api(srv.url, `/api/blocks/${parentId}?children=delete`, { method: 'DELETE' });
    expect(tagRows('time_block', parentId)).toEqual([]);
    expect(tagRows('time_block', childId)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });

  it('pattern delete clears the routine + its fast-task tag rows', async () => {
    const pat = await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Morning', tag: 'morning' } });
    const patId = pat.body.pattern.id as string;
    const ft = await api(srv.url, `/api/patterns/${patId}/fast-tasks`, { method: 'POST', json: { title: 'Stretch' } });
    const ftId = ft.body.task.id as string;
    // fast tasks aren't tagged by the route — simulate a user tagging one.
    syncEntityTags('task', ftId, ['mobility'], OWNER);
    expect(tagRows('routine', patId)).toEqual(['morning']);
    expect(tagRows('task', ftId)).toEqual(['mobility']);

    await api(srv.url, `/api/patterns/${patId}`, { method: 'DELETE' });
    expect(tagRows('routine', patId)).toEqual([]);
    expect(tagRows('task', ftId)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });

  it('fast-task delete clears its tag rows', async () => {
    const pat = await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Routine', tag: 'r' } });
    const patId = pat.body.pattern.id as string;
    const ft = await api(srv.url, `/api/patterns/${patId}/fast-tasks`, { method: 'POST', json: { title: 'Quick' } });
    const ftId = ft.body.task.id as string;
    syncEntityTags('task', ftId, ['x'], OWNER);
    expect(tagRows('task', ftId)).toEqual(['x']);

    await api(srv.url, `/api/patterns/${patId}/fast-tasks/${ftId}`, { method: 'DELETE' });
    expect(tagRows('task', ftId)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });
});

describe('CON-3 reads come from entity_tags', () => {
  it('the task list serializes tags from entity_tags', async () => {
    const t = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Read me', tags: ['alpha'] } });
    const tId = t.body.task.id as string;
    const list = await api(srv.url, '/api/tasks');
    const got = (list.body.tasks as { id: string; tags: string[] }[]).find((x) => x.id === tId);
    expect(got?.tags).toEqual(['alpha']); // served from entity_tags (task_tags dropped in 0041)
  });
});
