import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { config } from '../src/lib/config.js';
import { resetDb, startTestServer, createOwner, api, type TestServer } from './helpers.js';

/**
 * Close-loop wave, ticket 6 — the readout for `calibrate_dismissals` (ticket 3).
 * Shaped like `calibration-history.test.ts` / `triality-routes.test.ts`: raw sqlite
 * fixtures for `possible_dismissal_rate` / `possible_dismissal_exemplars` (the batch
 * job itself is under test in `dismissal-learning.test.ts`), a live server, and the
 * `requireAuth` standalone-mode flip for the 401 cases (auth.test.ts's pattern).
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });
afterEach(() => { config.auth.mode = 'test'; });

function seedRate(
  owner: string,
  computedDate: string,
  opts: { periodDays?: number; created?: number; decided?: number; dismissed?: number; rate?: number | null; exemplars?: number; hinted?: 0 | 1 } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO possible_dismissal_rate
         (owner_id, computed_date, period_days, created, decided, dismissed, rate, exemplars, hinted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      owner, computedDate, opts.periodDays ?? 7, opts.created ?? 0, opts.decided ?? 0,
      opts.dismissed ?? 0, opts.rate ?? null, opts.exemplars ?? 0, opts.hinted ?? 0,
    );
}

let seq = 0;
function seedExemplar(owner: string): void {
  const idx = seq++;
  sqlite
    .prepare(
      `INSERT INTO possible_dismissal_exemplars (owner_id, log_id, input_text, source_kind, embedding, computed_date)
       VALUES (?, ?, ?, NULL, NULL, '2026-08-14')`,
    )
    .run(owner, `log-${idx}`, `noise ${idx}`);
}

function seedOutcomeLog(owner: string): void {
  const idx = seq++;
  sqlite
    .prepare(
      `INSERT INTO possible_outcome_log
         (id, owner_id, possible_task_id, source_kind, input_text, outcome, decided_at, local_date)
       VALUES (?, ?, ?, NULL, ?, 'dismissed', ?, '2026-08-14')`,
    )
    .run(`log-${idx}`, owner, `possible-${idx}`, `noise ${idx}`, '2026-08-14T12:00:00.000Z');
}

const exemplarCount = (owner: string) =>
  (sqlite.prepare(`SELECT COUNT(*) c FROM possible_dismissal_exemplars WHERE owner_id = ?`).get(owner) as { c: number }).c;

const outcomeLogCount = (owner: string) =>
  (sqlite.prepare(`SELECT COUNT(*) c FROM possible_outcome_log WHERE owner_id = ?`).get(owner) as { c: number }).c;

describe('GET /api/dismissal-learning/trend', () => {
  it('returns only the calling owner\'s rows', async () => {
    const other = createOwner();
    seedRate(OWNER, '2026-08-01', { rate: 0.5 });
    seedRate(other, '2026-08-01', { rate: 0.9 });

    const { status, body } = await api(srv.url, '/api/dismissal-learning/trend');
    expect(status).toBe(200);
    expect(body.trend).toHaveLength(1);
    expect(body.trend[0].rate).toBe(0.5);
  });

  it('comes back oldest → newest', async () => {
    seedRate(OWNER, '2026-08-15', { rate: 0.3 });
    seedRate(OWNER, '2026-08-01', { rate: 0.1 });
    seedRate(OWNER, '2026-08-08', { rate: 0.2 });

    const { body } = await api(srv.url, '/api/dismissal-learning/trend');
    expect(body.trend.map((r: any) => r.computed_date)).toEqual(['2026-08-01', '2026-08-08', '2026-08-15']);
  });

  it('honours `limit`, defaulting to 90', async () => {
    for (let i = 0; i < 5; i++) {
      seedRate(OWNER, `2026-08-0${i + 1}`, { rate: i / 10 });
    }
    const capped = await api(srv.url, '/api/dismissal-learning/trend?limit=2');
    // The newest 2, still chronological.
    expect(capped.body.trend.map((r: any) => r.computed_date)).toEqual(['2026-08-04', '2026-08-05']);

    const uncapped = await api(srv.url, '/api/dismissal-learning/trend');
    expect(uncapped.body.trend).toHaveLength(5); // default 90 easily covers 5 seeded rows
  });

  it('serialises `rate: null` for a period with decided = 0 — never falsy-coerced', async () => {
    seedRate(OWNER, '2026-08-01', { decided: 0, dismissed: 0, rate: null });

    const { body } = await api(srv.url, '/api/dismissal-learning/trend');
    expect(body.trend[0].rate).toBeNull();
    expect(body.trend[0].rate).not.toBe(0);
  });

  it('gets {trend: []}, not a 404, for an owner with no rows', async () => {
    const { status, body } = await api(srv.url, '/api/dismissal-learning/trend');
    expect(status).toBe(200);
    expect(body).toEqual({ trend: [] });
  });

  it('401s unauthenticated', async () => {
    config.auth.mode = 'standalone';
    const { status } = await api(srv.url, '/api/dismissal-learning/trend');
    expect(status).toBe(401);
  });
});

describe('DELETE /api/dismissal-learning/exemplars', () => {
  it('deletes the caller\'s exemplars and reports the count', async () => {
    seedExemplar(OWNER);
    seedExemplar(OWNER);
    seedExemplar(OWNER);

    const { status, body } = await api(srv.url, '/api/dismissal-learning/exemplars', { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, cleared: 3 });
    expect(exemplarCount(OWNER)).toBe(0);
  });

  it('leaves possible_outcome_log row-for-row intact', async () => {
    seedOutcomeLog(OWNER);
    seedOutcomeLog(OWNER);
    seedExemplar(OWNER);
    const before = outcomeLogCount(OWNER);

    await api(srv.url, '/api/dismissal-learning/exemplars', { method: 'DELETE' });
    expect(outcomeLogCount(OWNER)).toBe(before);
  });

  it('does not touch another owner\'s exemplars', async () => {
    const other = createOwner();
    seedExemplar(OWNER);
    seedExemplar(other);
    seedExemplar(other);

    const { body } = await api(srv.url, '/api/dismissal-learning/exemplars', { method: 'DELETE' });
    expect(body).toEqual({ ok: true, cleared: 1 });
    expect(exemplarCount(other)).toBe(2);
  });

  it('401s unauthenticated', async () => {
    config.auth.mode = 'standalone';
    const { status } = await api(srv.url, '/api/dismissal-learning/exemplars', { method: 'DELETE' });
    expect(status).toBe(401);
  });
});
