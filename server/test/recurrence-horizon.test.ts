import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase P · P1 — recurrence_horizon_days. The two lazy engines materialize at most
 * `horizon` days from today (inclusive); lowering the horizon auto-prunes
 * engine-generated instances beyond the new window (but not locked/manual, and
 * without capping rules — so raising it re-materializes). Driven through the route
 * so the clamp wiring is proven end to end. Anchored to today; tz pinned to UTC.
 */
const OWNER = SYSTEM_OWNER;
const pad = (n: number) => String(n).padStart(2, '0');
// Pinned "now" so this suite is deterministic at any wall-clock hour. The recurrence
// engines derive `today` from the system clock (localDateInTZ(new Date(), tz)); we
// freeze that clock in beforeAll. Noon UTC = 05:00 America/Los_Angeles the SAME
// calendar day, so the non-UTC-tz clamp test has no midnight-boundary off-by-one.
const NOW_ISO = '2026-06-15T12:00:00.000Z';
const BASE = new Date(NOW_ISO);
function isoDay(offset: number): string {
  const d = new Date(BASE);
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const T0 = isoDay(0);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;
const WIDE_FROM = at(T0, '00:00');
const WIDE_TO = at(isoDay(40), '23:59');

const getBlocks = async (from = WIDE_FROM, to = WIDE_TO) => (await api(srv.url, `/api/blocks?from=${from}&to=${to}`)).body.blocks as any[];
const instanceCount = (tplId: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE recurrence_parent_id = ?`).get(tplId) as { n: number }).n;

async function makeDailyBlock() {
  return (
    await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', tag: 'focus', start_at: at(T0, '09:00'), end_at: at(T0, '11:00'), recurrence_rule: 'FREQ=DAILY' },
    })
  ).body.block;
}
const setHorizon = (n: number) => sqlite.prepare(`UPDATE scheduling_prefs SET recurrence_horizon_days = ? WHERE owner_id = ?`).run(n, OWNER);

// pattern helpers
const typeId = (name: string) => (sqlite.prepare(`SELECT id FROM pattern_types WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: string }).id;

let srv: TestServer;
beforeAll(async () => {
  // Freeze the clock (Date only — leaves setTimeout/await real) so `new Date()` in
  // the recurrence engines AND in this file's date anchors is deterministic.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_ISO));
  srv = await startTestServer();
});
afterAll(async () => { await srv.close(); vi.useRealTimers(); });
beforeEach(() => {
  resetDb(); // pins timezone='UTC' + recurrence_horizon_days=7
  sqlite.exec(`DELETE FROM pattern_day_optouts; DELETE FROM pattern_tasks; DELETE FROM patterns; DELETE FROM flight_plan;`);
  sqlite.prepare(`UPDATE scheduling_prefs SET enable_routines = 1 WHERE owner_id = ?`).run(OWNER);
});

describe('recurrence horizon clamp', () => {
  it('materializes exactly `horizon` days of a daily block template (default 7)', async () => {
    const tpl = await makeDailyBlock();
    await getBlocks(); // materialize across a 40-day window
    expect(instanceCount(tpl.id)).toBe(7); // today .. today+6
  });

  it('a larger horizon materializes more days', async () => {
    setHorizon(15);
    const tpl = await makeDailyBlock();
    await getBlocks();
    expect(instanceCount(tpl.id)).toBe(15);
  });

  it('clamps correctly under a non-UTC timezone (today computed in prefs tz)', async () => {
    // Guards the fix: `today` is derived in the owner's tz (localDateInTZ), matching
    // the prefs-tz day set — so the horizon boundary is right regardless of server TZ.
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'America/Los_Angeles' WHERE owner_id = ?`).run(OWNER);
    const tpl = await makeDailyBlock();
    await getBlocks();
    expect(instanceCount(tpl.id)).toBe(7); // exactly horizon days, no off-by-one at the tz boundary
  });

  it('clamps recurring pattern placement too', async () => {
    const t = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), 'A', ?, 'open', 30, 3) RETURNING id`).get(OWNER) as { id: string }).id;
    const pid = (sqlite.prepare(`INSERT INTO patterns (id, owner_id, type_id, name, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), ?, ?, 'DailyRoutine', 'FREQ=DAILY', ?) RETURNING id`).get(OWNER, typeId('Routine'), at(T0, '12:00')) as { id: string }).id;
    sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(pid, t);
    await getBlocks();
    const days = (sqlite.prepare(`SELECT DISTINCT substr(start_at,1,10) AS d FROM time_blocks WHERE source_kind='pattern' AND source_ref=?`).all(pid) as { d: string }[]).length;
    expect(days).toBe(7); // today .. today+6, not the full 40-day window
  });
});

describe('auto-prune on shorten', () => {
  it('lowering the horizon prunes instances beyond it, spares locked, keeps template; raising re-materializes', async () => {
    setHorizon(30);
    const tpl = await makeDailyBlock();
    await getBlocks();
    expect(instanceCount(tpl.id)).toBe(30); // T0..T29

    // A locked block deep in the future must survive the prune.
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status) VALUES (uuid7(), 'Locked', 'timeblock', ?, ?, 1, 0, 'manual', 'planned')`)
      .run(at(isoDay(20), '14:00'), at(isoDay(20), '15:00'));
    // An authored daily_plan row beyond the new horizon must SURVIVE — the recurrence
    // ceiling has no bearing on Phase-M day plans (clearDailyPlan:false).
    const planTask = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), 'P', ?, 'open', 30, 3) RETURNING id`).get(OWNER) as { id: string }).id;
    sqlite.prepare(`INSERT INTO daily_plan (owner_id, date, task_id, position, source) VALUES (?, ?, ?, 0, 'llm')`).run(OWNER, isoDay(20), planTask);

    const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { recurrence_horizon_days: 7 } });
    expect(r.status).toBe(200);
    expect(r.body.pruned).toBe(23); // T7..T29 auto-instances removed
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM daily_plan WHERE date = ?`).get(isoDay(20)) as { n: number }).n).toBe(1); // day-plan preserved

    expect(instanceCount(tpl.id)).toBe(7); // T0..T6 kept
    expect((sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(tpl.id))).toBeTruthy(); // template kept
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE title = 'Locked'`).get() as { n: number }).n).toBe(1); // locked survived
    expect((sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_rule: string }).recurrence_rule).toBe('FREQ=DAILY'); // NOT capped

    // Raising the horizon re-materializes (reversible — no rule cap).
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { recurrence_horizon_days: 30 } });
    await getBlocks();
    expect(instanceCount(tpl.id)).toBe(30);
  });
});
