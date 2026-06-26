import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * T-SCHED-2 — Schedule-mode planning horizon. POST /api/auto/run loops the existing
 * single-day placement across N days (Schedule mode → planning_horizon_days; Suggest
 * mode → 1; explicit horizon_days overrides). TZ=UTC pinned (helpers force timezone=UTC).
 *
 * Three consecutive weekdays; the workday window is shrunk to 09:00–10:00 (60 min), which
 * holds exactly one 45-min undirected task (a second needs 45+10-break+45 > 60). So a
 * staged set of 3 fans one task onto each day via the Pass-2b workday fill in /auto/run.
 */
const OWNER = SYSTEM_OWNER;
const D0 = '2026-06-22'; // Mon
const D1 = '2026-06-23'; // Tue
const D2 = '2026-06-24'; // Wed

function insertTask(title: string, est = 45): string {
  return (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }).id;
}
function stage(id: string): void {
  sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, id);
}
const countOn = (date: string): number =>
  (sqlite.prepare(`SELECT COUNT(*) c FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1 AND start_at LIKE ?`).get(date + '%') as { c: number }).c;
const stagedCount = (): number => (sqlite.prepare(`SELECT COUNT(*) c FROM flight_plan WHERE owner_id = ?`).get(OWNER) as { c: number }).c;
// Shrink the workday to a one-task window + set the mode/horizon for the test.
function setMode(mode: 'suggest' | 'schedule', horizon: number): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET auto_mode = ?, planning_horizon_days = ?, workday_start = '09:00', workday_end = '10:00' WHERE owner_id = ?`).run(mode, horizon, OWNER);
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb(); // clears time_blocks, tags (→ pattern_blocks cascade), day_assignments/map
  sqlite.exec(`DELETE FROM flight_plan;`);
});

describe('T-SCHED-2 schedule-mode horizon', () => {
  it('Schedule mode places across planning_horizon_days, one task per day', async () => {
    setMode('schedule', 3);
    const ids = ['A', 'B', 'C'].map((t) => insertTask(`Task ${t}`));
    ids.forEach(stage);

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0 } });
    expect(r.status).toBe(200);
    expect(r.body.result.days).toBe(3);
    expect(countOn(D0)).toBe(1);
    expect(countOn(D1)).toBe(1);
    expect(countOn(D2)).toBe(1);
    expect(stagedCount()).toBe(0); // all three fanned across the horizon
  });

  it('Suggest mode stays single-day (N=1, byte-compatible)', async () => {
    setMode('suggest', 7); // horizon pref ignored in suggest mode
    ['A', 'B', 'C'].forEach((t) => stage(insertTask(`Task ${t}`)));

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0 } });
    expect(countOn(D0)).toBe(1);
    expect(countOn(D1)).toBe(0);
    expect(countOn(D2)).toBe(0);
    expect(stagedCount()).toBe(2); // the other two remain staged
  });

  it('explicit horizon_days overrides the mode/pref', async () => {
    setMode('suggest', 7);
    ['A', 'B', 'C'].forEach((t) => stage(insertTask(`Task ${t}`)));

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0, horizon_days: 2 } });
    expect(r.body.result.days).toBe(2);
    expect(countOn(D0)).toBe(1);
    expect(countOn(D1)).toBe(1);
    expect(countOn(D2)).toBe(0);
    expect(stagedCount()).toBe(1);
  });

  it('is idempotent per day — re-running with the same staged set does not stack', async () => {
    setMode('schedule', 3);
    const ids = ['A', 'B', 'C'].map((t) => insertTask(`Task ${t}`));
    ids.forEach(stage);

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0 } });
    expect([countOn(D0), countOn(D1), countOn(D2)]).toEqual([1, 1, 1]);

    ids.forEach(stage); // re-stage the same (still-open) tasks and run again
    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0 } });
    // clearPriorAuto wipes each day first → still exactly one per day, no duplicates
    expect([countOn(D0), countOn(D1), countOn(D2)]).toEqual([1, 1, 1]);
  });

  it('clamps a 0/blank horizon to a single day', async () => {
    setMode('schedule', 0); // clamps to 1
    ['A', 'B'].forEach((t) => stage(insertTask(`Task ${t}`)));

    const r = await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: D0 } });
    expect(r.body.result.days ?? 1).toBe(1);
    expect(countOn(D0)).toBe(1);
    expect(countOn(D1)).toBe(0);
  });
});
