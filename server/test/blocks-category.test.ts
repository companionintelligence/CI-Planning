import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * 0069 — a time block can carry a Time Block Category. The category's colour is
 * STAMPED onto the block at create-time (forward-only: later category edits never
 * re-colour a placed block). AF-4 relaxed the old tag-XOR-category guard: a block
 * may carry a direction tag AND a category together (Phase AD coexist contract).
 */

const blockRow = (id: string) => sqlite.prepare(`SELECT * FROM time_blocks WHERE id = ?`).get(id) as any;
const at = (h: string) => `2026-06-20T${h}:00.000Z`;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

async function makeCategory(name: string, color: string): Promise<string> {
  const id = (await api(srv.url, '/api/tags', { method: 'POST', json: { name, kind: 'category' } })).body.tag.id as string;
  await api(srv.url, `/api/category-prefs/${id}`, { method: 'PUT', json: { color_token: color, default_minutes: 90 } });
  return id;
}

describe('time-block category (0069)', () => {
  it('stamps color_token from category prefs and freezes it (forward-only)', async () => {
    const catId = await makeCategory('focus-time', 'chart-1');
    const created = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Focus', block_kind: 'timeblock', block_type: 'scheduled', category_id: catId, start_at: at('09'), end_at: at('10') },
    });
    expect(created.status).toBe(201);
    // Phase B (0135): the legacy category_id input bridges into entity_categories —
    // the response carries `categories` (names); the retired column is not written.
    expect(created.body.block.categories).toEqual(['focus-time']);
    expect(created.body.block.category_id).toBeNull();
    expect(created.body.block.color_token).toBe('chart-1'); // stamped from prefs

    // Re-colour the category AFTER placement → the placed block keeps its frozen stamp.
    await api(srv.url, `/api/category-prefs/${catId}`, { method: 'PUT', json: { color_token: 'tag-5' } });
    expect(blockRow(created.body.block.id).color_token).toBe('chart-1');
  });

  it('AF-4: a block may set BOTH a tag and a category — POST and PATCH succeed, both persist', async () => {
    const catId = await makeCategory('social-time', 'chart-3');
    const both = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'X', block_kind: 'timeblock', tag: 'work', secondary_tags: ['deep'], category_id: catId, start_at: at('09'), end_at: at('10') },
    });
    expect(both.status).toBe(201);
    expect(both.body.block.tag).toBe('work');
    expect(both.body.block.categories).toEqual(['social-time']); // Phase B: names, not the column
    expect(both.body.block.color_token).toBe('chart-3'); // category-frozen color wins when both set

    // The read API returns tag, secondary_tags, and categories together.
    const listed = await api(srv.url, '/api/blocks?from=2026-06-20T00:00:00.000Z&to=2026-06-20T23:59:59.999Z');
    const read = (listed.body.blocks as any[]).find((b) => b.id === both.body.block.id);
    expect(read).toMatchObject({ tag: 'work', secondary_tags: ['deep'], categories: ['social-time'] });

    // entity_tags level-1 sync still fires when a category is also present.
    const lvl1 = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_kind = 'time_block' AND et.entity_id = ? AND et.level = 1 AND t.name = 'work'`)
      .get(both.body.block.id) as { n: number };
    expect(lvl1.n).toBe(1);

    // A tag block may later ADD a category (merged row carries both).
    const tagBlock = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Work', block_kind: 'timeblock', tag: 'work', start_at: at('11'), end_at: at('12') },
    })).body.block;
    const patched = await api(srv.url, `/api/blocks/${tagBlock.id}`, { method: 'PATCH', json: { category_id: catId } });
    expect(patched.status).toBe(200);
    expect(patched.body.block.tag).toBe('work');
    expect(patched.body.block.categories).toEqual(['social-time']); // Phase B bridge
  });

  it('rejects a category_id that is not a kind=category tag (422)', async () => {
    const patternId = (await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'work', kind: 'direction' } })).body.tag.id;
    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Nope', block_kind: 'timeblock', category_id: patternId, start_at: at('09'), end_at: at('10') },
    });
    expect(res.status).toBe(422);
  });
});
