import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { up as backfill0036 } from '../src/db/migrations/0036_tag_directions.js';

/**
 * Tag taxonomy (0036): Direction tags ▸ Intention tags. Directions are the brand-set
 * Home/Work/Community (+ user-added); intentions group under one or more directions.
 * Orthogonal to entity_tags.level (Phase-5 dilution).
 */

function seedDirections(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of ['home', 'work', 'community']) {
    ids[name] = (sqlite
      .prepare(`INSERT INTO tags (id, name, kind, is_base, owner_id) VALUES (uuid7(), ?, 'pattern', 1, ?) RETURNING id`)
      .get(name, SYSTEM_OWNER) as { id: string }).id;
  }
  return ids;
}
const tagByName = (name: string) =>
  sqlite.prepare(`SELECT id, kind, is_base AS isBase FROM tags WHERE name = ?`).get(name) as
    | { id: string; kind: string; isBase: number }
    | undefined;
const memberDirs = (intentionId: string) =>
  (sqlite
    .prepare(`SELECT d.name FROM tag_patterns tp JOIN tags d ON d.id = tp.pattern_tag_id WHERE tp.intention_tag_id = ? ORDER BY d.name`)
    .all(intentionId) as { name: string }[]).map((r) => r.name);
// Used only in the 0036 backfill test: backfill0036 creates a fresh tag_directions
// table (0043 renamed it away) with the original direction_tag_id column name.
const memberDirsLegacy = (intentionId: string) =>
  (sqlite
    .prepare(`SELECT d.name FROM tag_directions td JOIN tags d ON d.id = td.direction_tag_id WHERE td.intention_tag_id = ? ORDER BY d.name`)
    .all(intentionId) as { name: string }[]).map((r) => r.name);

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => resetDb()); // clears all tags incl. base directions

describe('0036 migration backfill', () => {
  // backfill0036 runs `CREATE TABLE IF NOT EXISTS tag_directions`, which RESURRECTS the
  // pre-0043 table on the shared (already-migrated) DB — 0043 renamed it to tag_patterns.
  // resetDb only deletes rows, so the stray table would otherwise linger and leak into a
  // later file's schema snapshot (baseline.characterization). Drop it once this block ends.
  afterAll(() => { sqlite.exec(`DROP TABLE IF EXISTS tag_directions`); });

  it('seeds the 3 base directions, heuristically assigns obvious tags, leaves the rest Unsorted', () => {
    // pre-existing intention tags (as if from before the migration)
    for (const n of ['yard-work', 'product', 'socialize', 'personal'])
      sqlite.prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?)`).run(n, SYSTEM_OWNER);

    backfill0036(sqlite); // idempotent; columns already exist

    expect(tagByName('home')).toMatchObject({ kind: 'direction', isBase: 1 });
    expect(tagByName('work')).toMatchObject({ kind: 'direction', isBase: 1 });
    expect(tagByName('community')).toMatchObject({ kind: 'direction', isBase: 1 });
    expect(memberDirsLegacy(tagByName('yard-work')!.id)).toEqual(['home']);
    expect(memberDirsLegacy(tagByName('product')!.id)).toEqual(['work']);
    expect(memberDirsLegacy(tagByName('socialize')!.id)).toEqual(['community']);
    expect(memberDirsLegacy(tagByName('personal')!.id)).toEqual([]); // Unsorted

    // idempotent: a second run changes nothing
    backfill0036(sqlite);
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM tags WHERE kind='direction'`).get() as { c: number }).c).toBe(3);
  });

  it('promotes a pre-existing same-named tag to the base direction', () => {
    sqlite.prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), 'work', ?)`).run(SYSTEM_OWNER);
    backfill0036(sqlite);
    expect(tagByName('work')).toMatchObject({ kind: 'direction', isBase: 1 });
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM tags WHERE name='work'`).get() as { c: number }).c).toBe(1);
  });
});

describe('tags API — taxonomy', () => {
  it('GET returns kind/muted/used/directions; intentions carry their directions', async () => {
    seedDirections();
    await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'product', directions: ['work'] } });
    const { tags } = (await api(srv.url, '/api/tags')).body;
    const work = tags.find((t: any) => t.name === 'work');
    const product = tags.find((t: any) => t.name === 'product');
    expect(work).toMatchObject({ kind: 'pattern', is_base: true });
    expect(product).toMatchObject({ kind: 'intention', is_base: false, muted: false, used: false, directions: ['work'] });
  });

  it('POST attaches an intention to one or more directions', async () => {
    seedDirections();
    const r = await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'make-dinner', directions: ['home', 'work', 'community'] } });
    expect(memberDirs(r.body.tag.id).sort()).toEqual(['community', 'home', 'work']);
  });

  it('PATCH directions MOVES membership (drag-move replaces)', async () => {
    seedDirections();
    const id = (await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'emails', directions: ['work'] } })).body.tag.id;
    await api(srv.url, `/api/tags/${id}`, { method: 'PATCH', json: { directions: ['home'] } });
    expect(memberDirs(id)).toEqual(['home']); // moved out of work, into home
  });

  it('PATCH mutes a tag', async () => {
    seedDirections();
    const id = (await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'noisy', directions: ['work'] } })).body.tag.id;
    const r = await api(srv.url, `/api/tags/${id}`, { method: 'PATCH', json: { muted: true } });
    expect(r.body.tag.muted).toBe(true);
  });
});

describe('tags API — delete rules', () => {
  it('a used tag cannot be deleted (409); an unused one can', async () => {
    seedDirections();
    // create + use a tag by tagging a task (writes entity_tags via CON-3 sync)
    await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'T', tags: ['used-tag'] } });
    const used = tagByName('used-tag')!;
    const r1 = await api(srv.url, `/api/tags/${used.id}`, { method: 'DELETE' });
    expect(r1.status).toBe(409);

    const unused = (await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'unused-tag', directions: ['home'] } })).body.tag.id;
    const r2 = await api(srv.url, `/api/tags/${unused}`, { method: 'DELETE' });
    expect(r2.status).toBe(200);
    expect(tagByName('unused-tag')).toBeUndefined();
  });

  it('base direction tags cannot be deleted (409)', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/tags/${dirs.home}`, { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect(tagByName('home')).toBeTruthy();
  });
});
