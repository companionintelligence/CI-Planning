/**
 * Phase O · O2 — the five-star day engine, freeze job, and GET /api/stars.
 *
 * Tests the locked star model: each star flips on exactly its condition, the
 * empty-set rule holds, bonus needs an UNPLANNED completion, reflection needs a
 * done task + a note, and a frozen day never recomputes. Pinned dates (TZ=UTC).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { computeStars } from '../src/engine/stars.js';
import { freezeStars } from '../src/jobs/freeze-stars.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const DAY = '2026-06-15';        // Monday
const NEXT_DAY = '2026-06-16';
const TODAY = '2026-06-17';      // the pinned "now" for freeze tests

// ── Seed helpers (mirror summary-top-tasks.test.ts idioms) ─────────────────────
function makeTask(opts: {
  title: string; subtype?: string; priority?: number; recurrenceParentId?: string | null;
  status?: string; occurrenceDate?: string | null; completedAt?: string | null;
}): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, subtype, priority, recurrence_parent_id, status, occurrence_date, completed_at, owner_id)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      opts.title, opts.subtype ?? 'standard', opts.priority ?? 3,
      opts.recurrenceParentId ?? null, opts.status ?? 'open',
      opts.occurrenceDate ?? null, opts.completedAt ?? null, SYSTEM_OWNER,
    ) as { id: string }).id;
}
function plan(taskId: string, position: number, date = DAY) {
  sqlite.prepare(
    `INSERT INTO daily_plan (owner_id, date, task_id, position) VALUES (?, ?, ?, ?)`,
  ).run(SYSTEM_OWNER, date, taskId, position);
}
function makeRoutineMember(title: string): string {
  const t = makeTask({ title });
  const now = new Date().toISOString();
  const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, name, created_at) VALUES (uuid7(), ?, 'Morning', ?) RETURNING id`)
    .get(SYSTEM_OWNER, now) as { id: string }).id;
  sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(pid, t);
  return t;
}
function setToday(body: string, done: boolean, date = DAY) {
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO reflections (owner_id, kind, period_key, position, body, done_at, created_at, updated_at)
     VALUES (?, 'today_goal', ?, 0, ?, ?, ?, ?)`,
  ).run(SYSTEM_OWNER, date, body, done ? now : null, now, now);
}
function setNote(body: string, date = DAY) {
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
     VALUES (?, 'day_note', ?, 0, ?, ?, ?)`,
  ).run(SYSTEM_OWNER, date, body, now, now);
}
const at = (date: string, hh = '12') => `${date}T${hh}:00:00.000Z`;
const stars = (date = DAY) => runWithOwner(SYSTEM_OWNER, () => computeStars(SYSTEM_OWNER, date));

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

// ── S1 objective ───────────────────────────────────────────────────────────────
describe('computeStars — S1 objective', () => {
  it('false when no today_goal', () => { expect(stars().objective).toBe(false); });
  it('false when today_goal not done', () => { setToday('Ship it', false); expect(stars().objective).toBe(false); });
  it('true when today_goal has done_at', () => { setToday('Ship it', true); expect(stars().objective).toBe(true); });
});

// ── S2 habits (empty-set rule) ──────────────────────────────────────────────────
describe('computeStars — S2 habits', () => {
  it('false when no habit instance exists that day (empty-set rule)', () => {
    expect(stars().habits).toBe(false);
  });
  it('false when a habit instance is not done', () => {
    makeTask({ title: 'Meditate', subtype: 'habit', occurrenceDate: DAY, status: 'open' });
    expect(stars().habits).toBe(false);
  });
  it('true when the single habit instance is done', () => {
    makeTask({ title: 'Meditate', subtype: 'habit', occurrenceDate: DAY, status: 'done' });
    expect(stars().habits).toBe(true);
  });
  it('false when one of two habit instances is undone', () => {
    makeTask({ title: 'A', subtype: 'habit', occurrenceDate: DAY, status: 'done' });
    makeTask({ title: 'B', subtype: 'habit', occurrenceDate: DAY, status: 'open' });
    expect(stars().habits).toBe(false);
  });
  it('ignores habit instances on another day', () => {
    makeTask({ title: 'Yesterday', subtype: 'habit', occurrenceDate: NEXT_DAY, status: 'open' });
    expect(stars().habits).toBe(false);
  });
});

// ── S3 tasks (empty-set rule + habit/routine exclusion) ─────────────────────────
describe('computeStars — S3 tasks', () => {
  it('false when nothing is planned (empty-set rule)', () => {
    expect(stars().tasks).toBe(false);
  });
  it('false when a planned task is still open', () => {
    plan(makeTask({ title: 'A', status: 'open' }), 0);
    expect(stars().tasks).toBe(false);
  });
  it('true when the single planned task is done', () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    expect(stars().tasks).toBe(true);
  });
  it('false when one of two planned tasks is open', () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    plan(makeTask({ title: 'B', status: 'open' }), 1);
    expect(stars().tasks).toBe(false);
  });
  it('a planned habit does NOT count toward the tasks star (empty-set holds)', () => {
    plan(makeTask({ title: 'Habit', subtype: 'habit', status: 'done' }), 0);
    expect(stars().tasks).toBe(false); // only a habit planned → no plannable task
  });
  it('a planned routine member does NOT count toward the tasks star', () => {
    plan(makeRoutineMember('Routine'), 0);
    expect(stars().tasks).toBe(false);
  });
  it('a planned open habit alongside a done plannable task still earns it', () => {
    plan(makeTask({ title: 'Habit', subtype: 'habit', status: 'open' }), 0); // excluded
    plan(makeTask({ title: 'Real', status: 'done' }), 1);
    expect(stars().tasks).toBe(true);
  });
});

// ── S4 bonus (unplanned completion) ─────────────────────────────────────────────
describe('computeStars — S4 bonus', () => {
  it('false with no completions', () => { expect(stars().bonus).toBe(false); });
  it('completing a PLANNED task does NOT earn the bonus', () => {
    const t = makeTask({ title: 'Planned', status: 'done', completedAt: at(DAY) });
    plan(t, 0);
    expect(stars().bonus).toBe(false);
  });
  it('completing an UNPLANNED task earns the bonus', () => {
    makeTask({ title: 'Surprise win', status: 'done', completedAt: at(DAY) });
    expect(stars().bonus).toBe(true);
  });
  it('an unplanned HABIT completion does NOT earn the bonus', () => {
    makeTask({ title: 'Habit', subtype: 'habit', status: 'done', completedAt: at(DAY), occurrenceDate: DAY });
    expect(stars().bonus).toBe(false);
  });
  it('an unplanned ROUTINE completion does NOT earn the bonus', () => {
    const t = makeRoutineMember('Routine');
    sqlite.prepare(`UPDATE tasks SET status='done', completed_at=? WHERE id=?`).run(at(DAY), t);
    expect(stars().bonus).toBe(false);
  });
  it('a completion on another day does not earn today\'s bonus', () => {
    makeTask({ title: 'Yesterday', status: 'done', completedAt: at(NEXT_DAY) });
    expect(stars().bonus).toBe(false);
  });
});

// ── S5 reflection (done task + note) ────────────────────────────────────────────
describe('computeStars — S5 reflection', () => {
  it('false with a note but no completed task', () => {
    setNote('Reflecting');
    expect(stars().note).toBe(false);
  });
  it('false with a completed task but no note', () => {
    makeTask({ title: 'Done', status: 'done', completedAt: at(DAY) });
    expect(stars().note).toBe(false);
  });
  it('false when the note is only whitespace', () => {
    makeTask({ title: 'Done', status: 'done', completedAt: at(DAY) });
    setNote('   ');
    expect(stars().note).toBe(false);
  });
  it('true with both a completed task and a non-empty note', () => {
    makeTask({ title: 'Done', status: 'done', completedAt: at(DAY) });
    setNote('Great day');
    expect(stars().note).toBe(true);
  });
});

// ── total ────────────────────────────────────────────────────────────────────
describe('computeStars — total', () => {
  it('total equals the count of true flags (a perfect 5-star day)', () => {
    setToday('The one thing', true);                                              // S1
    makeTask({ title: 'Habit', subtype: 'habit', occurrenceDate: DAY, status: 'done' }); // S2
    plan(makeTask({ title: 'Planned', status: 'done', completedAt: at(DAY) }), 0);  // S3
    makeTask({ title: 'Bonus', status: 'done', completedAt: at(DAY) });            // S4 (unplanned)
    setNote('Reflected');                                                          // S5 (done task exists)
    const s = stars();
    expect(s).toMatchObject({ objective: true, habits: true, tasks: true, bonus: true, note: true, total: 5 });
  });
  it('empty day scores zero', () => {
    expect(stars().total).toBe(0);
  });
});

// ── freeze job ──────────────────────────────────────────────────────────────────
describe('freezeStars — nightly snapshot', () => {
  function frozenRow(date = DAY) {
    return sqlite.prepare(`SELECT * FROM day_stars WHERE owner_id=? AND date=?`).get(SYSTEM_OWNER, date) as any;
  }

  it('snapshots the day that just ended (yesterday relative to today)', () => {
    setToday('Done goal', true);
    const r = runWithOwner(SYSTEM_OWNER, () => freezeStars(undefined, NEXT_DAY)); // yesterday = DAY
    expect(r.date).toBe(DAY);
    const row = frozenRow();
    expect(row).toMatchObject({ star_objective: 1, total: 1 });
  });

  it('a later edit to a frozen past day leaves the frozen row unchanged', () => {
    // Freeze DAY with a single done goal → total 1.
    setToday('Goal', true);
    runWithOwner(SYSTEM_OWNER, () => freezeStars(DAY, TODAY));
    expect(frozenRow().total).toBe(1);

    // Later: complete an unplanned task on DAY (would be +1 live). Frozen row must not change.
    makeTask({ title: 'Late win', status: 'done', completedAt: at(DAY) });
    expect(runWithOwner(SYSTEM_OWNER, () => computeStars(SYSTEM_OWNER, DAY)).total).toBe(2); // live sees it
    expect(frozenRow().total).toBe(1); // frozen unchanged (no re-freeze)
  });

  it('is idempotent — re-running overwrites with the same value', () => {
    setToday('Goal', true);
    runWithOwner(SYSTEM_OWNER, () => freezeStars(DAY, TODAY));
    runWithOwner(SYSTEM_OWNER, () => freezeStars(DAY, TODAY));
    const rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM day_stars WHERE owner_id=? AND date=?`).get(SYSTEM_OWNER, DAY) as { n: number };
    expect(rows.n).toBe(1);
    expect(frozenRow().total).toBe(1);
  });
});

// ── GET /api/stars ──────────────────────────────────────────────────────────────
describe('GET /api/stars', () => {
  it('422 without from/to', async () => {
    expect((await api(srv.url, '/api/stars')).status).toBe(422);
  });

  it('computes live for days with no frozen row', async () => {
    setToday('Goal', true);
    const res = await api(srv.url, `/api/stars?from=${DAY}&to=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ date: DAY, objective: true, total: 1, frozen: false });
  });

  it('returns one row per date across the range', async () => {
    const res = await api(srv.url, `/api/stars?from=${DAY}&to=${NEXT_DAY}`);
    expect(res.body.map((r: any) => r.date)).toEqual([DAY, NEXT_DAY]);
    expect(res.body.every((r: any) => r.frozen === false)).toBe(true);
  });

  it('returns the FROZEN row over the live value', async () => {
    // Freeze DAY at total 1.
    setToday('Goal', true);
    runWithOwner(SYSTEM_OWNER, () => freezeStars(DAY, TODAY));
    // Change the live world so recompute would give 2.
    makeTask({ title: 'Late win', status: 'done', completedAt: at(DAY) });

    const res = await api(srv.url, `/api/stars?from=${DAY}&to=${DAY}`);
    expect(res.body[0]).toMatchObject({ date: DAY, total: 1, frozen: true });
  });
});
