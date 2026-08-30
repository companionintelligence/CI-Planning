import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Placement-learning wave, ticket 6 — the REST surface: `GET /api/placement/survival`
 * (the trend that makes "the scheduler got better" a number) and
 * `DELETE /api/placement/preferences` (reset-drops-the-rollup-not-the-evidence, the
 * twin of `DELETE /api/classification/exemplars`). Thin-adapter contract: no flag
 * gate, `survival_rate: null` stays `null` on the wire, and every statement is
 * owner-scoped.
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

/** One `placement_survival` row, straight into sqlite — the reader is under test,
 *  not the batch that would normally produce this row (placement-learning.test.ts). */
function seedSurvival(
  owner: string,
  computedDate: string,
  over: Partial<{
    periodDays: number; decided: number; accepted: number; corrected: number;
    survivalRate: number | null; keysLearned: number; biased: 0 | 1;
  }> = {},
): void {
  const v = {
    periodDays: 28, decided: 10, accepted: 8, corrected: 2,
    survivalRate: 0.8, keysLearned: 3, biased: 1, ...over,
  };
  sqlite
    .prepare(
      `INSERT INTO placement_survival
         (owner_id, computed_date, period_days, decided, accepted, corrected, survival_rate, keys_learned, biased)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(owner, computedDate, v.periodDays, v.decided, v.accepted, v.corrected, v.survivalRate, v.keysLearned, v.biased);
}

/** One `placement_preferences` row, straight into sqlite. */
function seedPreference(owner: string, slotKey: string): void {
  sqlite
    .prepare(
      `INSERT INTO placement_preferences (owner_id, slot_key, p25_hour, p50_hour, p75_hour, corrections, sample_count, computed_date)
       VALUES (?, ?, 9, 10, 11, 5, 5, '2026-08-01')`,
    )
    .run(owner, slotKey);
}

/** One `placement_log` row, straight into sqlite — durable evidence the reset must
 *  never touch. */
function seedLog(owner: string): void {
  sqlite
    .prepare(
      `INSERT INTO placement_log
         (id, owner_id, block_id, task_id, slot_key, auto_run_id,
          chosen_start_at, chosen_end_at, chosen_hour, fit, candidates, placed_at, local_date)
       VALUES (uuid7(), ?, NULL, NULL, 'work', NULL, '2026-08-01T09:00:00.000Z', '2026-08-01T09:30:00.000Z', 9, 1, '[]', '2026-08-01T09:00:00.000Z', '2026-08-01')`,
    )
    .run(owner);
}

const preferenceCount = (owner: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM placement_preferences WHERE owner_id = ?`).get(owner) as { c: number }).c;

const logCount = (owner: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM placement_log WHERE owner_id = ?`).get(owner) as { c: number }).c;

const survivalCount = (owner: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM placement_survival WHERE owner_id = ?`).get(owner) as { c: number }).c;

