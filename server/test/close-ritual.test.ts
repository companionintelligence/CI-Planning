import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { closeTask, isMood } from '../src/services/task-close.js';
import { taskMetrics } from '../src/services/task-metrics.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, extra?: { status?: string; completedAt?: string; estimated?: number; actual?: number }): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, actual_minutes, priority, completed_at)
         VALUES (uuid7(), ?, ?, ?, ?, ?, 3, ?) RETURNING id`,
      )
      .get(title, OWNER, extra?.status ?? 'open', extra?.estimated ?? 30, extra?.actual ?? 0, extra?.completedAt ?? null) as { id: string }
  ).id;
}
const row = (id: string) =>
  sqlite.prepare(`SELECT status, completed_at, reaction_at, completion_mood, completion_note, actual_minutes, notes FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>;

describe('isMood', () => {
  it('accepts exactly the four faces', () => {
    for (const m of ['happy', 'flat', 'frustrated', 'stressed']) expect(isMood(m)).toBe(true);
    for (const m of ['Happy', 'sad', '', 3, null, {}]) expect(isMood(m)).toBe(false);
  });
});

describe('closeTask', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('completes an open task and records the reflection', async () => {
    const id = insertTask('Write the memo');
    const res = closeTask(OWNER, id, { mood: 'happy', note: 'went fine', actualMinutes: 45 });
    expect(res.ok).toBe(true);
    const r = row(id);
    expect(r.status).toBe('done');
    expect(r.completed_at).toBeTruthy();
    expect(r.completion_mood).toBe('happy');
    expect(r.completion_note).toBe('went fine');
    expect(r.actual_minutes).toBe(45);
  });

  // The whole point of the separate column: a reflection can arrive long after the tick,
  // and the gap must stay measurable.
  it('stamps reaction_at WITHOUT touching an existing completed_at', async () => {
    const earlier = '2026-07-01T10:00:00.000Z';
    const id = insertTask('Finished last week', { status: 'done', completedAt: earlier });
    closeTask(OWNER, id, { mood: 'frustrated' });
    const r = row(id);
    expect(r.completed_at).toBe(earlier);                       // task end unchanged
    expect(Date.parse(r.reaction_at as string)).toBeGreaterThan(Date.parse(earlier)); // reacted later
  });

  it('does NOT stamp reaction_at for a duration-only correction', async () => {
    const id = insertTask('Timed wrong');
    const res = closeTask(OWNER, id, { actualMinutes: 90 });
    expect(res.ok && res.reactionAt).toBeNull();
    const r = row(id);
    expect(r.actual_minutes).toBe(90);
    expect(r.reaction_at).toBeNull(); // bookkeeping is not a reflection
  });

  it('never writes the reflection into `notes` (the description)', async () => {
    const id = insertTask('Has a description');
    sqlite.prepare(`UPDATE tasks SET notes = 'what this is about' WHERE id = ?`).run(id);
    closeTask(OWNER, id, { note: 'how it went' });
    const r = row(id);
    expect(r.notes).toBe('what this is about');   // untouched
    expect(r.completion_note).toBe('how it went'); // its own column
  });

  it('rejects an unknown mood rather than storing it', async () => {
    const id = insertTask('Bad mood value');
    closeTask(OWNER, id, { mood: 'ecstatic' });
    expect(row(id).completion_mood).toBeNull();
    expect(row(id).status).toBe('done'); // the completion still happened
  });

  it('drops absurd or negative durations instead of clamping them', async () => {
    const id = insertTask('Silly duration', { actual: 20 });
    closeTask(OWNER, id, { actualMinutes: -5 });
    expect(row(id).actual_minutes).toBe(20);
    closeTask(OWNER, id, { actualMinutes: 99_999 });
    expect(row(id).actual_minutes).toBe(20);
    closeTask(OWNER, id, { actualMinutes: 0 }); // 0 is meaningful and must land
    expect(row(id).actual_minutes).toBe(0);
  });

  it('404s a task belonging to nobody', async () => {
    const res = closeTask(OWNER, 'nope', { mood: 'happy' });
    expect(res).toEqual({ ok: false, error: 'not_found' });
  });

  it('POST /api/tasks/:id/close round-trips', async () => {
    const id = insertTask('Via HTTP');
    const { status, body } = await api(srv.url, `/api/tasks/${id}/close`, {
      method: 'POST', json: { mood: 'stressed', note: 'tight deadline', actual_minutes: 15 },
    });
    expect(status).toBe(200);
    expect(body.closed.mood).toBe('stressed');
    expect(body.closed.reaction_at).toBeTruthy();
    expect(body.task.status).toBe('done');
  });
});

