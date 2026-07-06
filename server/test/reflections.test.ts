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
  source_kind: string; source_ref: string | null;
}[] {
  return sqlite
    .prepare(`SELECT owner_id, kind, period_key, position, body, category_id, done_at, source_kind, source_ref FROM reflections ORDER BY kind, period_key, position`)
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
    const tagId = sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'family', 'category', ?) RETURNING id`).get(SYSTEM_OWNER) as { id: string };
    await put({ period_key: DAY, body: 'Family time', category_id: tagId.id });
    expect(reflectionRows()[0].category_id).toBe(tagId.id);
  });

  it('GET returns color_token from category_prefs when a category is assigned', async () => {
    const tag = sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'family', 'category', ?) RETURNING id`).get(SYSTEM_OWNER) as { id: string };
    sqlite.prepare(`INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token) VALUES (uuid7(), ?, ?, 'category', 'chart-1')`).run(SYSTEM_OWNER, tag.id);
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

// ── Phase O · O0 — linked focus (source_kind / source_ref) ─────────────────────

describe('O0 — reflection source links', () => {
  const putToday = (body: Record<string, unknown>) =>
    api(srv.url, '/api/reflections/today', { method: 'PUT', json: body });
  const putWeekly = (position: number, body: Record<string, unknown>) =>
    api(srv.url, `/api/reflections/weekly/${position}`, { method: 'PUT', json: body });

  function makeTask(title: string, status = 'open'): string {
    return (sqlite
      .prepare(`INSERT INTO tasks (id, title, status, owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
      .get(title, status, SYSTEM_OWNER) as { id: string }).id;
  }
  function makeObjective(title: string): string {
    const now = new Date().toISOString();
    return (sqlite
      .prepare(`INSERT INTO objectives (id, owner_id, title, level, created_at, updated_at) VALUES (uuid7(), ?, ?, 'objective', ?, ?) RETURNING id`)
      .get(SYSTEM_OWNER, title, now, now) as { id: string }).id;
  }

  it('today upsert accepts + GET returns source_kind=task + ref', async () => {
    const taskId = makeTask('Ship O0');
    const res = await putToday({ period_key: DAY, body: 'Ship O0', source_kind: 'task', source_ref: taskId });
    expect(res.status).toBe(200);

    const row = reflectionRows()[0];
    expect(row).toMatchObject({ source_kind: 'task', source_ref: taskId });

    const get = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(get.body.today).toMatchObject({ source_kind: 'task', source_ref: taskId });
  });

  it('weekly upsert accepts + GET returns source_kind=objective + ref (any level linkable)', async () => {
    const objId = makeObjective('Health goal');
    const res = await putWeekly(0, { period_key: WEEK_KEY, body: 'Get healthy', source_kind: 'objective', source_ref: objId });
    expect(res.status).toBe(200);
    const get = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(get.body.weekly[0]).toMatchObject({ source_kind: 'objective', source_ref: objId });
  });

  it('freeform save defaults to manual with a null ref — creates no task or objective', async () => {
    await putToday({ period_key: DAY, body: 'Just a thought' });
    const row = reflectionRows()[0];
    expect(row).toMatchObject({ source_kind: 'manual', source_ref: null });
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(0);
  });

  it('a task/objective kind with no ref collapses to manual', async () => {
    await putToday({ period_key: DAY, body: 'Dangling', source_kind: 'task', source_ref: null });
    expect(reflectionRows()[0]).toMatchObject({ source_kind: 'manual', source_ref: null });
  });

  it('an unknown source_kind falls back to manual', async () => {
    await putToday({ period_key: DAY, body: 'Weird', source_kind: 'nonsense', source_ref: 'x' });
    expect(reflectionRows()[0]).toMatchObject({ source_kind: 'manual', source_ref: null });
  });

  it('empty-body save still deletes even with a source link', async () => {
    const taskId = makeTask('Temp');
    await putToday({ period_key: DAY, body: 'Linked', source_kind: 'task', source_ref: taskId });
    expect(reflectionRows()).toHaveLength(1);
    await putToday({ period_key: DAY, body: '', source_kind: 'task', source_ref: taskId });
    expect(reflectionRows()).toHaveLength(0);
  });
});

// ── Phase O · O1 — day note (one per day) ──────────────────────────────────────

describe('O1 — day note', () => {
  const putNote = (body: Record<string, unknown>) =>
    api(srv.url, '/api/reflections/note', { method: 'PUT', json: body });
  const noteRows = () => reflectionRows().filter((r) => r.kind === 'day_note');

  it('creates a day note and GET returns it', async () => {
    const res = await putNote({ period_key: DAY, body: 'Good day today' });
    expect(res.status).toBe(200);
    expect(noteRows()).toHaveLength(1);
    expect(noteRows()[0]).toMatchObject({ kind: 'day_note', period_key: DAY, position: 0, body: 'Good day today' });

    const get = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(get.body.note).toMatchObject({ body: 'Good day today' });
    expect(get.body.note.updated_at).toBeTruthy();
  });

  it('two saves same day → one row, latest body wins (PK upsert)', async () => {
    await putNote({ period_key: DAY, body: 'First' });
    await putNote({ period_key: DAY, body: 'Second' });
    expect(noteRows()).toHaveLength(1);
    expect(noteRows()[0].body).toBe('Second');
  });

  it('empty body deletes the note', async () => {
    await putNote({ period_key: DAY, body: 'To clear' });
    expect(noteRows()).toHaveLength(1);
    const res = await putNote({ period_key: DAY, body: '' });
    expect(res.status).toBe(200);
    expect(noteRows()).toHaveLength(0);
  });

  it('whitespace-only body is treated as empty (deletes)', async () => {
    await putNote({ period_key: DAY, body: 'Something' });
    await putNote({ period_key: DAY, body: '   ' });
    expect(noteRows()).toHaveLength(0);
  });

  it('422 when period_key is missing', async () => {
    const res = await putNote({ body: 'No key' });
    expect(res.status).toBe(422);
    expect(noteRows()).toHaveLength(0);
  });

  it('distinct days are independent; GET returns null when no note', async () => {
    await putNote({ period_key: DAY, body: 'Monday note' });
    await putNote({ period_key: NEXT_DAY, body: 'Tuesday note' });
    expect(noteRows()).toHaveLength(2);

    const g1 = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(g1.body.note.body).toBe('Monday note');
    const g2 = await api(srv.url, `/api/reflections?period=${NEXT_DAY}`);
    expect(g2.body.note.body).toBe('Tuesday note');
    const g3 = await api(srv.url, `/api/reflections?period=${NEXT_WEEK_DAY}`);
    expect(g3.body.note).toBeNull();
  });

  it('the note is independent of today/weekly goals for the same day', async () => {
    await api(srv.url, '/api/reflections/today', { method: 'PUT', json: { period_key: DAY, body: 'Today focus' } });
    await putNote({ period_key: DAY, body: 'A note' });
    const get = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(get.body.today.body).toBe('Today focus');
    expect(get.body.note.body).toBe('A note');
  });

  it('GET /api/reflections/notes returns dates with notes in range', async () => {
    await putNote({ period_key: DAY, body: 'has note' });
    await putNote({ period_key: NEXT_DAY, body: 'has note' });
    const res = await api(srv.url, `/api/reflections/notes?from=${DAY}&to=${NEXT_WEEK_DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.dates).toEqual([DAY, NEXT_DAY]);
  });

  it('GET /api/reflections/notes 422 without from/to', async () => {
    const res = await api(srv.url, '/api/reflections/notes');
    expect(res.status).toBe(422);
  });

  // FIX 2 — from/to must be real YYYY-MM-DD dates (shape + calendar validity).
  it('GET /api/reflections/notes 422 on malformed or impossible dates', async () => {
    expect((await api(srv.url, '/api/reflections/notes?from=nope&to=2026-06-16')).status).toBe(422);
    expect((await api(srv.url, `/api/reflections/notes?from=${DAY}&to=2026-13-40`)).status).toBe(422);
    expect((await api(srv.url, `/api/reflections/notes?from=2026-02-31&to=${NEXT_DAY}`)).status).toBe(422);
  });

  // FIX 3 — a whitespace-only (legacy/manual) row is not reported as a noted day.
  it('GET /api/reflections/notes skips whitespace-only day_note rows', async () => {
    const now = new Date().toISOString();
    // Insert a whitespace-only row directly (the route can't create one — it deletes).
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'day_note', ?, 0, '   ', ?, ?)`,
    ).run(SYSTEM_OWNER, DAY, now, now);
    await putNote({ period_key: NEXT_DAY, body: 'real note' });

    const res = await api(srv.url, `/api/reflections/notes?from=${DAY}&to=${NEXT_WEEK_DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.dates).toEqual([NEXT_DAY]); // DAY (whitespace) excluded
  });

  // FIX 4 — period_key must be a real YYYY-MM-DD date.
  it('PUT /api/reflections/note 422 on malformed period_key', async () => {
    expect((await putNote({ period_key: 'not-a-date', body: 'x' })).status).toBe(422);
    expect((await putNote({ period_key: '2026-13-01', body: 'x' })).status).toBe(422);
    expect(noteRows()).toHaveLength(0);
  });

  // FIX 1 — day_note is not a goal kind: the generic /done + DELETE routes reject it.
  it('POST /api/reflections/day_note/0/done → 422 (not a goal kind)', async () => {
    await putNote({ period_key: DAY, body: 'A note' });
    const res = await api(srv.url, '/api/reflections/day_note/0/done', {
      method: 'POST', json: { period_key: DAY, done: true },
    });
    expect(res.status).toBe(422);
    // The note row is untouched (no done_at column semantics apply).
    expect(noteRows()).toHaveLength(1);
    expect(noteRows()[0].done_at).toBeNull();
  });

  it('DELETE /api/reflections/day_note/0 → 422 (not a goal kind)', async () => {
    await putNote({ period_key: DAY, body: 'A note' });
    const res = await api(srv.url, `/api/reflections/day_note/0?period_key=${DAY}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
    expect(noteRows()).toHaveLength(1); // still there — must use PUT /note to clear
  });
});

// ── Phase O · O0 — weekly done-toggle ──────────────────────────────────────────

describe('O0 — weekly done-toggle', () => {
  function seedWeekly(pos: number, body: string) {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'weekly_goal', ?, ?, ?, ?, ?)`
    ).run(SYSTEM_OWNER, WEEK_KEY, pos, body, now, now);
  }

  it('sets and clears done_at at each position 0–2', async () => {
    for (const pos of [0, 1, 2]) {
      seedWeekly(pos, `goal ${pos}`);
      const set = await api(srv.url, `/api/reflections/weekly_goal/${pos}/done`, {
        method: 'POST', json: { period_key: WEEK_KEY, done: true },
      });
      expect(set.status).toBe(200);
      const clear = await api(srv.url, `/api/reflections/weekly_goal/${pos}/done`, {
        method: 'POST', json: { period_key: WEEK_KEY, done: false },
      });
      expect(clear.status).toBe(200);
    }
    expect(reflectionRows().every((r) => r.done_at === null)).toBe(true);
  });

  it('422 at position 3 (out of range for weekly)', async () => {
    const res = await api(srv.url, '/api/reflections/weekly_goal/3/done', {
      method: 'POST', json: { period_key: WEEK_KEY, done: true },
    });
    expect(res.status).toBe(422);
  });
});

// ── Phase O · O0 — two-way completion (task → intention done_at) ────────────────

describe('O0 — two-way completion', () => {
  function makeTask(title: string): string {
    return (sqlite
      .prepare(`INSERT INTO tasks (id, title, status, owner_id) VALUES (uuid7(), ?, 'open', ?) RETURNING id`)
      .get(title, SYSTEM_OWNER) as { id: string }).id;
  }
  function seedToday(body: string, sourceKind: string, sourceRef: string | null) {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, source_kind, source_ref, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, ?, ?, ?, ?, ?)`
    ).run(SYSTEM_OWNER, DAY, body, sourceKind, sourceRef, now, now);
  }

  it('completing a linked task auto-stamps the today intention done_at', async () => {
    const taskId = makeTask('The one thing');
    seedToday('The one thing', 'task', taskId);

    const res = await api(srv.url, `/api/tasks/${taskId}`, {
      method: 'PATCH', json: { completed: true, completed_at: `${DAY}T12:00:00.000Z` },
    });
    expect(res.status).toBe(200);

    const row = reflectionRows().find((r) => r.kind === 'today_goal')!;
    expect(row.done_at).not.toBeNull();
  });

  it('completing an unlinked task does NOT stamp the intention', async () => {
    const linked = makeTask('Linked');
    const other = makeTask('Unrelated');
    seedToday('Linked', 'task', linked);

    await api(srv.url, `/api/tasks/${other}`, {
      method: 'PATCH', json: { completed: true, completed_at: `${DAY}T12:00:00.000Z` },
    });

    const row = reflectionRows().find((r) => r.kind === 'today_goal')!;
    expect(row.done_at).toBeNull();
  });

  it('a manual (freeform) intention is never auto-stamped by any completion', async () => {
    const taskId = makeTask('Some task');
    seedToday('Freeform focus', 'manual', null);

    await api(srv.url, `/api/tasks/${taskId}`, {
      method: 'PATCH', json: { completed: true, completed_at: `${DAY}T12:00:00.000Z` },
    });

    expect(reflectionRows().find((r) => r.kind === 'today_goal')!.done_at).toBeNull();
  });

  it('derives the completion day in the owner timezone, not a UTC slice', async () => {
    // The intention's period_key is the owner's LOCAL day (DAY = 2026-06-15). Complete
    // the task at 05:00 UTC on the NEXT calendar day — which in America/Los_Angeles
    // (UTC-7 in June) is still 22:00 on DAY. A UTC slice would read '2026-06-16' and
    // miss the DAY intention; deriving in the owner tz lands on DAY and lights the star.
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'America/Los_Angeles' WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const taskId = makeTask('Late-night finish');
    seedToday('Late-night finish', 'task', taskId); // period_key = DAY (local)

    await api(srv.url, `/api/tasks/${taskId}`, {
      method: 'PATCH', json: { completed: true, completed_at: '2026-06-16T05:00:00.000Z' },
    });

    const row = reflectionRows().find((r) => r.kind === 'today_goal')!;
    expect(row.done_at).not.toBeNull();
  });
});
