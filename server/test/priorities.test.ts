/**
 * /api/priorities — the owner-scoped life_priorities upsert (0127), ported from the
 * single-user life-priorities-wizard and made multi-tenant. Covers: empty start,
 * upsert-by-category (no duplicates, absent fields preserved), score/hours clamping,
 * blank-category skip, non-array 400, and owner isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetDb, startTestServer, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => resetDb());

interface Prio { category: string; satisfaction: number; importance: number; target_hours_per_week: number }
const get = (headers?: Record<string, string>) =>
  api<{ priorities: Prio[] }>(srv.url, '/api/priorities', headers ? { headers } : {});
const post = (priorities: unknown, headers?: Record<string, string>) =>
  api<{ priorities: Prio[] }>(srv.url, '/api/priorities', { method: 'POST', json: { priorities }, headers });

describe('priorities', () => {
  it('starts empty and upserts by category without duplicating', async () => {
    const empty = await get();
    expect(empty.status).toBe(200);
    expect(empty.body.priorities).toEqual([]);

    const saved = await post([
      { category: 'health', satisfaction: 3, importance: 9, target_hours_per_week: 12 },
      { category: 'career', satisfaction: 7, importance: 6, target_hours_per_week: 40 },
    ]);
    expect(saved.status).toBe(200);
    expect(saved.body.priorities).toHaveLength(2);
    expect(saved.body.priorities.find((p) => p.category === 'health'))
      .toMatchObject({ satisfaction: 3, importance: 9, target_hours_per_week: 12 });

    // Re-upsert the same category: updates in place, absent fields preserved, no duplicate row.
    const upd = await post([{ category: 'health', satisfaction: 8 }]);
    expect(upd.body.priorities).toHaveLength(2);
    expect(upd.body.priorities.find((p) => p.category === 'health'))
      .toMatchObject({ satisfaction: 8, importance: 9, target_hours_per_week: 12 });
  });

  it('clamps scores to 1–10 and hours to 0–168, and skips a blank category', async () => {
    const r = await post([
      { category: 'health', satisfaction: 99, importance: 0, target_hours_per_week: 500 },
      { category: '   ', satisfaction: 5 },
    ]);
    expect(r.body.priorities).toHaveLength(1);
    expect(r.body.priorities[0]).toMatchObject({ category: 'health', satisfaction: 10, importance: 1, target_hours_per_week: 168 });
  });

  it('rejects a non-array payload with 400', async () => {
    const r = await api(srv.url, '/api/priorities', { method: 'POST', json: { priorities: 'nope' } });
    expect(r.status).toBe(400);
  });

  it('is owner-scoped — owner B never sees or clobbers owner A', async () => {
    createOwner(SECOND_OWNER_ID);
    await post([{ category: 'finance', satisfaction: 4, importance: 8, target_hours_per_week: 5 }]); // owner A (system)

    const bEmpty = await get({ 'x-test-owner': SECOND_OWNER_ID });
    expect(bEmpty.body.priorities).toEqual([]);

    await post([{ category: 'finance', satisfaction: 9, importance: 2, target_hours_per_week: 1 }], { 'x-test-owner': SECOND_OWNER_ID });

    const aList = await get();
    expect(aList.body.priorities).toHaveLength(1);
    expect(aList.body.priorities[0]).toMatchObject({ category: 'finance', satisfaction: 4 });

    const bList = await get({ 'x-test-owner': SECOND_OWNER_ID });
    expect(bList.body.priorities).toHaveLength(1);
    expect(bList.body.priorities[0]).toMatchObject({ category: 'finance', satisfaction: 9 });
  });
});
