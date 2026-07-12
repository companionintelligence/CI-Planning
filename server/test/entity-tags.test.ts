import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { syncEntityTags, normalizeTagName, entityTagsFull } from '../src/services/tags.js';

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

  it('routine create no longer mirrors a tag (AF-11: authored routine tags are ignored)', async () => {
    // Routines derive their tags from member tasks at read time (D2) — the write
    // path accepts `tag` for API compat but writes NEITHER the column NOR entity_tags.
    const created = await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Evening', tag: 'wind-down' } });
    const id = created.body.pattern.id as string;
    expect(created.body.pattern.tag).toBeNull();
    expect(tagRows('routine', id)).toEqual([]);
    expect(orphanCount()).toBe(0);
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
    const pat = await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Morning' } });
    const patId = pat.body.pattern.id as string;
    const ft = await api(srv.url, `/api/patterns/${patId}/fast-tasks`, { method: 'POST', json: { title: 'Stretch' } });
    const ftId = ft.body.task.id as string;
    // AF-11: the API no longer writes routine rows — seed LEGACY ones raw (pre-0120
    // data) to prove the delete cascade still clears them.
    syncEntityTags('routine', patId, ['morning'], OWNER);
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

describe('W4a — entity_tags.created_at (Taggable taggedAt)', () => {
  it('a fresh entity_tags insert gets a non-null created_at from the DB default', () => {
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'Timed', 'open') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    syncEntityTags('task', taskId, ['work'], OWNER); // via services/tags.ts insertAssoc

    const rows = sqlite
      .prepare(`SELECT created_at FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ?`)
      .all(taskId) as { created_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBeTruthy();
    // Parseable to a valid instant (stored as SQLite CURRENT_TIMESTAMP text, matching the
    // other created_at columns — tasks/time_blocks; the DateTime scalar serializes it).
    expect(Number.isNaN(new Date(rows[0].created_at as string).getTime())).toBe(false);
  });

  // The structural invariant W4a's migration guarantees: entity_tags has SIX writers
  // (services/tags.ts + auto-tag, blocks-recur, possibles, recall clone, groom) and most
  // omit created_at. A raw 4-column insert stands in for those five — the DB-level
  // NOT NULL DEFAULT CURRENT_TIMESTAMP must fill it, or Taggable.taggedAt (DateTime!) 500s.
  it('an insert that OMITS created_at (the five non-insertAssoc writers) still gets one', () => {
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'Bare', 'open') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const tagId = (sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name) VALUES (uuid7(), ?, 'bare') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    // The exact 4-column form the other writers use (e.g. services/auto-tag.ts).
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, tagId);
    const row = sqlite
      .prepare(`SELECT created_at FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ?`)
      .get(taskId) as { created_at: string | null };
    expect(row.created_at).toBeTruthy(); // DB default, not app-stamped
  });

  it('no live entity_tags row has a null created_at (structural DB-default invariant)', () => {
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'A', 'open') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    syncEntityTags('task', taskId, ['x', 'y'], OWNER);
    const nulls = (sqlite.prepare(`SELECT COUNT(*) AS c FROM entity_tags WHERE created_at IS NULL`).get() as { c: number }).c;
    expect(nulls).toBe(0);
  });

  it('entityTagsFull returns id + name + non-null createdAt for every applied tag', () => {
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'Full', 'open') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    syncEntityTags('task', taskId, ['alpha', 'beta'], OWNER);
    const full = entityTagsFull('task', taskId);
    expect(full.map((t) => t.name).sort()).toEqual(['alpha', 'beta']);
    for (const t of full) {
      expect(t.tagId).toBeTruthy();
      expect(t.createdAt).toBeTruthy();
    }
    // An entity with no tags → [].
    expect(entityTagsFull('task', 'nope')).toEqual([]);
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
