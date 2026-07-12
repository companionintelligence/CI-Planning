import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { routineDerivedTagsByIds, routineDerivedTags, inheritContainerDirection, entityTagLevels, syncEntityTags } from '../src/services/tags.js';
import { up as legacyCleanupUp } from '../src/db/migrations/0120_af11_routine_tag_cleanup.js';

/**
 * AF-11 Slices 4–6 — routine tag inheritance (Decision D2: DERIVED at read time).
 *
 * A routine authors NO tags: its `directions[]` + `intentions[]` are the union of
 * its member tasks' tags (pattern_tasks ⋈ entity_tags ⋈ tags), kind-classified.
 * Multiple directions per routine are expected and legal. The old authored state
 * (`patterns.tag` + entity_kind='routine' rows) is accepted-and-ignored on write and
 * cleaned by migration 0120 (Decision D3).
 */

const OWNER = SYSTEM_OWNER;

const insertTask = (title: string): string =>
  (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`).get(title, OWNER) as { id: string }).id;

/** Resolve-or-create an owner tag with the given kind (base work/home/community may pre-exist). */
const tagId = (name: string, kind: 'direction' | 'intention'): string => {
  const ex = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`).get(OWNER, name) as { id: string } | undefined;
  return ex ? ex.id : (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, ?) RETURNING id`).get(OWNER, name, kind) as { id: string }).id;
};
const attach = (taskId: string, tag: string, kind: 'direction' | 'intention', level = 1) =>
  sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`).run(taskId, tagId(tag, kind), level);

const routineEntityTagRows = (patternId: string): number =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM entity_tags WHERE entity_kind = 'routine' AND entity_id = ?`).get(patternId) as { c: number }).c;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM pattern_types WHERE is_builtin = 0;`);
});

describe('AF-11 Slice 4 — authored-tag writes removed (accept-and-ignore)', () => {
  it('POST /api/patterns ignores an incoming tag: column NULL, no entity_tags mirror', async () => {
    const r = await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Evening', tag: 'wind-down' } });
    expect(r.status).toBe(201);
    expect(r.body.pattern.tag).toBeNull();
    expect(r.body.pattern.directions).toEqual([]);
    expect(r.body.pattern.intentions).toEqual([]);
    expect(routineEntityTagRows(r.body.pattern.id)).toBe(0);
    expect((sqlite.prepare(`SELECT tag FROM patterns WHERE id = ?`).get(r.body.pattern.id) as { tag: string | null }).tag).toBeNull();
  });

  it('PATCH /api/patterns/:id ignores an incoming tag and writes no mirror', async () => {
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'P' } })).body.pattern;
    const u = await api(srv.url, `/api/patterns/${p.id}`, { method: 'PATCH', json: { name: 'P2', tag: 'x' } });
    expect(u.status).toBe(200);
    expect(u.body.pattern.name).toBe('P2');
    expect(u.body.pattern.tag).toBeNull();
    expect(routineEntityTagRows(p.id)).toBe(0);
  });
});

describe('AF-11 Slice 4 — derived union (D2)', () => {
  it('union = distinct member directions + intentions; MULTIPLE directions are legal', async () => {
    const a = insertTask('Deep work');
    const b = insertTask('Family dinner');
    attach(a, 'work', 'direction'); attach(a, 'deep', 'intention', 2);
    attach(b, 'home', 'direction'); attach(b, 'deep', 'intention', 2); attach(b, 'errand', 'intention', 2);
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Mixed', task_ids: [a, b] } })).body.pattern;
    expect(p.directions).toEqual(['home', 'work']); // multi-direction, name-sorted
    expect(p.intentions).toEqual(['deep', 'errand']); // deduped across members

    // The list read (batched one-query path) agrees with the single read.
    const list = (await api(srv.url, '/api/patterns')).body.patterns;
    const row = list.find((x: any) => x.id === p.id);
    expect(row.directions).toEqual(['home', 'work']);
    expect(row.intentions).toEqual(['deep', 'errand']);
  });

  it('derivation is level-agnostic: an intention still at level 1 (pre-AF-11 data) classifies by kind', async () => {
    const t = insertTask('Legacy-shaped');
    attach(t, 'work', 'direction', 1);
    attach(t, 'deep', 'intention', 1); // old shape: intention at level 1
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Legacy', task_ids: [t] } })).body.pattern;
    expect(p.directions).toEqual(['work']);
    expect(p.intentions).toEqual(['deep']);
  });

  it('membership add/remove changes the union', async () => {
    const a = insertTask('A'); attach(a, 'work', 'direction');
    const b = insertTask('B'); attach(b, 'home', 'direction'); attach(b, 'errand', 'intention', 2);
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Grow', task_ids: [a] } })).body.pattern;
    expect(p.directions).toEqual(['work']);

    await api(srv.url, `/api/patterns/${p.id}/tasks`, { method: 'POST', json: { task_id: b } });
    let got = (await api(srv.url, `/api/patterns/${p.id}`)).body.pattern;
    expect(got.directions).toEqual(['home', 'work']);
    expect(got.intentions).toEqual(['errand']);

    await api(srv.url, `/api/patterns/${p.id}/tasks/${a}`, { method: 'DELETE' });
    got = (await api(srv.url, `/api/patterns/${p.id}`)).body.pattern;
    expect(got.directions).toEqual(['home']);
    expect(got.intentions).toEqual(['errand']);
  });

  it('a tag-less promoted routine surfaces its members\' union', async () => {
    const a = insertTask('Pack bag'); attach(a, 'work', 'direction'); attach(a, 'prep', 'intention', 2);
    const b = insertTask('Water plants'); attach(b, 'home', 'direction');
    const r = await api(srv.url, '/api/patterns/promote-from-tasks', { method: 'POST', json: { task_ids: [a, b], name: 'Morning kit' } });
    expect(r.status).toBe(201);
    expect(r.body.pattern.tag).toBeNull();
    expect(r.body.pattern.directions).toEqual(['home', 'work']);
    expect(r.body.pattern.intentions).toEqual(['prep']);
  });

  it('routineDerivedTagsByIds returns an (empty) entry for every requested id', () => {
    const m = routineDerivedTagsByIds(['nope-1', 'nope-2']);
    expect(m.get('nope-1')).toEqual({ directions: [], intentions: [] });
    expect(m.get('nope-2')).toEqual({ directions: [], intentions: [] });
  });
});

