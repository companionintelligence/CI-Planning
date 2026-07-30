import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Triality T4 — the REST surface (design §8). Thin-adapter contract: flag-off
 * 404s on all three verbs (the calibration posture), shown-rows-are-events (two
 * GETs → two log sets), once-only feedback, reset-drops-the-rollup-not-the-
 * evidence, cross-tenant invisibility, and the WHO rule (owner writes audit; the
 * read never does).
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

function enableTriality(owner = OWNER): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(owner);
}

function seedConfirmed(n: number, owner = OWNER): void {
  const stmt = sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, completed_at, completion_mood)
     VALUES (uuid7(), ?, ?, 'done', ?, 'flat')`,
  );
  for (let i = 0; i < n; i++) stmt.run(`done-${i}`, owner, new Date(Date.now() - (i + 1) * 86_400_000).toISOString());
}

function seedOpen(title: string, owner = OWNER): void {
  sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), ?, ?, 'open', 20)`)
    .run(title, owner);
}

const logCount = (owner = OWNER) =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log WHERE owner_id = ?`).get(owner) as { c: number }).c;

const weightCount = (owner = OWNER) =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_weights WHERE owner_id = ?`).get(owner) as { c: number }).c;

/** Learned rows straight into the rollup: the reset route's only precondition is
 *  that rows EXIST, and the learning job is under test in triality-learning. */
function seedWeights(owner = OWNER, slots: string[] = ['habitual', 'contextual']): void {
  const stmt = sqlite.prepare(
    `INSERT INTO triality_weights (owner_id, slot, weights, sample_count, computed_date)
     VALUES (?, ?, '{"F":0.5,"H":0.3,"Q":0.2,"N":0,"C":0}', 20, '2026-07-29')`,
  );
  for (const slot of slots) stmt.run(owner, slot);
}

