import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * 0069 — a time block can carry a Time Block Category. The category's colour is
 * STAMPED onto the block at create-time (forward-only: later category edits never
 * re-colour a placed block), and a block is owned by EITHER a tag OR a category,
 * never both (the scheduler partitions on this).
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
    expect(created.body.block.category_id).toBe(catId);
    expect(created.body.block.color_token).toBe('chart-1'); // stamped from prefs

    // Re-colour the category AFTER placement → the placed block keeps its frozen stamp.
    await api(srv.url, `/api/category-prefs/${catId}`, { method: 'PUT', json: { color_token: 'tag-5' } });
    expect(blockRow(created.body.block.id).color_token).toBe('chart-1');
  });

  it('rejects a block that sets BOTH a tag and a category (422), POST and PATCH', async () => {
    const catId = await makeCategory('social-time', 'chart-3');
    const both = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'X', block_kind: 'timeblock', tag: 'work', category_id: catId, start_at: at('09'), end_at: at('10') },
    });
    expect(both.status).toBe(422);

    // A tag block can't later add a category (the merged row would set both).
    const tagBlock = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Work', block_kind: 'timeblock', tag: 'work', start_at: at('11'), end_at: at('12') },
    })).body.block;
    const patched = await api(srv.url, `/api/blocks/${tagBlock.id}`, { method: 'PATCH', json: { category_id: catId } });
    expect(patched.status).toBe(422);
  });

  it('rejects a category_id that is not a kind=category tag (422)', async () => {
    const patternId = (await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'work', kind: 'pattern' } })).body.tag.id;
    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Nope', block_kind: 'timeblock', category_id: patternId, start_at: at('09'), end_at: at('10') },
    });
    expect(res.status).toBe(422);
  });
});