await flushAudits();
const resetAudits = (owner: string) =>
  (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM audit_log
          WHERE owner_id = ? AND actor = 'owner' AND action = 'reset' AND entity = 'placement:preferences'`,
      )
      .get(owner) as { c: number }
  ).c;

describe('GET /api/placement/survival', () => {
  it('a fresh owner gets an empty trend, 200', async () => {
    const res = await api(srv.url, '/api/placement/survival');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: [] });
  });

  it('three seeded rows come back newest computed_date first', async () => {
    seedSurvival(OWNER, '2026-08-01');
    seedSurvival(OWNER, '2026-08-15');
    seedSurvival(OWNER, '2026-08-08');
    const res = await api(srv.url, '/api/placement/survival');
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { computed_date: string }) => r.computed_date)).toEqual([
      '2026-08-15', '2026-08-08', '2026-08-01',
    ]);
  });

  it('every run carries the full reading shape', async () => {
    seedSurvival(OWNER, '2026-08-15', { periodDays: 28, decided: 10, accepted: 8, corrected: 2, survivalRate: 0.8, keysLearned: 3, biased: 1 });
    const res = await api(srv.url, '/api/placement/survival');
    expect(res.body.runs[0]).toEqual({
      computed_date: '2026-08-15', period_days: 28, decided: 10, accepted: 8,
      corrected: 2, survival_rate: 0.8, keys_learned: 3, biased: 1,
    });
  });

  it('a period that decided nothing serialises survival_rate as null, never 0', async () => {
    seedSurvival(OWNER, '2026-08-15', { decided: 0, accepted: 0, corrected: 0, survivalRate: null, keysLearned: 0 });
    const res = await api(srv.url, '/api/placement/survival');
    expect(res.body.runs[0].survival_rate).toBeNull();
  });

  describe('?limit=', () => {
    beforeEach(() => {
      for (let i = 1; i <= 5; i++) seedSurvival(OWNER, `2026-08-0${i}`);
    });

    it('defaults to 12 and non-numeric input falls back to 12', async () => {
      const withoutParam = await api(srv.url, '/api/placement/survival');
      expect(withoutParam.body.runs).toHaveLength(5); // fewer than 12 exist — no clamp visible either way
      const bogus = await api(srv.url, '/api/placement/survival?limit=abc');
      expect(bogus.body.runs).toHaveLength(5);
    });

    it('?limit=1 returns one row', async () => {
      const res = await api(srv.url, '/api/placement/survival?limit=1');
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].computed_date).toBe('2026-08-05'); // newest
    });

    it('?limit=0 falls back to the default of 12 — 0 is falsy in the `|| 12` clamp, byte-identical to classification.ts', async () => {
      const res = await api(srv.url, '/api/placement/survival?limit=0');
      expect(res.body.runs).toHaveLength(5); // fewer than 12 exist — the default, not a clamp to 1, is what's visible
    });

    it('?limit=999 clamps to 100', async () => {
      const res = await api(srv.url, '/api/placement/survival?limit=999');
      expect(res.body.runs).toHaveLength(5); // only 5 exist; the clamp ceiling is 100, not the count
    });
  });

  it("never returns another owner's rows", async () => {
    createOwner(SECOND_OWNER_ID);
    seedSurvival(OWNER, '2026-08-10');
    seedSurvival(SECOND_OWNER_ID, '2026-08-20');
    const mine = await api(srv.url, '/api/placement/survival');
    expect(mine.body.runs.map((r: { computed_date: string }) => r.computed_date)).toEqual(['2026-08-10']);
    const theirs = await api(srv.url, '/api/placement/survival', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(theirs.body.runs.map((r: { computed_date: string }) => r.computed_date)).toEqual(['2026-08-20']);
  });
});

describe('DELETE /api/placement/preferences (reset learning)', () => {
  it('clears the caller\'s rows and reports the count', async () => {
    seedPreference(OWNER, 'work');
    seedPreference(OWNER, 'home');
    const res = await api(srv.url, '/api/placement/preferences', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cleared: 2 });
    expect(preferenceCount(OWNER)).toBe(0);
  });

  it('leaves placement_log and placement_survival untouched', async () => {
    seedPreference(OWNER, 'work');
    seedLog(OWNER);
    seedLog(OWNER);
    seedSurvival(OWNER, '2026-08-15');
    const logsBefore = logCount(OWNER);
    const survivalBefore = survivalCount(OWNER);

    const res = await api(srv.url, '/api/placement/preferences', { method: 'DELETE' });
    expect(res.body.cleared).toBe(1);
    expect(logCount(OWNER)).toBe(logsBefore);
    expect(survivalCount(OWNER)).toBe(survivalBefore);
  });

  it("does not touch another owner's placement_preferences", async () => {
    createOwner(SECOND_OWNER_ID);
    seedPreference(OWNER, 'work');
    seedPreference(SECOND_OWNER_ID, 'home');
    seedPreference(SECOND_OWNER_ID, 'errands');

    const res = await api(srv.url, '/api/placement/preferences', { method: 'DELETE' });
    expect(res.body.cleared).toBe(1);
    expect(preferenceCount(OWNER)).toBe(0);
    expect(preferenceCount(SECOND_OWNER_ID)).toBe(2); // B's rollup is untouched
  });

  it('audits exactly the reset that cleared something — a no-op delete writes no row', async () => {
    seedPreference(OWNER, 'work');
    await flushAudits();
    const before = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;

    const first = await api(srv.url, '/api/placement/preferences', { method: 'DELETE' });
    expect(first.body.cleared).toBe(1);
    await flushAudits();
    expect(resetAudits(OWNER)).toBe(1);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c).toBe(before + 1);

    const repeat = await api(srv.url, '/api/placement/preferences', { method: 'DELETE' });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual({ ok: true, cleared: 0 });
    await flushAudits();
    expect(resetAudits(OWNER)).toBe(1); // still just the one — the no-op wrote nothing
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c).toBe(before + 1);
  });
});
