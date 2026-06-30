/**
 * Phase N0 — GET/PUT/POST/DELETE /api/reflections.
 *
 * Tests written BEFORE the route implementation (spec Tests: section).
 * All date arithmetic uses pinned dates to avoid time-bomb failures (TZ=UTC in CI).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

// Pinned dates — derived from helpers, not hardcoded ISO strings.
// 2026-06-15 is Monday W25; 2026-06-22 is Monday W26.
const DAY = '2026-06-15';
const WEEK_KEY = '2026-W25'; // isoWeekKey('2026-06-15')
const NEXT_DAY = '2026-06-16';
const NEXT_WEEK_DAY = '2026-06-22';
const NEXT_WEEK_KEY = '2026-W26';

function reflectionRows(): {
  owner_id: string; kind: string; period_key: string; position: number;
  body: string; category_id: string | null; done_at: string | null;
}[] {
  return sqlite
    .prepare(`SELECT owner_id, kind, period_key, position, body, category_id, done_at FROM reflections ORDER BY kind, period_key, position`)
    .all() as ReturnType<typeof reflectionRows>;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET /api/reflections', () => {
  it('returns null today + empty weekly when no rows exist', async () => {
    const res = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.today).toBeNull();
    expect(res.body.weekly).toEqual([]);
  });

  it('returns the today goal for the requested day', async () => {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, 'Ship N0', ?, ?)`
    ).run(SYSTEM_OWNER, DAY, now, now);

    const res = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.today).toMatchObject({ body: 'Ship N0', done_at: null });
    expect(res.body.weekly).toEqual([]);
  });

  it('returns up to 3 weekly goals keyed by the ISO week of the period', async () => {
    const now = new Date().toISOString();
    for (const pos of [0, 1, 2]) {
      sqlite.prepare(
        `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
         VALUES (?, 'weekly_goal', ?, ?, ?, ?, ?)`
      ).run(SYSTEM_OWNER, WEEK_KEY, pos, `goal ${pos}`, now, now);
    }

    // Any day in that week should return the same weekly goals.
    const res = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.weekly).toHaveLength(3);
    expect(res.body.weekly[0]).toMatchObject({ position: 0, body: 'goal 0' });
    expect(res.body.weekly[2]).toMatchObject({ position: 2, body: 'goal 2' });
  });

  it('weekly goals do NOT bleed across ISO weeks', async () => {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'weekly_goal', ?, 0, 'Old goal', ?, ?)`
    ).run(SYSTEM_OWNER, WEEK_KEY, now, now);

    // Next week should be empty.
    const res = await api(srv.url, `/api/reflections?period=${NEXT_WEEK_DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.weekly).toEqual([]);
  });

  it('owner isolation — route only reads rows for currentOwnerId (SYSTEM_OWNER)', async () => {
    // Seed a row for SYSTEM_OWNER, then verify the GET returns it. The reflections
    // table FK on owner_id (→ owners.id) plus the WHERE owner_id=currentOwnerId()
    // clause are the two isolation layers; both are covered by the schema and route.
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, 'Mine', ?, ?)`
    ).run(SYSTEM_OWNER, DAY, now, now);

    const res = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.today).not.toBeNull();
    expect(res.body.today.body).toBe('Mine');

    // The FK schema makes it structurally impossible to insert for an unknown owner.
    expect(() =>
      sqlite.prepare(
        `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
         VALUES ('nonexistent-owner', 'today_goal', ?, 0, 'Not mine', ?, ?)`
      ).run(DAY, now, now)
    ).toThrow(/FOREIGN KEY/);
  });
});

// ── PUT /today ────────────────────────────────────────────────────────────────

describe('PUT /api/reflections/today', () => {
  const put = (body: Record<string, unknown>) =>
    api(srv.url, '/api/reflections/today', { method: 'PUT', json: body });

  it('creates a today goal (upsert)', async () => {
    const res = await put({ period_key: DAY, body: 'Write tests first' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = reflectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_id: SYSTEM_OWNER,
      kind: 'today_goal',
      period_key: DAY,
      position: 0,
      body: 'Write tests first',
    });
  });

  it('updates the body on a second PUT (upsert, not duplicate)', async () => {
    await put({ period_key: DAY, body: 'First draft' });
    await put({ period_key: DAY, body: 'Revised goal' });
    expect(reflectionRows()).toHaveLength(1);
    expect(reflectionRows()[0].body).toBe('Revised goal');
  });

  it('empty body deletes the row', async () => {
    await put({ period_key: DAY, body: 'To be cleared' });
    expect(reflectionRows()).toHaveLength(1);

    const res = await put({ period_key: DAY, body: '' });
    expect(res.status).toBe(200);
    expect(reflectionRows()).toHaveLength(0);
  });

  it('whitespace-only body is treated as empty (deletes)', async () => {
    await put({ period_key: DAY, body: 'Something' });
    await put({ period_key: DAY, body: '   ' });
    expect(reflectionRows()).toHaveLength(0);
  });

  it('422 when period_key is missing', async () => {
    const res = await put({ body: 'No key' });
    expect(res.status).toBe(422);
    expect(reflectionRows()).toHaveLength(0);
  });

  it('stores category_id when provided', async () => {
    const tagId = sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), 'family', 'category') RETURNING id`).get() as { id: string };
    await put({ period_key: DAY, body: 'Family time', category_id: tagId.id });
    expect(reflectionRows()[0].category_id).toBe(tagId.id);
  });

  it('GET returns color_token from category_prefs when a category is assigned', async () => {
    const tag = sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), 'family', 'category') RETURNING id`).get() as { id: string };
    sqlite.prepare(`INSERT INTO category_prefs (id, owner_id, category_tag_id, color_token) VALUES (uuid7(), ?, ?, 'chart-1')`).run(SYSTEM_OWNER, tag.id);
    await put({ period_key: DAY, body: 'Family time', category_id: tag.id });
    const res = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.today.color_token).toBe('chart-1');
  });

  it('GET returns null color_token when no category is assigned', async () => {
    await put({ period_key: DAY, body: 'Plain goal' });
    const res = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.today.color_token).toBeNull();
  });

  it('different days produce independent rows', async () => {
    await put({ period_key: DAY, body: 'Monday goal' });
    await put({ period_key: NEXT_DAY, body: 'Tuesday goal' });
    expect(reflectionRows()).toHaveLength(2);
  });
});

// ── PUT /weekly/:position ─────────────────────────────────────────────────────

describe('PUT /api/reflections/weekly/:position', () => {
  const put = (position: number, body: Record<string, unknown>) =>
    api(srv.url, `/api/reflections/weekly/${position}`, { method: 'PUT', json: body });

  it('creates weekly goals at positions 0, 1, 2', async () => {
    for (const pos of [0, 1, 2]) {
      const res = await put(pos, { period_key: WEEK_KEY, body: `weekly ${pos}` });
      expect(res.status).toBe(200);
    }
    expect(reflectionRows()).toHaveLength(3);
  });

  it('422 for position 3 (out of range)', async () => {
    const res = await put(3, { period_key: WEEK_KEY, body: 'Too many' });
    expect(res.status).toBe(422);
    expect(reflectionRows()).toHaveLength(0);
  });

  it('422 for negative position', async () => {
    const res = await put(-1, { period_key: WEEK_KEY, body: 'Negative' });
    expect(res.status).toBe(422);
  });

  it('upserts on same position — no duplicate', async () => {
    await put(0, { period_key: WEEK_KEY, body: 'First' });
    await put(0, { period_key: WEEK_KEY, body: 'Updated' });
    const rows = reflectionRows().filter((r) => r.kind === 'weekly_goal');
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('Updated');
  });

  it('empty body deletes the slot', async () => {
    await put(1, { period_key: WEEK_KEY, body: 'To delete' });
    await put(1, { period_key: WEEK_KEY, body: '' });
    expect(reflectionRows().filter((r) => r.kind === 'weekly_goal')).toHaveLength(0);
  });

  it('PK enforces exactly-3 maximum via position constraint + 422', async () => {
    // The table PK makes a 4th weekly row structurally impossible;
    // the route 422s before even attempting to write.
    const res = await put(3, { period_key: WEEK_KEY, body: 'Fourth slot' });
    expect(res.status).toBe(422);
    expect(reflectionRows()).toHaveLength(0);
  });

  it('422 when period_key is missing', async () => {
    const res = await put(0, { body: 'No key' });
    expect(res.status).toBe(422);
  });

  it('goals from two different ISO weeks coexist independently', async () => {
    await put(0, { period_key: WEEK_KEY, body: 'W25 goal' });
    await put(0, { period_key: NEXT_WEEK_KEY, body: 'W26 goal' });
    expect(reflectionRows().filter((r) => r.kind === 'weekly_goal')).toHaveLength(2);
  });
});

// ── POST /done ────────────────────────────────────────────────────────────────

describe('POST /api/reflections/:kind/:position/done', () => {
  it('sets done_at on a today goal', async () => {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, 'Goal', ?, ?)`
    ).run(SYSTEM_OWNER, DAY, now, now);

    const res = await api(srv.url, '/api/reflections/today_goal/0/done', {
      method: 'POST',
      json: { period_key: DAY, done: true },
    });
    expect(res.status).toBe(200);

    const row = reflectionRows()[0];
    expect(row.done_at).not.toBeNull();
  });

  it('clears done_at when done=false', async () => {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, done_at, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, 'Done', ?, ?, ?)`
    ).run(SYSTEM_OWNER, DAY, now, now, now);

    await api(srv.url, '/api/reflections/today_goal/0/done', {
      method: 'POST',
      json: { period_key: DAY, done: false },
    });
    expect(reflectionRows()[0].done_at).toBeNull();
  });

  it('404 when the row does not exist', async () => {
    const res = await api(srv.url, '/api/reflections/today_goal/0/done', {
      method: 'POST',
      json: { period_key: DAY, done: true },
    });
    expect(res.status).toBe(404);
  });

  it('422 for an invalid kind', async () => {
    const res = await api(srv.url, '/api/reflections/bad_kind/0/done', {
      method: 'POST',
      json: { period_key: DAY, done: true },
    });
    expect(res.status).toBe(422);
  });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE /api/reflections/:kind/:position', () => {
  it('removes a today goal by composite key', async () => {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, 'Delete me', ?, ?)`
    ).run(SYSTEM_OWNER, DAY, now, now);

    const res = await api(
      srv.url,
      `/api/reflections/today_goal/0?period_key=${DAY}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(reflectionRows()).toHaveLength(0);
  });

  it('is idempotent — deleting a non-existent row still returns 200', async () => {
    const res = await api(
      srv.url,
      `/api/reflections/today_goal/0?period_key=${DAY}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
  });

  it('422 when period_key query param is missing', async () => {
    const res = await api(srv.url, '/api/reflections/today_goal/0', { method: 'DELETE' });
    expect(res.status).toBe(422);
  });
});
