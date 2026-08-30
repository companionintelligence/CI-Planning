import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { config } from '../src/lib/config.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Plan-loop-learning REST surface (revision-loop wave, ticket 4) — the read-only
 * `GET /api/plan-loop/trend` adapter over `services/plan-loop-learning.ts`'s
 * `planLoopTrend`. Rows are seeded directly into `plan_loop_stats` via sqlite, not
 * through `calibratePlanLoop`: this file pins the READ path independently of the
 * batch pass that writes the rows (covered by plan-loop-calibrate.test.ts).
 */

const OWNER = SYSTEM_OWNER;

interface StatsRowInput {
  owner_id?: string;
  stage?: string;
  computed_date: string;
  period_days?: number;
  runs?: number;
  passed?: number;
  escaped?: number;
  first_try_pass?: number;
  avg_iterations?: number | null;
  pass_rate?: number | null;
}

/** Insert one `plan_loop_stats` row straight via sqlite — the ticket's mandated seeding path. */
function seedStatsRow(input: StatsRowInput): void {
  const row = {
    owner_id: OWNER,
    stage: 'order',
    period_days: 7,
    runs: 5,
    passed: 4,
    escaped: 1,
    first_try_pass: 3,
    avg_iterations: 1.4,
    pass_rate: 0.8,
    ...input,
  };
  sqlite
    .prepare(
      `INSERT INTO plan_loop_stats
         (owner_id, stage, computed_date, period_days, runs, passed, escaped, first_try_pass, avg_iterations, pass_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.owner_id,
      row.stage,
      row.computed_date,
      row.period_days,
      row.runs,
      row.passed,
      row.escaped,
      row.first_try_pass,
      row.avg_iterations,
      row.pass_rate,
    );
}

describe('GET /api/plan-loop/trend', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());
  afterEach(() => {
    // requireAuth reads config.auth.mode per-request off one shared singleton — the
    // unauthenticated-request test below flips it and MUST restore 'test', or every
    // later file in this sequential suite would start 401ing (auth.test.ts's own rule).
    config.auth.mode = 'test';
  });

  it("returns only the calling owner's rows; a second owner's rows never appear", async () => {
    createOwner(SECOND_OWNER_ID);
    seedStatsRow({ computed_date: '2026-08-10' });
    seedStatsRow({ owner_id: SECOND_OWNER_ID, computed_date: '2026-08-10', stage: 'other-owner-stage' });

    const res = await api(srv.url, '/api/plan-loop/trend');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs.every((r: { stage: string }) => r.stage !== 'other-owner-stage')).toBe(true);

    const asB = await api(srv.url, '/api/plan-loop/trend', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(asB.body.runs).toHaveLength(1);
    expect(asB.body.runs[0].stage).toBe('other-owner-stage');
  });

  it('comes back newest first — computed_date DESC, then stage', async () => {
    // Seeded out of order on purpose: the response order must come from the query,
    // not from insertion order.
    seedStatsRow({ stage: 'order', computed_date: '2026-08-03' });
    seedStatsRow({ stage: 'zeta', computed_date: '2026-08-17' });
    seedStatsRow({ stage: 'alpha', computed_date: '2026-08-17' });
    seedStatsRow({ stage: 'order', computed_date: '2026-08-10' });

    const res = await api(srv.url, '/api/plan-loop/trend');
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { computed_date: string; stage: string }) => [r.computed_date, r.stage])).toEqual([
      ['2026-08-17', 'alpha'],
      ['2026-08-17', 'zeta'],
      ['2026-08-10', 'order'],
      ['2026-08-03', 'order'],
    ]);
  });

  it('limit=2 caps the result; an omitted limit returns up to 26', async () => {
    for (let i = 0; i < 30; i++) {
      seedStatsRow({ computed_date: `2026-01-${String(i + 1).padStart(2, '0')}` });
    }

    const capped = await api(srv.url, '/api/plan-loop/trend?limit=2');
    expect(capped.status).toBe(200);
    expect(capped.body.runs).toHaveLength(2);

    const defaulted = await api(srv.url, '/api/plan-loop/trend');
    expect(defaulted.status).toBe(200);
    expect(defaulted.body.runs).toHaveLength(26);
  });

  it('limit=0 and limit=9999 clamp rather than error', async () => {
    for (let i = 0; i < 30; i++) {
      seedStatsRow({ computed_date: `2026-02-${String(i + 1).padStart(2, '0')}` });
    }

    // The route's clamp is Math.min(Math.max(Number(q) || 26, 1), 365). `0` is falsy
    // under `||`, so Number('0') || 26 evaluates to 26, NOT 1 — verified against the
    // exact expression in routes/plan-loop.ts before asserting, per the ticket's
    // warning not to assume.
    const zero = await api(srv.url, '/api/plan-loop/trend?limit=0');
    expect(zero.status).toBe(200);
    expect(zero.body.runs).toHaveLength(26);

    // 9999 clamps down to 365, which still exceeds the 30 rows that exist — so every
    // seeded row comes back, and the call must not error.
    const huge = await api(srv.url, '/api/plan-loop/trend?limit=9999');
    expect(huge.status).toBe(200);
    expect(huge.body.runs).toHaveLength(30);
  });

  it('serialises a NULL pass_rate / avg_iterations as null, not falsy or absent', async () => {
    seedStatsRow({ computed_date: '2026-08-20', avg_iterations: null, pass_rate: null, runs: 0, passed: 0, escaped: 0, first_try_pass: 0 });

    const res = await api(srv.url, '/api/plan-loop/trend');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].pass_rate).toBeNull();
    expect(res.body.runs[0].avg_iterations).toBeNull();
    // Strict null checks, not falsy ones — 0 must never be mistaken for null and vice versa.
    expect(res.body.runs[0].pass_rate === null).toBe(true);
    expect(res.body.runs[0].avg_iterations === null).toBe(true);
  });

  it('401s an unauthenticated request', async () => {
    config.auth.mode = 'standalone';
    const res = await api(srv.url, '/api/plan-loop/trend');
    expect(res.status).toBe(401);
  });

  it('a fresh owner with zero rows gets an empty runs array, not a 404', async () => {
    createOwner(SECOND_OWNER_ID);
    const res = await api(srv.url, '/api/plan-loop/trend', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });
});