describe('AF-11 Slice 5 — inheritContainerDirection multi-direction guard', () => {
  it('a two-direction container inherits BOTH: first known direction at level 1 (returned), the rest at level 2', () => {
    tagId('work', 'direction'); tagId('home', 'direction');
    const t = insertTask('Inherit me');
    const applied = inheritContainerDirection(t, 'work,home', OWNER);
    expect(applied).toBe('work'); // container-string order, not alphabetical
    expect(entityTagLevels('task', t)).toEqual([
      { name: 'work', level: 1 },
      { name: 'home', level: 2 },
    ]);
  });

  it('unknown names are skipped; a lone unknown still inherits the known one', () => {
    tagId('home', 'direction');
    const t = insertTask('Partial');
    expect(inheritContainerDirection(t, 'not-a-direction,home', OWNER)).toBe('home');
    expect(entityTagLevels('task', t)).toEqual([{ name: 'home', level: 1 }]);
  });

  it('never overrides an existing level-1 direction', () => {
    tagId('work', 'direction'); tagId('home', 'direction');
    const t = insertTask('Already set');
    attach(t, 'work', 'direction', 1);
    expect(inheritContainerDirection(t, 'home,work', OWNER)).toBeNull();
    expect(entityTagLevels('task', t)).toEqual([{ name: 'work', level: 1 }]);
  });
});

describe('AF-11 Slice 6 — legacy cleanup migration 0120 (D3)', () => {
  it('nulls patterns.tag, deletes routine entity_tags, is idempotent — and the derived union survives (proving display is derived)', async () => {
    const t = insertTask('Member'); attach(t, 'work', 'direction'); attach(t, 'deep', 'intention', 2);
    const p = (await api(srv.url, '/api/patterns', { method: 'POST', json: { name: 'Legacy', task_ids: [t] } })).body.pattern;
    // Seed the LEGACY authored state raw (the API no longer writes it).
    sqlite.prepare(`UPDATE patterns SET tag = 'old,stale' WHERE id = ?`).run(p.id);
    syncEntityTags('routine', p.id, ['old', 'stale'], OWNER);
    expect(routineEntityTagRows(p.id)).toBe(2);

    legacyCleanupUp(sqlite);
    legacyCleanupUp(sqlite); // idempotent — re-run is a no-op, not an error

    expect((sqlite.prepare(`SELECT tag FROM patterns WHERE id = ?`).get(p.id) as { tag: string | null }).tag).toBeNull();
    expect(routineEntityTagRows(p.id)).toBe(0);
    // Task rows are untouched...
    expect(entityTagLevels('task', t).map((r) => r.name).sort()).toEqual(['deep', 'work']);
    // ...so the routine still shows the correct union — the display never read the nulled column.
    const got = (await api(srv.url, `/api/patterns/${p.id}`)).body.pattern;
    expect(got.tag).toBeNull();
    expect(got.directions).toEqual(['work']);
    expect(got.intentions).toEqual(['deep']);
    expect(routineDerivedTags(p.id)).toEqual({ directions: ['work'], intentions: ['deep'] });
  });
});