// ── metrics ──────────────────────────────────────────────────────────────────

describe('taskMetrics', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  function seedTag(name: string, kind: string): string {
    sqlite.prepare(`INSERT OR IGNORE INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`).run(name, OWNER, kind);
    return (sqlite.prepare(`SELECT id FROM tags WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: string }).id;
  }
  const tagTask = (taskId: string, tagId: string) =>
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, tagId);
  const catTask = (taskId: string, catId: string) =>
    sqlite.prepare(`INSERT OR IGNORE INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, 0)`).run(taskId, catId);

  it('splits open vs completed per direction', async () => {
    const work = seedTag('work', 'direction');
    const home = seedTag('home', 'direction');
    const a = insertTask('open work'); tagTask(a, work);
    const b = insertTask('done work'); tagTask(b, work); closeTask(OWNER, b, { mood: 'happy', actualMinutes: 50 });
    const c = insertTask('open home'); tagTask(c, home);

    const m = taskMetrics(OWNER, 30);
    const w = m.directions.find((d) => d.name === 'work')!;
    expect(w).toMatchObject({ open: 1, completed: 1, actualMinutes: 50, moodSamples: 1 });
    expect(w.mood.happy).toBe(1);
    expect(m.directions.find((d) => d.name === 'home')).toMatchObject({ open: 1, completed: 0 });
  });

  // A task can carry up to three categories, so summing the axes double-counts. Totals
  // must come from the unjoined set.
  it('totals do not double-count a multi-category task', async () => {
    const health = seedTag('health', 'category');
    const career = seedTag('career', 'category');
    const t = insertTask('spans two areas');
    catTask(t, health); catTask(t, career);

    const m = taskMetrics(OWNER, 30);
    expect(m.categories.reduce((s, c) => s + c.open, 0)).toBe(2); // counted per axis…
    expect(m.totals.open).toBe(1);                                 // …but once overall
  });

  it('withholds estimate bias below the 3-sample floor', async () => {
    const work = seedTag('work', 'direction');
    for (let i = 0; i < 2; i++) {
      const id = insertTask(`t${i}`, { estimated: 30 });
      tagTask(id, work);
      closeTask(OWNER, id, { actualMinutes: 60 });
    }
    expect(taskMetrics(OWNER, 30).directions[0].estimateBias).toBeNull();

    const id = insertTask('t3', { estimated: 30 });
    tagTask(id, work);
    closeTask(OWNER, id, { actualMinutes: 60 });
    expect(taskMetrics(OWNER, 30).directions[0].estimateBias).toBe(2); // 60/30 median
  });

  it('excludes completions older than the window', async () => {
    const work = seedTag('work', 'direction');
    const old = insertTask('ancient', { status: 'done', completedAt: '2020-01-01T00:00:00.000Z' });
    tagTask(old, work);
    expect(taskMetrics(OWNER, 30).directions.length).toBe(0);
  });

  it('GET /api/metrics/tasks answers the axis shape', async () => {
    const { status, body } = await api(srv.url, '/api/metrics/tasks?days=30');
    expect(status).toBe(200);
    expect(body).toHaveProperty('directions');
    expect(body).toHaveProperty('categories');
    expect(body.window.days).toBe(30);
  });

  it('clamps an absurd window instead of scanning all history', async () => {
    const { body } = await api(srv.url, '/api/metrics/tasks?days=99999');
    expect(body.window.days).toBe(365);
  });
});
