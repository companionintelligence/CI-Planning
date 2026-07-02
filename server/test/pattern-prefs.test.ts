import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { getPatternPrefs, setPatternPref } from '../src/services/pattern-prefs.js';
import { newId } from '../src/lib/ids.js';

/**
 * pattern_prefs (noun 8 follow-up / migration 0039): per-owner, per-pattern-tag
 * preferences — the `auto_fill` scheduling toggle, reminder offsets, and the
 * pattern-block display config (icon_shape + color_token). Covers the GET/PUT
 * route validation, the service-level fetch-then-merge upsert, and the
 * ON DELETE CASCADE from tags.
 */

const OWNER = SYSTEM_OWNER;

// Pattern (direction) tags are looked up by kind='pattern' (post-0038 rename).
// Mirror pattern-blocks.test.ts's seedDirections: direct inserts, is_base=1.
function seedDirections(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of ['home', 'work', 'community']) {
    ids[name] = (
      sqlite
        .prepare(`INSERT INTO tags (id, name, kind, is_base, owner_id) VALUES (uuid7(), ?, 'pattern', 1, ?) RETURNING id`)
        .get(name, OWNER) as { id: string }
    ).id;
  }
  return ids;
}

/** Insert a single intention tag (the non-pattern kind) and return its id. */
function seedIntention(name: string): string {
  return (
    sqlite
      .prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, 'intention', ?) RETURNING id`)
      .get(name, OWNER) as { id: string }
  ).id;
}

const prefRowCount = (tagId: string) =>
  (sqlite.prepare(`SELECT COUNT(*) c FROM tag_prefs WHERE tag_id = ? AND kind = 'pattern'`).get(tagId) as { c: number }).c;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
// resetDb clears all tags, which cascades pattern_prefs away (FK ON DELETE CASCADE).
beforeEach(() => resetDb());

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/pattern-prefs', () => {
  it('returns { prefs: {} } for an owner with no pattern_prefs rows', async () => {
    seedDirections(); // tags exist, but no pattern_prefs rows yet
    const r = await api(srv.url, '/api/pattern-prefs');
    expect(r.status).toBe(200);
    expect(r.body.prefs).toEqual({});
  });

  it('reflects persisted values after a PUT (keyed by pattern tag id)', async () => {
    const dirs = seedDirections();
    await api(srv.url, `/api/pattern-prefs/${dirs.work}`, {
      method: 'PUT',
      json: { auto_fill: false, reminder_offsets: [10], icon_shape: 'square', color_token: 'chart-3' },
    });

    const r = await api(srv.url, '/api/pattern-prefs');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.prefs)).toEqual([dirs.work]);
    expect(r.body.prefs[dirs.work]).toEqual({
      auto_fill: false,
      reminder_offsets: [10],
      icon_shape: 'square',
      color_token: 'chart-3',
      default_minutes: 60,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/pattern-prefs/:patternTagId — validation', () => {
  it('404 for an unknown tag id', async () => {
    const r = await api(srv.url, '/api/pattern-prefs/does-not-exist', {
      method: 'PUT', json: { auto_fill: false },
    });
    expect(r.status).toBe(404);
  });

  it('422 when the tag is an intention (kind != pattern)', async () => {
    const intId = seedIntention('focus');
    const r = await api(srv.url, `/api/pattern-prefs/${intId}`, {
      method: 'PUT', json: { auto_fill: false },
    });
    expect(r.status).toBe(422);
    // nothing persisted for a rejected request
    expect(prefRowCount(intId)).toBe(0);
  });

  it('422 when reminder_offsets is not an array', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/pattern-prefs/${dirs.work}`, {
      method: 'PUT', json: { reminder_offsets: 15 },
    });
    expect(r.status).toBe(422);
    expect(prefRowCount(dirs.work)).toBe(0);
  });

  it('422 when reminder_offsets contains a negative value', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/pattern-prefs/${dirs.work}`, {
      method: 'PUT', json: { reminder_offsets: [15, -5] },
    });
    expect(r.status).toBe(422);
    expect(prefRowCount(dirs.work)).toBe(0);
  });

  it('422 when icon_shape is invalid (hexagon)', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/pattern-prefs/${dirs.work}`, {
      method: 'PUT', json: { icon_shape: 'hexagon' },
    });
    expect(r.status).toBe(422);
    expect(prefRowCount(dirs.work)).toBe(0);
  });

  it('422 when color_token is an empty string', async () => {
    const dirs = seedDirections();
    const r = await api(srv.url, `/api/pattern-prefs/${dirs.work}`, {
      method: 'PUT', json: { color_token: '' },
    });
    expect(r.status).toBe(422);
    expect(prefRowCount(dirs.work)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/pattern-prefs/:patternTagId — persistence', () => {
  it('PUT { auto_fill: false } persists; GET shows it', async () => {
    const dirs = seedDirections();
    const put = await api(srv.url, `/api/pattern-prefs/${dirs.home}`, {
      method: 'PUT', json: { auto_fill: false },
    });
    expect(put.status).toBe(200);
    expect(put.body.pref.auto_fill).toBe(false);

    const r = await api(srv.url, '/api/pattern-prefs');
    expect(r.body.prefs[dirs.home].auto_fill).toBe(false);
  });

  it('PUT { reminder_offsets: [15, 0] } persists; GET shows [15, 0]', async () => {
    const dirs = seedDirections();
    await api(srv.url, `/api/pattern-prefs/${dirs.home}`, {
      method: 'PUT', json: { reminder_offsets: [15, 0] },
    });
    const r = await api(srv.url, '/api/pattern-prefs');
    expect(r.body.prefs[dirs.home].reminder_offsets).toEqual([15, 0]);
  });

  it('PUT { icon_shape: "square", color_token: "chart-3" } persists; GET shows them', async () => {
    const dirs = seedDirections();
    await api(srv.url, `/api/pattern-prefs/${dirs.work}`, {
      method: 'PUT', json: { icon_shape: 'square', color_token: 'chart-3' },
    });
    const r = await api(srv.url, '/api/pattern-prefs');
    expect(r.body.prefs[dirs.work]).toMatchObject({ icon_shape: 'square', color_token: 'chart-3' });
  });

  it('partial-patch merge: auto_fill then reminder_offsets — both retained', async () => {
    const dirs = seedDirections();
    // First PUT sets only auto_fill.
    await api(srv.url, `/api/pattern-prefs/${dirs.community}`, {
      method: 'PUT', json: { auto_fill: false },
    });
    // Second PUT sets only reminder_offsets; auto_fill must survive the merge.
    await api(srv.url, `/api/pattern-prefs/${dirs.community}`, {
      method: 'PUT', json: { reminder_offsets: [5] },
    });

    const r = await api(srv.url, '/api/pattern-prefs');
    expect(r.body.prefs[dirs.community]).toMatchObject({
      auto_fill: false,
      reminder_offsets: [5],
      // untouched fields keep their defaults
      icon_shape: 'circle',
      color_token: 'primary',
    });
    // a single row (upsert, not a second insert)
    expect(prefRowCount(dirs.community)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pattern-prefs service', () => {
  it('getPatternPrefs excludes missing rows; reflects setPatternPref', () => {
    const dirs = seedDirections();
    expect(getPatternPrefs(OWNER)).toEqual({});

    setPatternPref(OWNER, dirs.work, { auto_fill: false, reminder_offsets: [30] });
    const prefs = getPatternPrefs(OWNER);
    expect(Object.keys(prefs)).toEqual([dirs.work]);
    expect(prefs[dirs.work]).toEqual({
      auto_fill: false,
      reminder_offsets: [30],
      icon_shape: 'circle',
      color_token: 'primary',
      default_minutes: 60,
    });
  });

  it('setPatternPref fetch-then-merges patches onto the existing row', () => {
    const dirs = seedDirections();
    setPatternPref(OWNER, dirs.home, { icon_shape: 'square' });
    const merged = setPatternPref(OWNER, dirs.home, { color_token: 'chart-3' });

    // returned merged row keeps the earlier icon_shape AND the new color_token
    expect(merged).toMatchObject({ icon_shape: 'square', color_token: 'chart-3', auto_fill: true });
    expect(prefRowCount(dirs.home)).toBe(1);
    expect(getPatternPrefs(OWNER)[dirs.home]).toMatchObject({ icon_shape: 'square', color_token: 'chart-3' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ON DELETE CASCADE', () => {
  it('deleting a pattern tag removes its pattern_prefs row', () => {
    const dirs = seedDirections();
    sqlite
      .prepare(
        `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill, reminder_offsets, icon_shape, color_token)
         VALUES (?, ?, ?, 'pattern', 1, '[]', 'circle', 'primary')`,
      )
      .run(newId(), OWNER, dirs.work);
    expect(prefRowCount(dirs.work)).toBe(1);

    // FK pragma is ON connection-level (db/index.ts), so the row cascades away.
    sqlite.prepare(`DELETE FROM tags WHERE id = ?`).run(dirs.work);
    expect(prefRowCount(dirs.work)).toBe(0);
  });
});
