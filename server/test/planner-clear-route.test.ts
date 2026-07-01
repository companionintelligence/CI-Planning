import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase P · P2 — POST /api/planner/clear. Thin route over clearPlannerRange:
 * validation, dry-run preview, snapshot-on-apply, audit + broadcast. The engine
 * itself is covered by clear-range.test.ts; this asserts the wiring + HTTP contract.
 */
const OWNER = SYSTEM_OWNER;
const pad = (n: number) => String(n).padStart(2, '0');
const BASE = new Date();
const isoDay = (o: number) => {
  const d = new Date(BASE);
  d.setUTCDate(d.getUTCDate() + o);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const T0 = isoDay(0), T1 = isoDay(1), T2 = isoDay(2), T3 = isoDay(3), T4 = isoDay(4);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

const getInstances = async (tplId: string) =>
  ((await api(srv.url, `/api/blocks?from=${at(T0, '00:00')}&to=${at(T4, '23:59')}`)).body.blocks as any[]).filter((b) => b.recurrence_parent_id === tplId);
const makeDaily = async () =>
  (await api(srv.url, '/api/blocks', { method: 'POST', json: { title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', start_at: at(T0, '09:00'), end_at: at(T0, '11:00'), recurrence_rule: 'FREQ=DAILY' } })).body.block;
const clear = (json: unknown) => api(srv.url, '/api/planner/clear', { method: 'POST', json });
const blockCount = () => (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks`).get() as { n: number }).n;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb(); // timezone='UTC', recurrence_horizon_days=7
  sqlite.exec(`DELETE FROM audit_log; DELETE FROM pattern_day_optouts; DELETE FROM pattern_tasks; DELETE FROM patterns;`);
});

describe('POST /api/planner/clear — validation', () => {
  it('400 when start is missing / malformed', async () => {
    expect((await clear({})).status).toBe(400);
    expect((await clear({ start: 'nope' })).status).toBe(400);
    expect((await clear({ start: '2026-02-31' })).status).toBe(400); // impossible calendar day
  });
  it('400 when end < start', async () => {
    expect((await clear({ start: T2, end: T1 })).status).toBe(400);
  });
  it('400 (not 500) when the bounded span exceeds the ~5y cap', async () => {
    const r = await clear({ start: '2026-01-01', end: '2040-01-01' });
    expect(r.status).toBe(400); // engine would throw → route guards it first
  });
  it('400 when dry_run is a non-boolean (no silent coercion)', async () => {
    expect((await clear({ start: T2, dry_run: 'false' })).status).toBe(400);
  });
});

describe('POST /api/planner/clear — dry run', () => {
  it('reports counts and writes nothing', async () => {
    const tpl = await makeDaily();
    await getInstances(tpl.id); // materialize T0..T4
    const before = blockCount();
    const r = await clear({ start: T2, dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('open-ended');
    expect(r.body.blocksDeleted).toBe(3); // T2,T3,T4
    expect(r.body.backup).toBeUndefined(); // no snapshot on dry-run
    expect(blockCount()).toBe(before); // nothing written
    expect((sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_rule: string }).recurrence_rule).toBe('FREQ=DAILY');
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'clear-range'`).get() as { n: number }).n).toBe(0); // no audit on dry-run
  });
});

describe('POST /api/planner/clear — apply', () => {
  it('open-ended: deletes on/after, caps the rule, snapshots, audits; future read stays empty', async () => {
    const tpl = await makeDaily();
    await getInstances(tpl.id);
    const r = await clear({ start: T2 });
    expect(r.status).toBe(200);
    expect(r.body.blocksDeleted).toBe(3);
    expect(r.body.backup).toMatch(/companion-preclear-.*\.db$/);
    expect((sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_rule: string }).recurrence_rule).toContain('UNTIL=');
    expect((await getInstances(tpl.id)).map((b) => b.occurrence_date).sort()).toEqual([T0, T1]); // no regen
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'clear-range'`).get() as { n: number }).n).toBe(1);
  });

  it('bounded: clears only the window; series resumes after end', async () => {
    const tpl = await makeDaily();
    await getInstances(tpl.id);
    const r = await clear({ start: T1, end: T2 });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('bounded');
    expect(r.body.blocksDeleted).toBe(2); // T1, T2
    expect((sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(tpl.id) as { recurrence_rule: string }).recurrence_rule).toBe('FREQ=DAILY'); // not capped
    expect((await getInstances(tpl.id)).map((b) => b.occurrence_date).sort()).toEqual([T0, T3, T4]); // window gone, resumes
  });
});
