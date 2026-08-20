import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer, seedFallbackFillWindow } from './helpers.js';
import type { PlanWeekCandidates } from '../src/services/planning-sessions.js';
import { localDateInTZ } from '../src/lib/tz.js';

/**
 * FTUE · T3 (#339) — the read-only candidate preview behind "Fill next week".
 *
 * The point of these tests is that the preview tells the TRUTH about what
 * `fillFlightPlanCandidates` would stage: its SELECT is duplicated in the service (a copy,
 * because that function writes and a preview must not), so these pin the two in agreement.
 */

const TODAY = '2026-07-18';

function insertTask(over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id: `t-${Math.abs(Math.round(Number(String(over.title ?? 'x').length) * 7))}-${cnt++}`,
    title: 'Task', owner_id: SYSTEM_OWNER, status: 'open', priority: 3, ...over,
  };
  const keys = Object.keys(row);
  sqlite.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
  return row.id as string;
}
let cnt = 0;

describe('GET /api/plan-week/candidates', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => { resetDb(); seedFallbackFillWindow(); cnt = 0; });

  const get = (q = `horizon=7&start=${TODAY}`, headers?: Record<string, string>) =>
    api<PlanWeekCandidates>(server.url, `/api/plan-week/candidates?${q}`, headers ? { headers } : undefined);

  it('counts fill-eligible open tasks and caps will_stage at 20', async () => {
    for (let i = 0; i < 25; i++) insertTask({ title: `Backlog ${i}` });

    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.open_tasks.count).toBe(25);      // untruncated eligible total
    expect(r.body.open_tasks.will_stage).toBe(20); // fill's CANDIDATE_LIMIT
    expect(r.body.open_tasks.items).toHaveLength(20);
  });

  it('excludes exactly what fillFlightPlanCandidates excludes', async () => {
    const keep = insertTask({ title: 'Eligible' });
    insertTask({ title: 'Habit', subtype: 'habit' });
    const parent = insertTask({ title: 'Parent' });
    insertTask({ title: 'Child', parent_id: parent });
    insertTask({ title: 'Instance', recurrence_parent_id: parent });
    insertTask({ title: 'Done', status: 'done' });
    const staged = insertTask({ title: 'Already staged' });
    sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`)
      .run(SYSTEM_OWNER, staged);

    const titles = (await get()).body.open_tasks.items.map((t) => t.title);
    expect(titles).toContain('Eligible');
    expect(titles).toContain('Parent'); // top-level and open — eligible on its own
    for (const excluded of ['Habit', 'Child', 'Instance', 'Done', 'Already staged']) {
      expect(titles).not.toContain(excluded);
    }
    expect(titles).toHaveLength(2);
    void keep;
  });

  it('reports flight_plan (selected only), objectives (live links) and recurring counts', async () => {
    const a = insertTask({ title: 'A' });
    const b = insertTask({ title: 'B' });
    sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(SYSTEM_OWNER, a);
    sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 0, 1)`).run(SYSTEM_OWNER, b);

    const linked = insertTask({ title: 'Linked' });
    const unlinked = insertTask({ title: 'Unlinked link row' });
    sqlite.prepare(`INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, priority, created_at, updated_at)
                    VALUES ('o-1', ?, 'Obj', 'objective', 'none', 'active', 'none', 3, ?, ?)`)
      .run(SYSTEM_OWNER, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    sqlite.prepare(`INSERT INTO objective_tasks (objective_id, task_id, id, linked, version) VALUES ('o-1', ?, 'l-1', 1, 1)`).run(linked);
    // A soft-deleted link (linked = 0) must NOT count — mirrors the live-link rule.
    sqlite.prepare(`INSERT INTO objective_tasks (objective_id, task_id, id, linked, version) VALUES ('o-1', ?, 'l-2', 0, 1)`).run(unlinked);

    insertTask({ title: 'Repeats', recurrence_rule: 'FREQ=DAILY' });
    insertTask({ title: 'Habitual', subtype: 'habit' });

    const r = (await get()).body;
    expect(r.flight_plan.count).toBe(1);  // only selected = 1
    expect(r.objectives.count).toBe(1);   // only linked = 1, and not staged
    expect(r.recurring.count).toBe(2);    // recurrence_rule OR habit
  });

  /**
   * "Live link" needs all three predicates (#369's rule): linked=1, the objective not
   * ARCHIVED, and the objective OURS. Counting on `linked = 1` alone both inflates the
   * number with archived work and reads across a cross-owner link row.
   */
  it('counts objective links only when the objective is live AND ours', async () => {
    createOwner(SECOND_OWNER_ID);
    const mkObj = (id: string, owner: string, archivedAt: string | null = null) =>
      sqlite.prepare(
        `INSERT INTO objectives (id, owner_id, title, level, horizon, status, cadence, priority, created_at, updated_at, archived_at)
         VALUES (?, ?, 'O', 'objective', 'none', 'active', 'none', 3, ?, ?, ?)`,
      ).run(id, owner, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', archivedAt);
    const link = (lid: string, oid: string, tid: string) =>
      sqlite.prepare(`INSERT INTO objective_tasks (objective_id, task_id, id, linked, version) VALUES (?, ?, ?, 1, 1)`).run(oid, tid, lid);

    mkObj('o-live', SYSTEM_OWNER);
    mkObj('o-archived', SYSTEM_OWNER, '2026-07-02T00:00:00.000Z');
    mkObj('o-theirs', SECOND_OWNER_ID);

    link('l-live', 'o-live', insertTask({ title: 'Counts' }));
    link('l-arch', 'o-archived', insertTask({ title: 'Archived objective' }));
    link('l-cross', 'o-theirs', insertTask({ title: 'Cross-owner link' })); // MY task, THEIR objective

    // Only the live, owned link counts — the other two are still open tasks, so a naive
    // `linked = 1` query would have returned 3.
    expect((await get()).body.objectives.count).toBe(1);
  });

  /**
   * The `scheduled_for` / live-block clause is the one most likely to drift from
   * autoplan.ts's copy, and it is what makes "what fill would stage" true rather than
   * approximate. Anchored on the OWNER's today, since that is the day fill resolves.
   */
  it('mirrors the scheduled_for + live-block clause exactly', async () => {
    const today = localDateInTZ(new Date().toISOString(), 'UTC');
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

    insertTask({ title: 'Undated' });                          // eligible
    insertTask({ title: 'Today, no block', scheduled_for: today }); // eligible (fill re-stages it)
    insertTask({ title: 'Another day', scheduled_for: tomorrow }); // NOT eligible
    const blocked = insertTask({ title: 'Today, live block', scheduled_for: today });
    sqlite.prepare(
      `INSERT INTO time_blocks (id, owner_id, task_id, title, block_kind, start_at, end_at, status)
       VALUES ('b-live', ?, ?, 'Blocked', 'task', ?, ?, 'planned')`,
    ).run(SYSTEM_OWNER, blocked, `${today}T09:00:00.000Z`, `${today}T10:00:00.000Z`);

    const titles = (await get()).body.open_tasks.items.map((t) => t.title).sort();
    expect(titles).toEqual(['Today, no block', 'Undated']);

    // A terminal block does not protect a task — it is eligible again.
    sqlite.prepare(`UPDATE time_blocks SET status = 'completed' WHERE id = 'b-live'`).run();
    expect((await get()).body.open_tasks.items.map((t) => t.title)).toContain('Today, live block');
  });

  /**
   * The preview must anchor on the day fill will actually use. `POST /api/auto/fill` takes
   * no date and resolves ownerToday itself, so a caller-supplied day would make the
   * preview describe a different task set than the confirm it gates.
   */
  it('anchors staging on the owner\'s today and ignores any caller-supplied day', async () => {
    const today = localDateInTZ(new Date().toISOString(), 'UTC');
    insertTask({ title: 'Today', scheduled_for: today });

    const echoed = (await get()).body;
    expect(echoed.start).toBe(today);
    // A start= param must not change the answer — it is not the caller's to choose.
    const spoofed = (await get(`horizon=7&start=1999-01-01`)).body;
    expect(spoofed.start).toBe(today);
    expect(spoofed.open_tasks.items.map((t) => t.title)).toEqual(echoed.open_tasks.items.map((t) => t.title));
  });

  it('writes nothing — row counts are identical before and after', async () => {
    insertTask({ title: 'Untouched' });
    const snap = () => JSON.stringify([
      sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan`).get(),
      sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get(),
      sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks`).get(),
    ]);

    const before = snap();
    await get();
    await get('horizon=3&start=2026-07-20');
    expect(snap()).toBe(before);
  });

  it('echoes the horizon clamped to 1..60, matching autoRun', async () => {
    expect((await get(`horizon=0&start=${TODAY}`)).body.horizon).toBe(1);
    expect((await get(`horizon=99&start=${TODAY}`)).body.horizon).toBe(60);
    expect((await get(`horizon=7&start=${TODAY}`)).body.horizon).toBe(7);
    // A junk horizon degrades to 1 rather than NaN-ing through to the engine.
    expect((await get(`horizon=abc&start=${TODAY}`)).body.horizon).toBe(1);
  });

  it('is owner-scoped: another owner\'s backlog never appears', async () => {
    createOwner(SECOND_OWNER_ID);
    insertTask({ title: 'Mine' });
    sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES ('t-theirs', 'Theirs', ?, 'open', 3)`)
      .run(SECOND_OWNER_ID);

    const mine = (await get()).body;
    expect(mine.open_tasks.items.map((t) => t.title)).toEqual(['Mine']);

    const theirs = (await get(`horizon=7&start=${TODAY}`, { 'x-test-owner': SECOND_OWNER_ID })).body;
    expect(theirs.open_tasks.items.map((t) => t.title)).toEqual(['Theirs']);
  });

  /**
   * Confirm-equivalence: this branch only drives fill → run, so pin that the reused
   * pipeline still fans across days and drains staging. A regression here breaks T3
   * without touching a line of T3's own code.
   */
  it('the reused fill → run pipeline stages then places across the horizon', async () => {
    for (let i = 0; i < 3; i++) insertTask({ title: `Fan ${i}`, estimated_minutes: 30 });

    const filled = await api<{ result: { candidatesAdded: number } }>(server.url, '/api/auto/fill', { method: 'POST', json: {} });
    expect(filled.status).toBe(200);
    expect(filled.body.result.candidatesAdded).toBe(3);

    const before = (await get()).body;
    expect(before.flight_plan.count).toBe(3); // staged, selected

    const ran = await api<{ result: { placed?: number; days?: number } }>(server.url, '/api/auto/run', {
      method: 'POST', json: { horizon_days: 3 },
    });
    expect(ran.status).toBe(200);
    expect((ran.body.result.placed ?? 0)).toBeGreaterThan(0);

    // Staging drained as work was placed.
    expect((await get()).body.flight_plan.count).toBeLessThan(3);
  });
});
