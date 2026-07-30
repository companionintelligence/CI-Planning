import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { trialityMetrics } from '../src/services/triality-metrics.js';
import { calibrateTriality } from '../src/services/triality-learning.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Triality T7 — the measurement surface (design §9.2). Honest-zero rules under
 * test: no shown rows ⇒ null rate (never 0%), pending (<24h, still-shown) rows
 * excluded from denominators, weights null until the learning job writes rows,
 * and the flag-off 404.
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

// Distinct action_ref per row BY DEFAULT: the tile now collapses impressions the
// same way learning does (one vote per slot/action/day), so a shared ref means
// "the same suggestion re-shown", which is opt-in for the tests that mean it.
let rowSeq = 0;
function logRow(o: { slot?: string; outcome?: string; ageHours?: number; ref?: string; kind?: string; owner?: string }): void {
  const shownAt = new Date(NOW.getTime() - (o.ageHours ?? 48) * 3600_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, outcome)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(o.owner ?? OWNER, shownAt, shownAt.slice(0, 10), o.slot ?? 'habitual', o.kind ?? 'task', o.ref ?? `ref-${++rowSeq}`, o.outcome ?? 'shown');
}

/**
 * A row the LEARNING job can use: real component scores, and a distinct
 * `action_ref` per row — learning collapses one (slot, action_ref, local_date)
 * group to a single vote, so a shared ref would make N rows one piece of evidence.
 */
let learnSeq = 0;
function logLearnable(o: { outcome: string; scores: Record<string, number>; ageDays: number }): void {
  const shownAt = new Date(NOW.getTime() - o.ageDays * 86_400_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, outcome, outcome_at)
       VALUES (uuid7(), ?, ?, ?, 'habitual', 'task', ?, ?, ?, ?)`,
    )
    .run(OWNER, shownAt, shownAt.slice(0, 10), `learn-${++learnSeq}`, JSON.stringify(o.scores), o.outcome, shownAt);
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

  it('remount spam is ONE vote in the tile, exactly as it is in learning', () => {
    // The prover's finding: the log has two readers, and the tile was still
    // counting raw impressions — a day of banner remounts reported hundreds of
    // "shown" for a handful of real suggestions and understated acceptance ~3×.
    for (let i = 0; i < 40; i++) logRow({ slot: 'habitual', outcome: 'shown', ageHours: 2, ref: 'same-pick' });
    logRow({ slot: 'habitual', outcome: 'staged', ageHours: 2, ref: 'same-pick' }); // the decision wins the group
    logRow({ slot: 'habitual', outcome: 'dismissed', ageHours: 3, ref: 'other-pick' });
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.acceptance.habitual).toEqual({ shown: 2, taken: 1, pending: 0, rate: 0.5 });
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

describe('weights', () => {
  it('returns null while there are no learned ROWS yet — endpoint still whole', () => {
    // Migration 0142 always creates triality_weights, so "not started" is an EMPTY
    // table, never a missing one — and null (not []) is what the tile keys its
    // "learning hasn't started" state on. A reset lands back in exactly this state.
    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.weights).toBeNull();
  });

  it('learned weights reach the tile with slot, sampleCount and computedDate', async () => {
    // Populated through the real learning job, so the shape under test is the one
    // the job actually writes (rather than a hand-built row that could drift).
    for (let i = 0; i < 10; i++) {
      logLearnable({ outcome: 'staged', scores: { F: 1, H: 0, Q: 0.5 }, ageDays: 3 + i });
      logLearnable({ outcome: 'dismissed', scores: { F: 0, H: 1, Q: 0.5 }, ageDays: 3 + i });
    }
    expect(calibrateTriality(OWNER, NOW).slotsWritten).toBe(1);

    const m = trialityMetrics(OWNER, NOW, 30);
    expect(m.weights).toHaveLength(1);
    const row = m.weights![0]!;
    expect(row.slot).toBe('habitual');
    expect(row.sampleCount).toBe(20);
    expect(row.computedDate).toBe(NOW.toISOString().slice(0, 10)); // owner-local day (UTC prefs)
    expect(row.weights.F).toBeCloseTo(0.5, 12);  // 0.40 · (1 + 0.5·+0.5)
    expect(row.weights.H).toBeCloseTo(0.3, 12);
    expect(Object.keys(row.weights)).toEqual(['F', 'H', 'Q', 'N', 'C']);

    // …and it survives the round trip through the route the Balance tab calls.
    sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    const res = await api(srv.url, '/api/metrics/triality?days=30');
    expect(res.status).toBe(200);
    expect(res.body.weights).toEqual(m.weights);
  });

  it('null again after the learned rows go — a reset is indistinguishable from never having learned', () => {
    logLearnable({ outcome: 'staged', scores: { F: 1, H: 0, Q: 0.5 }, ageDays: 3 });
    for (let i = 0; i < 19; i++) {
      logLearnable({ outcome: i % 2 ? 'staged' : 'dismissed', scores: { F: i % 2, H: 0.5, Q: 0.5 }, ageDays: 4 + i });
    }
    calibrateTriality(OWNER, NOW);
    expect(trialityMetrics(OWNER, NOW, 30).weights).not.toBeNull();
    sqlite.prepare(`DELETE FROM triality_weights WHERE owner_id = ?`).run(OWNER);
    expect(trialityMetrics(OWNER, NOW, 30).weights).toBeNull();
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
