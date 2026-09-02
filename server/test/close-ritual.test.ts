import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { closeTask, isRating, isScore, DECLINED_SCORE } from '../src/services/task-close.js';
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
  sqlite.prepare(`SELECT status, completed_at, reaction_at, completion_score, completion_note, actual_minutes, notes FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>;

/** A habit occurrence — a real task row with a parent, which is what actually gets rated. */
function insertHabitOccurrence(title: string): string {
  const parent = (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, subtype, priority) VALUES (uuid7(), ?, ?, 'recurring', 'habit', 3) RETURNING id`,
  ).get(`${title} template`, OWNER) as { id: string }).id;
  return (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, subtype, priority, recurrence_parent_id, occurrence_date, estimated_minutes)
     VALUES (uuid7(), ?, ?, 'open', 'habit', 3, ?, '2026-08-29', 15) RETURNING id`,
  ).get(title, OWNER, parent) as { id: string }).id;
}

describe('score vocabulary', () => {
  it('isRating accepts exactly 1-5', () => {
    for (const v of [1, 2, 3, 4, 5]) expect(isRating(v)).toBe(true);
    for (const v of [0, -1, 6, 2.5, '3', null, {}]) expect(isRating(v)).toBe(false);
  });

  // DECLINED is storable but is NOT a rating — the whole point of keeping them separate.
  it('isScore additionally accepts DECLINED, which isRating rejects', () => {
    expect(isScore(DECLINED_SCORE)).toBe(true);
    expect(isRating(DECLINED_SCORE)).toBe(false);
    expect(isScore(6)).toBe(false);
  });
});

describe('closeTask', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('completes an open task and records the reflection', async () => {
    const id = insertTask('Write the memo');
    const res = await closeTask(OWNER, id, { score: 5, note: 'went fine', actualMinutes: 45 });
    expect(res.ok).toBe(true);
    const r = row(id);
    expect(r.status).toBe('done');
    expect(r.completed_at).toBeTruthy();
    expect(r.completion_score).toBe(5);
    expect(r.completion_note).toBe('went fine');
    expect(r.actual_minutes).toBe(45);
  });

  // The whole point of the separate column: a reflection can arrive long after the tick,
  // and the gap must stay measurable.
  it('stamps reaction_at WITHOUT touching an existing completed_at', async () => {
    const earlier = '2026-07-01T10:00:00.000Z';
    const id = insertTask('Finished last week', { status: 'done', completedAt: earlier });
    await closeTask(OWNER, id, { score: 2 });
    const r = row(id);
    expect(r.completed_at).toBe(earlier);                       // task end unchanged
    expect(Date.parse(r.reaction_at as string)).toBeGreaterThan(Date.parse(earlier)); // reacted later
  });

  it('does NOT stamp reaction_at for a duration-only correction', async () => {
    const id = insertTask('Timed wrong');
    const res = await closeTask(OWNER, id, { actualMinutes: 90 });
    expect(res.ok && res.reactionAt).toBeNull();
    const r = row(id);
    expect(r.actual_minutes).toBe(90);
    expect(r.reaction_at).toBeNull(); // bookkeeping is not a reflection
  });

  it('never writes the reflection into `notes` (the description)', async () => {
    const id = insertTask('Has a description');
    sqlite.prepare(`UPDATE tasks SET notes = 'what this is about' WHERE id = ?`).run(id);
    await closeTask(OWNER, id, { note: 'how it went' });
    const r = row(id);
    expect(r.notes).toBe('what this is about');   // untouched
    expect(r.completion_note).toBe('how it went'); // its own column
  });

  it('rejects an out-of-range score rather than storing it', async () => {
    const id = insertTask('Bad score value');
    await closeTask(OWNER, id, { score: 9 });
    expect(row(id).completion_score).toBeNull();
    expect(row(id).status).toBe('done'); // the completion still happened
  });

  // The DECLINED contract, which is what keeps a dismissal from masquerading as a rating.
  it('stores DECLINED without stamping reaction_at', async () => {
    const id = insertTask('Dismissed');
    const res = await closeTask(OWNER, id, { score: DECLINED_SCORE });
    expect(res.ok && res.reactionAt).toBeNull();
    const r = row(id);
    expect(r.completion_score).toBe(DECLINED_SCORE);
    expect(r.reaction_at).toBeNull();
    expect(r.status).toBe('done');
  });

  // Regression for the 0161 rationale: were a dismissal stored as 3, it would both
  // pollute the mean and — via reaction_at — displace a real rating in triality's window.
  it('a decline is not a 3', async () => {
    const id = insertTask('Dismissed again');
    await closeTask(OWNER, id, { score: DECLINED_SCORE });
    expect(row(id).completion_score).not.toBe(3);
  });

  // The client guard is gone (0161); the server never had one. Pin that.
  it('rates a habit occurrence like any other task', async () => {
    const id = insertHabitOccurrence('Morning pages');
    const res = await closeTask(OWNER, id, { score: 4, actualMinutes: 12 });
    expect(res.ok).toBe(true);
    const r = row(id);
    expect(r.completion_score).toBe(4);
    expect(r.reaction_at).toBeTruthy();
  });

  it('drops absurd or negative durations instead of clamping them', async () => {
    const id = insertTask('Silly duration', { actual: 20 });
    await closeTask(OWNER, id, { actualMinutes: -5 });
    expect(row(id).actual_minutes).toBe(20);
    await closeTask(OWNER, id, { actualMinutes: 99_999 });
    expect(row(id).actual_minutes).toBe(20);
    await closeTask(OWNER, id, { actualMinutes: 0 }); // 0 is meaningful and must land
    expect(row(id).actual_minutes).toBe(0);
  });

  it('404s a task belonging to nobody', async () => {
    const res = await closeTask(OWNER, 'nope', { score: 5 });
    expect(res).toEqual({ ok: false, error: 'not_found' });
  });

  it('POST /api/tasks/:id/close round-trips', async () => {
    const id = insertTask('Via HTTP');
    const { status, body } = await api(srv.url, `/api/tasks/${id}/close`, {
      method: 'POST', json: { score: 1, note: 'tight deadline', actual_minutes: 15 },
    });
    expect(status).toBe(200);
    expect(body.closed.score).toBe(1);
    expect(body.closed.reaction_at).toBeTruthy();
    expect(body.task.status).toBe('done');
  });

  // Before 0161 an unknown value returned 200 having written nothing, so a client bug was
  // indistinguishable from success and the rating vanished silently.
  it('400s a present-but-invalid score instead of silently dropping it', async () => {
    const id = insertTask('Bad HTTP score');
    const { status } = await api(srv.url, `/api/tasks/${id}/close`, {
      method: 'POST', json: { score: 7 },
    });
    expect(status).toBe(400);
    expect(row(id).completion_score).toBeNull();
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
    const b = insertTask('done work'); tagTask(b, work); await closeTask(OWNER, b, { score: 5, actualMinutes: 50 });
    const c = insertTask('open home'); tagTask(c, home);

    const m = await taskMetrics(OWNER, 30);
    const w = m.directions.find((d) => d.name === 'work')!;
    expect(w).toMatchObject({ open: 1, completed: 1, actualMinutes: 50 });
    expect(w.score.samples).toBe(1);
    expect(w.score.counts[5]).toBe(1);
    expect(w.score.mean).toBe(5);
    expect(m.directions.find((d) => d.name === 'home')).toMatchObject({ open: 1, completed: 0 });
  });

  // A task can carry up to three categories, so summing the axes double-counts. Totals
  // must come from the unjoined set.
  /**
   * Scheduled-and-cancelled: work that held a slot and was given up on. It is neither
   * open nor completed, so it gets its own count rather than being folded into either.
   *
   * "Held a slot" is read off the retained cancelled BLOCK — `cancelBlocksForTask`
   * settles placements instead of deleting them, so the evidence is already durable and
   * the metric needs no cancelled_at column.
   */
  describe('scheduled-and-cancelled', () => {
    /** A settled placement: exactly what cancelling a scheduled task leaves behind. */
    function cancelledBlock(taskId: string, startAt: string): void {
      sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, task_id, start_at, end_at, status, source_kind, owner_id)
           VALUES (uuid7(), 'slot', 'task', ?, ?, ?, 'cancelled', 'manual', ?)`,
        )
        .run(taskId, startAt, startAt, OWNER);
    }
    const recently = () => new Date(Date.now() - 2 * 86_400_000).toISOString();

    it('counts a cancelled task that held a slot, in neither open nor completed', async () => {
      const work = seedTag('work', 'direction');
      const t = insertTask('abandoned', { status: 'cancelled' });
      tagTask(t, work);
      cancelledBlock(t, recently());

      const m = await taskMetrics(OWNER, 30);
      expect(m.totals).toMatchObject({ cancelled: 1, open: 0, completed: 0 });
      expect(m.directions.find((d) => d.name === 'work')).toMatchObject({ cancelled: 1, open: 0, completed: 0 });
    });

    it('ignores a cancelled task that never held a slot', async () => {
      // Abandoned straight out of the backlog. Real, but not what this number measures —
      // dropping something you never committed to a time is not the same failure.
      const t = insertTask('never scheduled', { status: 'cancelled' });
      tagTask(t, seedTag('work', 'direction'));

      const m = await taskMetrics(OWNER, 30);
      expect(m.totals.cancelled).toBe(0);
      expect(m.totals.open).toBe(0); // and it must not leak into open either
    });

    it('ignores a slot outside the window', async () => {
      const t = insertTask('old abandonment', { status: 'cancelled' });
      cancelledBlock(t, new Date(Date.now() - 90 * 86_400_000).toISOString());

      expect((await taskMetrics(OWNER, 30)).totals.cancelled).toBe(0);
      expect((await taskMetrics(OWNER, 365)).totals.cancelled).toBe(1); // widen and it appears
    });

    it('does not count a live placement — only a settled one is evidence of giving up', async () => {
      const t = insertTask('still going', { status: 'cancelled' });
      sqlite
        .prepare(
          `INSERT INTO time_blocks (id, title, block_kind, task_id, start_at, end_at, status, source_kind, owner_id)
           VALUES (uuid7(), 'slot', 'task', ?, ?, ?, 'planned', 'manual', ?)`,
        )
        .run(t, recently(), recently(), OWNER);

      expect((await taskMetrics(OWNER, 30)).totals.cancelled).toBe(0);
    });

    it('leaves open and completed counts untouched', async () => {
      const open = insertTask('open one');
      const done = insertTask('done one'); await closeTask(OWNER, done, { actualMinutes: 10 });
      const dropped = insertTask('dropped one', { status: 'cancelled' });
      cancelledBlock(dropped, recently());

      const m = await taskMetrics(OWNER, 30);
      expect(m.totals).toMatchObject({ open: 1, completed: 1, cancelled: 1 });
      expect(open && done).toBeTruthy();
    });
  });

  it('totals do not double-count a multi-category task', async () => {
    const health = seedTag('health', 'category');
    const career = seedTag('career', 'category');
    const t = insertTask('spans two areas');
    catTask(t, health); catTask(t, career);

    const m = await taskMetrics(OWNER, 30);
    expect(m.categories.reduce((s, c) => s + c.open, 0)).toBe(2); // counted per axis…
    expect(m.totals.open).toBe(1);                                 // …but once overall
  });

  it('withholds estimate bias below the 3-sample floor', async () => {
    const work = seedTag('work', 'direction');
    for (let i = 0; i < 2; i++) {
      const id = insertTask(`t${i}`, { estimated: 30 });
      tagTask(id, work);
      await closeTask(OWNER, id, { actualMinutes: 60 });
    }
    expect((await taskMetrics(OWNER, 30)).directions[0].estimateBias).toBeNull();

    const id = insertTask('t3', { estimated: 30 });
    tagTask(id, work);
    await closeTask(OWNER, id, { actualMinutes: 60 });
    expect((await taskMetrics(OWNER, 30)).directions[0].estimateBias).toBe(2); // 60/30 median
  });

  it('excludes completions older than the window', async () => {
    const work = seedTag('work', 'direction');
    const old = insertTask('ancient', { status: 'done', completedAt: '2020-01-01T00:00:00.000Z' });
    tagTask(old, work);
    expect((await taskMetrics(OWNER, 30)).directions.length).toBe(0);
  });

  // 0161: habit ratings belong on the tab, but in their own bucket. The task numbers must
  // not move when a habit is rated — that separation is the whole of the owner's request.
  it('reports habits separately and leaves the task numbers alone', async () => {
    const t = insertTask('a real task');
    await closeTask(OWNER, t, { score: 5, actualMinutes: 40 });
    const h = insertHabitOccurrence('Stretch');
    await closeTask(OWNER, h, { score: 2, actualMinutes: 10 });

    const m = await taskMetrics(OWNER, 30);
    expect(m.totals.completed).toBe(1);
    expect(m.totals.actualMinutes).toBe(40);
    expect(m.totals.score.mean).toBe(5);

    expect(m.habits.totals.completed).toBe(1);
    expect(m.habits.totals.actualMinutes).toBe(10);
    expect(m.habits.totals.score.mean).toBe(2);
  });

  // The bug this feature would otherwise have shipped with: rate a habit, see nothing.
  it('a rated habit is no longer invisible', async () => {
    const h = insertHabitOccurrence('Walk');
    await closeTask(OWNER, h, { score: 4 });
    expect((await taskMetrics(OWNER, 30)).habits.totals.score.samples).toBe(1);
  });

  it('counts declines apart from ratings', async () => {
    const a = insertTask('rated');    await closeTask(OWNER, a, { score: 3 });
    const b = insertTask('declined'); await closeTask(OWNER, b, { score: DECLINED_SCORE });

    const t = (await taskMetrics(OWNER, 30)).totals.score;
    expect(t.samples).toBe(1);
    expect(t.declined).toBe(1);
    expect(t.mean).toBe(3); // the decline must not drag it
  });

  // The habit TEMPLATE is permanently 'recurring', so it used to sit in `open` forever.
  it('does not count a habit template as an open task', async () => {
    insertHabitOccurrence('Has a template');
    expect((await taskMetrics(OWNER, 30)).totals.open).toBe(0);
  });

  it('GET /api/metrics/tasks answers the axis shape', async () => {
    const { status, body } = await api(srv.url, '/api/metrics/tasks?days=30');
    expect(status).toBe(200);
    expect(body).toHaveProperty('directions');
    expect(body).toHaveProperty('categories');
    expect(body).toHaveProperty('habits');
    expect(body.window.days).toBe(30);
  });

  it('clamps an absurd window instead of scanning all history', async () => {
    const { body } = await api(srv.url, '/api/metrics/tasks?days=99999');
    expect(body.window.days).toBe(365);
  });
});
