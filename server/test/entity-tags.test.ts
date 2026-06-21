import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { up as backfill0033 } from '../src/db/migrations/0033_entity_tags.js';
import { syncEntityTags, normalizeTagName } from '../src/services/tags.js';

/**
 * CON-3 — the normalized `entity_tags` store. Three gates:
 *  1. backfill from task_tags / time_blocks.tag / patterns.tag is correct;
 *  2. write paths keep entity_tags in sync (replace semantics);
 *  3. **no orphans** — every HARD delete of a tagged entity clears its rows.
 * Behavior-preserving: existing read surfaces are unchanged (they still read the
 * denormalized mirrors), so this lives alongside the baseline characterization test.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insert(table: string, row: Record<string, unknown>): string {
  const keys = Object.keys(row);
  const stmt = sqlite.prepare(
    `INSERT INTO ${table} (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`,
  );
  return (stmt.get(...keys.map((k) => row[k])) as { id: string }).id;
}
function insertNoId(table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  sqlite.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
}

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

describe('CON-3 backfill (migration 0033, idempotent)', () => {
  it('materializes entity_tags from task_tags + block/routine tag strings, creating missing tags', () => {
    const work = insert('tags', { name: 'work' }); // pre-existing
    const task = insert('tasks', { title: 'T', owner_id: OWNER, status: 'open', priority: 3 });
    insertNoId('task_tags', { task_id: task, tag_id: work });
    const block = insert('time_blocks', { title: 'B', block_kind: 'timeblock', block_type: 'scheduled', tag: 'health, #Fitness', start_at: at('09:00'), end_at: at('10:00'), source_kind: 'manual', status: 'planned' });
    const routineType = (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Routine'`).get() as { id: string }).id;
    const pattern = insert('patterns', { owner_id: OWNER, type_id: routineType, name: 'R', tag: 'morning' });

    // entity_tags is empty before backfill (these inserts bypassed the write-sync).
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM entity_tags`).get() as { c: number }).c).toBe(0);

    backfill0033(sqlite);

    expect(tagRows('task', task)).toEqual(['work']);
    expect(tagRows('time_block', block)).toEqual(['fitness', 'health']); // split + normalized (# stripped)
    expect(tagRows('routine', pattern)).toEqual(['morning']);
    // backfill created the previously-undefined tag names.
    const names = (sqlite.prepare(`SELECT name FROM tags`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['work', 'health', 'fitness', 'morning']));

    // idempotent: a second run changes nothing.
    const before = (sqlite.prepare(`SELECT COUNT(*) AS c FROM entity_tags`).get() as { c: number }).c;
    backfill0033(sqlite);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM entity_tags`).get() as { c: number }).c).toBe(before);
    expect(orphanCount()).toBe(0);
  });
});

describe('CON-3 write-sync (through the routes)', () => {
  it('task create + tag-replace keeps entity_tags in lockstep with task_tags', async () => {
    const created = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Tagged', tags: ['Work', 'Errands'] } });
    const id = created.body.task.id as string;
    expect(tagRows('task', id).sort()).toEqual(['errands', 'work']);
    // the mirror uses the SAME tag ids as task_tags.
    const fromTaskTags = (sqlite.prepare(`SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id`).all(id) as { tag_id: string }[]).map((r) => r.tag_id);
    const fromEntity = (sqlite.prepare(`SELECT tag_id FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ? ORDER BY tag_id`).all(id) as { tag_id: string }[]).map((r) => r.tag_id);
    expect(fromEntity).toEqual(fromTaskTags);

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
    syncEntityTags('task', ftId, ['mobility']);
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
    syncEntityTags('task', ftId, ['x']);
    expect(tagRows('task', ftId)).toEqual(['x']);

    await api(srv.url, `/api/patterns/${patId}/fast-tasks/${ftId}`, { method: 'DELETE' });
    expect(tagRows('task', ftId)).toEqual([]);
    expect(orphanCount()).toBe(0);
  });
});

describe('CON-3 behavior-preserving reads', () => {
  it('task + block read surfaces are unchanged by the mirror', async () => {
    const t = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Read me', tags: ['alpha'] } });
    const tId = t.body.task.id as string;
    const list = await api(srv.url, '/api/tasks');
    const got = (list.body.tasks as { id: string; tags: string[] }[]).find((x) => x.id === tId);
    expect(got?.tags).toEqual(['alpha']); // still served from task_tags, not entity_tags
  });
});
