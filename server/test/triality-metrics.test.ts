import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { trialityMetrics } from '../src/services/triality-metrics.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Triality T7 — the measurement surface (design §9.2). Honest-zero rules under
 * test: no shown rows ⇒ null rate (never 0%), pending (<24h, still-shown) rows
 * excluded from denominators, weights null pre-T8, and the flag-off 404.
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

function logRow(o: { slot?: string; outcome?: string; ageHours?: number; ref?: string; kind?: string; owner?: string }): void {
  const shownAt = new Date(NOW.getTime() - (o.ageHours ?? 48) * 3600_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, outcome)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(o.owner ?? OWNER, shownAt, shownAt.slice(0, 10), o.slot ?? 'habitual', o.kind ?? 'task', o.ref ?? 'ref-x', o.outcome ?? 'shown');
}

describe('acceptance math', () => {
  it('taken/(decided) per slot; pending <24h rows excluded from the denominator', () => {
    logRow({ slot: 'habitual', outcome: 'staged' });
    logRow({ slot: 'habitual', outcome: 'opened' });
    logRow({ slot: 'habitual', outcome: 'dismissed' });
    logRow({ slot: 'habitual', outcome: 'shown', ageHours: 48 }); // ignored — counts, not taken
    logRow({ slot: 'habitual', outcome: 'shown', ageHours: 2 });  // pending — excluded entirely
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.acceptance.habitual).toEqual({ shown: 4, taken: 2, pending: 1, rate: 0.5 });
  });

  it('no shown rows ⇒ null rate — no data is not 0%', () => {
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.acceptance.habitual.rate).toBeNull();
    expect(m.acceptance.novel.rate).toBeNull();
    expect(m.novelTrend).toEqual({ current: null, prior: null });
  });

  it('novel trend compares this window against the prior same-length window', () => {
    logRow({ slot: 'novel', outcome: 'staged', ageHours: 24 * 5 });      // current window: 1/1
    logRow({ slot: 'novel', outcome: 'dismissed', ageHours: 24 * 40 });  // prior window: 0/1
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.novelTrend.current).toBe(1);
    expect(m.novelTrend.prior).toBe(0);
  });
});

describe('weights (pre-T8)', () => {
  it('returns null while triality_weights does not exist — endpoint still whole', () => {
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.weights).toBeNull();
  });
});

describe('route', () => {
  it('404 while the flag is off; 200 with the payload when on', async () => {
    expect((await api(srv.url, '/api/metrics/triality')).status).toBe(404);
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    const res = await api(srv.url, '/api/metrics/triality?days=30');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.acceptance.contextual.rate).toBeNull();
  });

  it('cross-tenant: B sees only B', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    createOwner(SECOND_OWNER_ID);
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(SECOND_OWNER_ID);
    logRow({ slot: 'habitual', outcome: 'staged', owner: OWNER });
    const b = await api(srv.url, '/api/metrics/triality', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(b.status).toBe(200);
    expect(b.body.acceptance.habitual.rate).toBeNull(); // A's rows invisible to B
  });

  it('existing /api/metrics/tasks response shape untouched (snapshot-lite)', async () => {
    const res = await api(srv.url, '/api/metrics/tasks?days=30');
    expect(res.status).toBe(200);
    for (const k of ['window', 'directions', 'categories', 'totals']) expect(k in res.body).toBe(true);
    expect('acceptance' in res.body).toBe(false);
  });
});