const resetAudits = (owner = OWNER) =>
  (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM audit_log
          WHERE owner_id = ? AND actor = 'owner' AND action = 'reset' AND entity = 'triality:weights'`,
      )
      .get(owner) as { c: number }
  ).c;

describe('flag gate', () => {
  it('404s all THREE verbs while off; alive when on', async () => {
    // The whole surface looks absent, not broken — read, feedback AND reset.
    seedWeights();
    expect((await api(srv.url, '/api/triality/next')).status).toBe(404);
    expect((await api(srv.url, '/api/triality/feedback', { method: 'POST', json: { log_id: 'x', outcome: 'opened' } })).status).toBe(404);
    expect((await api(srv.url, '/api/triality/weights', { method: 'DELETE' })).status).toBe(404);
    expect(logCount()).toBe(0);      // gated = zero side effects
    expect(weightCount()).toBe(2);   // …including the destructive verb: nothing was reset

    enableTriality();
    seedConfirmed(12);
    seedOpen('anything');
    expect((await api(srv.url, '/api/triality/next')).status).toBe(200);
    expect((await api(srv.url, '/api/triality/weights', { method: 'DELETE' })).status).toBe(200);
  });
});

describe('DELETE /api/triality/weights (reset learning, §6b)', () => {
  it('clears the learned rollup and reports how many rows went', async () => {
    enableTriality();
    seedWeights(OWNER, ['habitual', 'contextual', 'novel']);
    const res = await api(srv.url, '/api/triality/weights', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cleared: 3 });
    expect(weightCount()).toBe(0);
  });

  it("B's reset clears only B's rows, and neither owner's EVIDENCE is touched", async () => {
    // The reset drops a REGENERABLE rollup. triality_log is the durable evidence and
    // must survive, or the adaptation would be lost instead of merely re-earnable.
    enableTriality(OWNER);
    createOwner(SECOND_OWNER_ID);
    enableTriality(SECOND_OWNER_ID);
    seedConfirmed(12, OWNER);
    seedOpen('mine', OWNER);
    seedConfirmed(12, SECOND_OWNER_ID);
    seedOpen('theirs', SECOND_OWNER_ID);
    await api(srv.url, '/api/triality/next');
    await api(srv.url, '/api/triality/next', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    seedWeights(OWNER, ['habitual', 'novel']);
    seedWeights(SECOND_OWNER_ID, ['habitual']);
    const logsA = logCount(OWNER);
    const logsB = logCount(SECOND_OWNER_ID);
    expect(logsA).toBeGreaterThan(0);
    expect(logsB).toBeGreaterThan(0);

    const res = await api(srv.url, '/api/triality/weights', { method: 'DELETE', headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(1);
    expect(weightCount(SECOND_OWNER_ID)).toBe(0);
    expect(weightCount(OWNER)).toBe(2);           // A's learning is untouched
    expect(logCount(OWNER)).toBe(logsA);          // …and the evidence survives a reset
    expect(logCount(SECOND_OWNER_ID)).toBe(logsB);
    expect(resetAudits(OWNER)).toBe(0);           // A's ledger records nothing B did
  });

  it('audits exactly the reset that cleared something — a no-op delete writes no row', async () => {
    enableTriality();
    seedWeights(OWNER, ['habitual']);
    const before = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;

    const first = await api(srv.url, '/api/triality/weights', { method: 'DELETE' });
    expect(first.body.cleared).toBe(1);
    expect(resetAudits()).toBe(1);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c).toBe(before + 1);

    const repeat = await api(srv.url, '/api/triality/weights', { method: 'DELETE' });
    expect(repeat.status).toBe(200);              // idempotent, not an error
    expect(repeat.body).toEqual({ ok: true, cleared: 0 });
    expect(resetAudits()).toBe(1);                // a no-op is not a mutation worth a row
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c).toBe(before + 1);
  });
});

describe('GET /api/triality/next', () => {
  it('typed refusal below the floor — 200, not an error, and no log rows', async () => {
    enableTriality();
    seedConfirmed(5);
    const res = await api(srv.url, '/api/triality/next');
    expect(res.status).toBe(200);
    expect(res.body.refused).toBe('sparse_history');
    expect(res.body.have).toBe(5);
    expect(res.body.need).toBe(10);
    expect(logCount()).toBe(0);
  });

  it('shown is an event, not a cache: identical picks, distinct log rows', async () => {
    enableTriality();
    seedConfirmed(12);
    seedOpen('alpha'); seedOpen('beta');
    const a = await api(srv.url, '/api/triality/next');
    const b = await api(srv.url, '/api/triality/next');
    const strip = (r: typeof a) => r.body.picks.map((p: { log_id: string } | null) => p && { ...p, log_id: null });
    expect(strip(b)).toEqual(strip(a));                 // deterministic picks…
    const rows = logCount();
    const perCall = a.body.picks.filter(Boolean).length;
    expect(rows).toBe(2 * perCall);                     // …but every show is logged
    expect(a.body.vector?.dims).toBeTruthy();           // the arithmetic ships with the answer
    expect(a.body.computed_at).toBeTruthy();
  });

  it('writes no audit rows (WHO rule — reads never stamp)', async () => {
    enableTriality();
    seedConfirmed(12);
    seedOpen('quiet');
    const before = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
    await api(srv.url, '/api/triality/next');
    const after = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('POST /api/triality/feedback', () => {
  async function shownLogId(): Promise<string> {
    seedConfirmed(12);
    seedOpen('to-act-on');
    const res = await api(srv.url, '/api/triality/next');
    const pick = res.body.picks.find(Boolean);
    return pick.log_id as string;
  }

  it('stamps once, no-ops on repeat, audits only the landing stamp', async () => {
    enableTriality();
    const id = await shownLogId();
    const first = await api(srv.url, '/api/triality/feedback', { method: 'POST', json: { log_id: id, outcome: 'staged' } });
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true);

    const repeat = await api(srv.url, '/api/triality/feedback', { method: 'POST', json: { log_id: id, outcome: 'dismissed' } });
    expect(repeat.body.changed).toBe(false);

    const row = sqlite.prepare(`SELECT outcome FROM triality_log WHERE id = ?`).get(id) as { outcome: string };
    expect(row.outcome).toBe('staged');

    const audits = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE entity = ?`).get(`triality:${id}`) as { c: number }
    ).c;
    expect(audits).toBe(1);
  });

  it('422s junk; 404s an unknown id', async () => {
    enableTriality();
    expect((await api(srv.url, '/api/triality/feedback', { method: 'POST', json: { log_id: 'x', outcome: 'shrug' } })).status).toBe(422);
    expect((await api(srv.url, '/api/triality/feedback', { method: 'POST', json: { outcome: 'opened' } })).status).toBe(422);
    expect((await api(srv.url, '/api/triality/feedback', { method: 'POST', json: { log_id: 'no-such-row', outcome: 'opened' } })).status).toBe(404);
  });
});

describe('cross-tenant isolation', () => {
  it("owner B never sees owner A's picks or stamps A's log rows", async () => {
    enableTriality(OWNER);
    createOwner(SECOND_OWNER_ID);
    enableTriality(SECOND_OWNER_ID);
    seedConfirmed(12, OWNER);
    seedOpen('mine', OWNER);
    const a = await api(srv.url, '/api/triality/next');
    const aLogId = a.body.picks.find(Boolean).log_id as string;

    // B has no history → refusal, and B's GET must not see A's candidates.
    const b = await api(srv.url, '/api/triality/next', { headers: { 'x-test-owner': SECOND_OWNER_ID } });
    expect(b.body.refused).toBe('sparse_history');

    // B stamping A's log row: 404, and A's row untouched.
    const stab = await api(srv.url, '/api/triality/feedback', {
      method: 'POST',
      json: { log_id: aLogId, outcome: 'dismissed' },
      headers: { 'x-test-owner': SECOND_OWNER_ID },
    });
    expect(stab.status).toBe(404);
    const row = sqlite.prepare(`SELECT outcome FROM triality_log WHERE id = ?`).get(aLogId) as { outcome: string };
    expect(row.outcome).toBe('shown');
  });
});
