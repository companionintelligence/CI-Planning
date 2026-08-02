/**
 * Phase O · O2 — the five-star day engine, freeze job, and GET /api/stars.
 *
 * Tests the locked star model: each star flips on exactly its condition, the
 * empty-set rule holds, bonus needs an UNPLANNED completion, reflection needs a
 * done task + a note, and a frozen day never recomputes. Pinned dates (TZ=UTC).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
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
  scheduledFor?: string | null;
}): string {
  return (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, subtype, priority, recurrence_parent_id, status, occurrence_date, completed_at, scheduled_for, owner_id)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      opts.title, opts.subtype ?? 'standard', opts.priority ?? 3,
      opts.recurrenceParentId ?? null, opts.status ?? 'open',
      opts.occurrenceDate ?? null, opts.completedAt ?? null, opts.scheduledFor ?? null, SYSTEM_OWNER,
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
// A full UTC instant (freezeStars' 2nd arg is now a `nowISO`, not a bare date).
const iso = (date: string, hhmm = '00:20') => `${date}T${hhmm}:00.000Z`;
const stars = (date = DAY) => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => computeStars(SYSTEM_OWNER, date));

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

// ── S1 objective ───────────────────────────────────────────────────────────────
describe('computeStars — S1 objective', () => {
  it('false when no today_goal', async () => { expect((await stars()).objective).toBe(false); });
  it('false when today_goal not done', async () => { setToday('Ship it', false); expect((await stars()).objective).toBe(false); });
  it('true when today_goal has done_at', async () => { setToday('Ship it', true); expect((await stars()).objective).toBe(true); });
});

// ── S2 habits (empty-set rule) ──────────────────────────────────────────────────
describe('computeStars — S2 habits', () => {
  it('false when no habit instance exists that day (empty-set rule)', async () => {
    expect((await stars()).habits).toBe(false);
  });
  it('false when a habit instance is not done', async () => {
    makeTask({ title: 'Meditate', subtype: 'habit', occurrenceDate: DAY, status: 'open' });
    expect((await stars()).habits).toBe(false);
  });
  it('true when the single habit instance is done', async () => {
    makeTask({ title: 'Meditate', subtype: 'habit', occurrenceDate: DAY, status: 'done' });
    expect((await stars()).habits).toBe(true);
  });
  it('false when one of two habit instances is undone', async () => {
    makeTask({ title: 'A', subtype: 'habit', occurrenceDate: DAY, status: 'done' });
    makeTask({ title: 'B', subtype: 'habit', occurrenceDate: DAY, status: 'open' });
    expect((await stars()).habits).toBe(false);
  });
  it('ignores habit instances on another day', async () => {
    makeTask({ title: 'Yesterday', subtype: 'habit', occurrenceDate: NEXT_DAY, status: 'open' });
    expect((await stars()).habits).toBe(false);
  });
});

// ── S3 tasks (empty-set rule + habit/routine exclusion) ─────────────────────────
describe('computeStars — S3 tasks', () => {
  it('false when nothing is planned (empty-set rule)', async () => {
    expect((await stars()).tasks).toBe(false);
  });
  it('false when a planned task is still open', async () => {
    plan(makeTask({ title: 'A', status: 'open' }), 0);
    expect((await stars()).tasks).toBe(false);
  });
  it('true when the single planned task is done', async () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    expect((await stars()).tasks).toBe(true);
  });
  it('false when one of two planned tasks is open', async () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    plan(makeTask({ title: 'B', status: 'open' }), 1);
    expect((await stars()).tasks).toBe(false);
  });
  it('a planned habit does NOT count toward the tasks star (empty-set holds)', async () => {
    plan(makeTask({ title: 'Habit', subtype: 'habit', status: 'done' }), 0);
    expect((await stars()).tasks).toBe(false); // only a habit planned → no plannable task
  });
  it('a planned routine member does NOT count toward the tasks star', async () => {
    plan(makeRoutineMember('Routine'), 0);
    expect((await stars()).tasks).toBe(false);
  });
  it('a planned open habit alongside a done plannable task still earns it', async () => {
    plan(makeTask({ title: 'Habit', subtype: 'habit', status: 'open' }), 0); // excluded
    plan(makeTask({ title: 'Real', status: 'done' }), 1);
    expect((await stars()).tasks).toBe(true);
  });
  // FIX 1 — cancelling a planned task (soft-delete leaves the daily_plan row)
  // must drop it from the "for the day" set so the star can still light.
  it('cancelling a planned task removes it from the set (star still earns)', async () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    plan(makeTask({ title: 'B', status: 'cancelled' }), 1); // soft-deleted, plan row survives
    expect((await stars()).tasks).toBe(true);
  });
  it('a skipped planned recurring instance does not keep the star dark', async () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    plan(makeTask({ title: 'Skipped', status: 'skipped' }), 1);
    expect((await stars()).tasks).toBe(true);
  });
  it('a MISSED planned task is a genuine incompletion and keeps the star dark', async () => {
    plan(makeTask({ title: 'A', status: 'done' }), 0);
    plan(makeTask({ title: 'Missed', status: 'missed' }), 1);
    expect((await stars()).tasks).toBe(false);
  });
  it('only a cancelled planned task means no plannable task remains (empty-set)', async () => {
    plan(makeTask({ title: 'B', status: 'cancelled' }), 0);
    expect((await stars()).tasks).toBe(false);
  });

  // Path-independence: HOW a task was scheduled must not change its star. A
  // self-scheduled task (scheduled_for = date; quick-add / New Task / drag — no
  // daily_plan row, which only the AI authoring path writes) is planned work.
  it('a self-scheduled (scheduled_for) done task earns S3 with no daily_plan row at all', async () => {
    makeTask({ title: 'Self-placed', status: 'done', scheduledFor: DAY });
    expect((await stars()).tasks).toBe(true);
  });
  it('a self-scheduled task still open keeps S3 dark', async () => {
    makeTask({ title: 'Self-placed', status: 'open', scheduledFor: DAY });
    expect((await stars()).tasks).toBe(false);
  });
  it('authored ∪ self-scheduled: ALL planned tasks must be done, whichever way they were planned', async () => {
    plan(makeTask({ title: 'Authored', status: 'done' }), 0);
    makeTask({ title: 'Self-placed', status: 'open', scheduledFor: DAY });
    expect((await stars()).tasks).toBe(false);
  });
  it('a task scheduled for ANOTHER day is not part of this day\'s planned set', async () => {
    makeTask({ title: 'Tomorrow', status: 'open', scheduledFor: NEXT_DAY });
    expect((await stars()).tasks).toBe(false); // empty-set rule, not an incompletion
  });
  it('a task both authored AND self-scheduled counts once', async () => {
    const t = makeTask({ title: 'Both', status: 'done', scheduledFor: DAY });
    plan(t, 0);
    expect((await stars()).tasks).toBe(true);
  });
});

// ── S4 bonus (unplanned completion) ─────────────────────────────────────────────
describe('computeStars — S4 bonus', () => {
  it('false with no completions', async () => { expect((await stars()).bonus).toBe(false); });
  it('completing a PLANNED task does NOT earn the bonus', async () => {
    const t = makeTask({ title: 'Planned', status: 'done', completedAt: at(DAY) });
    plan(t, 0);
    expect((await stars()).bonus).toBe(false);
  });
  it('completing an UNPLANNED task earns the bonus', async () => {
    makeTask({ title: 'Surprise win', status: 'done', completedAt: at(DAY) });
    expect((await stars()).bonus).toBe(true);
  });
  it('an unplanned HABIT completion does NOT earn the bonus', async () => {
    makeTask({ title: 'Habit', subtype: 'habit', status: 'done', completedAt: at(DAY), occurrenceDate: DAY });
    expect((await stars()).bonus).toBe(false);
  });
  it('an unplanned ROUTINE completion does NOT earn the bonus', async () => {
    const t = makeRoutineMember('Routine');
    sqlite.prepare(`UPDATE tasks SET status='done', completed_at=? WHERE id=?`).run(at(DAY), t);
    expect((await stars()).bonus).toBe(false);
  });
  it('a completion on another day does not earn today\'s bonus', async () => {
    makeTask({ title: 'Yesterday', status: 'done', completedAt: at(NEXT_DAY) });
    expect((await stars()).bonus).toBe(false);
  });

  // The S4 exclusion mirrors S3's widened planned set: a self-scheduled completion
  // is planned work (S3), never double-counted as an unplanned win.
  it('completing a SELF-SCHEDULED task does NOT earn the bonus (it earns S3 instead)', async () => {
    makeTask({ title: 'Self-placed', status: 'done', completedAt: at(DAY), scheduledFor: DAY });
    const s = await stars();
    expect(s.bonus).toBe(false);
    expect(s.tasks).toBe(true);
  });
  it('a task scheduled for ANOTHER day but completed today still earns the bonus', async () => {
    makeTask({ title: 'Pulled forward', status: 'done', completedAt: at(DAY), scheduledFor: NEXT_DAY });
    expect((await stars()).bonus).toBe(true);
  });
});

// ── S5 reflection (done task + note) ────────────────────────────────────────────
describe('computeStars — S5 reflection', () => {
  it('false with a note but no completed task', async () => {
    setNote('Reflecting');
    expect((await stars()).note).toBe(false);
  });
  it('false with a completed task but no note', async () => {
    makeTask({ title: 'Done', status: 'done', completedAt: at(DAY) });
    expect((await stars()).note).toBe(false);
  });
  it('false when the note is only whitespace', async () => {
    makeTask({ title: 'Done', status: 'done', completedAt: at(DAY) });
    setNote('   ');
    expect((await stars()).note).toBe(false);
  });
  it('true with both a completed task and a non-empty note', async () => {
    makeTask({ title: 'Done', status: 'done', completedAt: at(DAY) });
    setNote('Great day');
    expect((await stars()).note).toBe(true);
  });

  // FIX 5 — pin S5's doneToday semantics: it counts ANY status='done' task with a
  // completed_at in the local-day window (no habit/routine exclusion, unlike S3/S4),
  // and requires a non-null completed_at (unlike S3's status-only rule).
  it('a habit completion + a note earns S5 (no habit exclusion for the done-task predicate)', async () => {
    makeTask({ title: 'Habit', subtype: 'habit', status: 'done', completedAt: at(DAY), occurrenceDate: DAY });
    setNote('Reflected');
    expect((await stars()).note).toBe(true);
  });
  it('a routine-member completion + a note earns S5 (no routine exclusion either)', async () => {
    const t = makeRoutineMember('Routine');
    sqlite.prepare(`UPDATE tasks SET status='done', completed_at=? WHERE id=?`).run(at(DAY), t);
    setNote('Reflected');
    expect((await stars()).note).toBe(true);
  });
  it('a done task with a NULL completed_at + a note does NOT earn S5', async () => {
    makeTask({ title: 'Done but untimed', status: 'done', completedAt: null });
    setNote('Reflected');
    expect((await stars()).note).toBe(false);
  });
});

// ── total ────────────────────────────────────────────────────────────────────
describe('computeStars — total', () => {
  it('total equals the count of true flags (a perfect 5-star day)', async () => {
    setToday('The one thing', true);                                              // S1
    makeTask({ title: 'Habit', subtype: 'habit', occurrenceDate: DAY, status: 'done' }); // S2
    plan(makeTask({ title: 'Planned', status: 'done', completedAt: at(DAY) }), 0);  // S3
    makeTask({ title: 'Bonus', status: 'done', completedAt: at(DAY) });            // S4 (unplanned)
    setNote('Reflected');                                                          // S5 (done task exists)
    const s = await stars();
    expect(s).toMatchObject({ objective: true, habits: true, tasks: true, bonus: true, note: true, total: 5 });
  });
  it('empty day scores zero', async () => {
    expect((await stars()).total).toBe(0);
  });
});

// ── freeze job ──────────────────────────────────────────────────────────────────
describe('freezeStars — nightly snapshot', () => {
  function frozenRow(date = DAY) {
    return sqlite.prepare(`SELECT * FROM daily_recap WHERE owner_id=? AND date=?`).get(SYSTEM_OWNER, date) as any;
  }
  const setTz = (tz: string) =>
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(tz, SYSTEM_OWNER);

  it('snapshots the day that just ended (yesterday relative to now)', async () => {
    setToday('Done goal', true);
    // now = a NEXT_DAY instant → yesterday = DAY.
    const r = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(undefined, iso(NEXT_DAY, '00:20')));
    expect(r.date).toBe(DAY);
    expect(r.created).toBe(true); // FIX 6 — a first freeze is a create
    const row = frozenRow();
    expect(row).toMatchObject({ star_objective: 1, total: 1 });
  });

  // FIX 2 — the frozen day is derived from the OWNER timezone, not the server clock.
  it('freezes the owner-tz day, not the server-local day (UTC server + LA owner)', async () => {
    setTz('America/Los_Angeles');
    setToday('Goal', true, DAY);
    // 2026-06-16T05:00Z is still 2026-06-15 22:00 in Los Angeles, so the owner-tz
    // "today" is still 2026-06-15 (DAY) and yesterday is 2026-06-14 — NOT DAY.
    // The 00:20-local cron fires when it's 07:20Z (2026-06-16T07:20Z) on that day.
    const r = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(undefined, '2026-06-16T07:20:00.000Z'));
    // 07:20Z on 06-16 = 00:20 local on 06-16 in LA → yesterday-local = 06-15 = DAY.
    expect(r.date).toBe(DAY);
    expect(frozenRow(DAY)).toMatchObject({ total: 1 });

    // Sanity: a server-local (UTC) derivation would also give DAY here, so prove the
    // divergence directly — an instant that is a DIFFERENT day in UTC vs LA.
    // 2026-06-17T04:00Z is 2026-06-16 21:00 in LA. UTC-today=06-17 (yesterday 06-16);
    // LA-today=06-16 (yesterday 06-15=DAY). The frozen day must be the LA one.
    resetDb();
    setTz('America/Los_Angeles');
    setToday('Goal2', true, DAY);
    const r2 = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(undefined, '2026-06-17T04:00:00.000Z'));
    expect(r2.date).toBe(DAY);            // LA yesterday, not UTC yesterday (06-16)
    expect(frozenRow(NEXT_DAY)).toBeUndefined();
  });

  it('a later edit to a frozen past day leaves the frozen row unchanged', async () => {
    // Freeze DAY with a single done goal → total 1.
    setToday('Goal', true);
    await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, iso(TODAY, '00:20')));
    expect(frozenRow().total).toBe(1);

    // Later: complete an unplanned task on DAY (would be +1 live). Frozen row must not change.
    makeTask({ title: 'Late win', status: 'done', completedAt: at(DAY) });
    expect((await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => computeStars(SYSTEM_OWNER, DAY))).total).toBe(2); // live sees it
    expect(frozenRow().total).toBe(1); // frozen unchanged (no re-freeze)
  });

  // FIX 4 — first-freeze-wins: a same-day manual re-run after an edit cannot overwrite.
  // FIX 6 — created=true on the first freeze, false on the no-op re-run.
  it('re-running freeze after mutating the day leaves the frozen row unchanged', async () => {
    setToday('Goal', true);
    const first = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, iso(TODAY, '00:20')));
    expect(first.total).toBe(1);
    expect(first.created).toBe(true);

    // Owner edits DAY (adds an unplanned completion) then a manual job re-run fires.
    makeTask({ title: 'Late win', status: 'done', completedAt: at(DAY) });
    const second = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, iso(TODAY, '09:00')));
    expect(second.total).toBe(1);                 // returns the EXISTING total, no recompute
    expect(second.created).toBe(false);           // no-op, not a create
    expect(frozenRow().total).toBe(1);            // row untouched
    const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM daily_recap WHERE owner_id=? AND date=?`).get(SYSTEM_OWNER, DAY) as { n: number }).n;
    expect(n).toBe(1);
  });

  it('is idempotent — re-running never creates a second row', async () => {
    setToday('Goal', true);
    await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, iso(TODAY, '00:20')));
    await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, iso(TODAY, '00:20')));
    const rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM daily_recap WHERE owner_id=? AND date=?`).get(SYSTEM_OWNER, DAY) as { n: number };
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
    await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, iso(TODAY, '00:20')));
    // Change the live world so recompute would give 2.
    makeTask({ title: 'Late win', status: 'done', completedAt: at(DAY) });

    const res = await api(srv.url, `/api/stars?from=${DAY}&to=${DAY}`);
    expect(res.body[0]).toMatchObject({ date: DAY, total: 1, frozen: true });
  });
});

// ── daily_recap merge (S1-B): summary + stars co-located in one (owner,date) row ──
describe('daily_recap co-location (summary cache + immutable star freeze)', () => {
  beforeEach(() => {
    resetDb();
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone='UTC' WHERE owner_id=?`).run(SYSTEM_OWNER);
  });

  const recapRow = (date = DAY) =>
    sqlite.prepare(`SELECT * FROM daily_recap WHERE owner_id=? AND date=?`).get(SYSTEM_OWNER, date) as any;

  it('freezes stars even when a summary row already exists (guard keys on frozen_at, not existence)', async () => {
    // A summarizeDay upsert created the (owner,date) row first, frozen_at NULL.
    sqlite
      .prepare(
        `INSERT INTO daily_recap (owner_id, date, prose, stats, focus, llm, inputs_hash)
         VALUES (?, ?, 'Morning brief', '{}', '[]', 0, 'hash-1')`,
      )
      .run(SYSTEM_OWNER, DAY);

    setToday('Done goal', true); // objective star → total 1
    const r = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, `${TODAY}T00:20:00.000Z`));

    expect(r.created).toBe(true); // it actually froze — the bug an existence-guard would introduce is that it would NOT
    const row = recapRow();
    expect(row.frozen_at).not.toBeNull();
    expect(row.star_objective).toBe(1);
    expect(row.prose).toBe('Morning brief'); // summary group PRESERVED by the partial star upsert
  });

  it('a summary refresh never disturbs a frozen star row', async () => {
    setToday('Done goal', true);
    await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, `${TODAY}T00:20:00.000Z`));
    const beforeFrozenAt = recapRow().frozen_at;

    // Simulate summarizeDay's partial upsert onto the already-frozen row.
    sqlite
      .prepare(
        `INSERT INTO daily_recap (owner_id, date, prose, stats, focus, llm, inputs_hash, updated_at)
         VALUES (?, ?, 'New brief', '{}', '[]', 1, 'hash-2', CURRENT_TIMESTAMP)
         ON CONFLICT(owner_id, date) DO UPDATE SET
           prose=excluded.prose, stats=excluded.stats, focus=excluded.focus,
           llm=excluded.llm, inputs_hash=excluded.inputs_hash, updated_at=CURRENT_TIMESTAMP`,
      )
      .run(SYSTEM_OWNER, DAY);

    const row = recapRow();
    expect(row.prose).toBe('New brief'); // summary updated
    expect(row.star_objective).toBe(1); // stars untouched
    expect(row.frozen_at).toBe(beforeFrozenAt); // frozen stamp untouched
  });

  it('re-freeze stays a no-op even after the live world changed (first-freeze-wins)', async () => {
    setToday('Done goal', true);
    const first = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, `${TODAY}T00:20:00.000Z`));
    expect(first.created).toBe(true);

    // An unplanned completion that would raise the live score, then re-freeze.
    makeTask({ title: 'Late win', status: 'done', completedAt: `${DAY}T15:00:00.000Z` });
    const second = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => freezeStars(DAY, `${TODAY}T09:00:00.000Z`));
    expect(second.created).toBe(false);
    expect(recapRow().total).toBe(first.total);
  });
});
