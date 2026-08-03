import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { bandFor, parseConfidence, CONFIDENCE_MODEL_VERSION } from '../src/services/triality-confidence.js';
import { resetDb, startTestServer, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Triality T4 — the REST surface (design §8). Thin-adapter contract: flag-off
 * 404s on all three verbs (the calibration posture), shown-rows-are-events (two
 * GETs → two log sets), once-only feedback, reset-drops-the-rollup-not-the-
 * evidence, cross-tenant invisibility, and the WHO rule (owner writes audit; the
 * read never does).
 *
 * v2.2 adds R1: the confidence block on the wire and in the log column. What is
 * pinned here is the ADAPTER, not the arithmetic (that is triality-confidence.test.ts) —
 * that pickToApi renders every field in snake_case, that the rendered numbers are the
 * ones stored, and that a payload with nothing to say says nothing rather than 0.
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

await flushAudits();
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
    await flushAudits();
    const before = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;

    const first = await api(srv.url, '/api/triality/weights', { method: 'DELETE' });
    expect(first.body.cleared).toBe(1);
    expect(resetAudits()).toBe(1);
    await flushAudits();
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c).toBe(before + 1);

    const repeat = await api(srv.url, '/api/triality/weights', { method: 'DELETE' });
    expect(repeat.status).toBe(200);              // idempotent, not an error
    expect(repeat.body).toEqual({ ok: true, cleared: 0 });
    expect(resetAudits()).toBe(1);                // a no-op is not a mutation worth a row
    await flushAudits();
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
    await flushAudits();
    const before = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
    await api(srv.url, '/api/triality/next');
    await flushAudits();
    const after = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('confidence on GET /api/triality/next (v2.2 §8)', () => {
  /** The wire contract, spelled out: pickToApi maps every field by hand, so an exact key
   *  set is what catches a spread of the internal object leaking `marginBasis` in
   *  camelCase — a presence check would pass that and the client would render nothing. */
  const WIRE_KEYS = ['band', 'binding', 'counts', 'coverage', 'evidence', 'margin', 'margin_basis', 'v', 'value'];
  const COUNT_KEYS = ['dims_active', 'dims_informative', 'eligible', 'evidence_rows'];

  function seedRankable(): void {
    seedConfirmed(12);
    seedOpen('alpha');
    seedOpen('beta');
  }

  it('every rendered pick carries a full, self-verifying block', async () => {
    enableTriality();
    seedRankable();
    const res = await api(srv.url, '/api/triality/next');
    expect(res.status).toBe(200);
    const picks = res.body.picks.filter(Boolean);
    expect(picks.length).toBeGreaterThan(0);

    const active = res.body.vector.meta.active as string[];
    for (const p of picks) {
      const c = p.confidence;
      expect(Object.keys(c).sort()).toEqual(WIRE_KEYS);
      expect(Object.keys(c.counts).sort()).toEqual(COUNT_KEYS);
      expect(['firm', 'tentative', 'guess']).toContain(c.band);
      expect(['uncontested', 'dot', 'score', 'tie']).toContain(c.margin_basis);
      expect(['coverage', 'margin', 'evidence']).toContain(c.binding);
      expect(c.v).toBe(CONFIDENCE_MODEL_VERSION);

      // Self-verifying FROM THE SAME RESPONSE — the arithmetic IS the explanation
      // (routes/triality.ts), so a reader with a calculator can check every number the
      // payload shows against the vector the payload also shipped.
      expect(c.value).toBe(Math.min(c.coverage, c.margin, c.evidence));   // weakest link, never an average
      expect(c.band).toBe(bandFor(c.value));                              // band is a pure fn of the STORED value
      expect(c.counts.dims_active).toBe(active.length);
      expect(c.counts.dims_informative).toBe(active.filter((d) => res.body.vector.dims[d] !== 0).length);
      // The winner is in its own eligible pool, and evidence rows ship UNCAPPED (the
      // ratio must not pretend 43 completions is the same as 8).
      expect(c.counts.eligible).toBeGreaterThan(0);
      expect(c.counts.evidence_rows).toBeGreaterThanOrEqual(0);
    }
  });

  it('stores the blob it rendered — the log column round-trips', async () => {
    enableTriality();
    seedRankable();
    const res = await api(srv.url, '/api/triality/next');
    const picks = res.body.picks.filter(Boolean);
    expect(logCount()).toBe(picks.length);

    // NULL is load-bearing and permanent: it means "shown before v2.2", and the
    // calibration reader excludes those rows rather than banding them. A row this build
    // wrote may therefore never carry one.
    const unbanded = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log WHERE confidence IS NULL`).get() as { c: number }
    ).c;
    expect(unbanded).toBe(0);

    for (const p of picks) {
      const row = sqlite.prepare(`SELECT confidence FROM triality_log WHERE id = ?`).get(p.log_id) as {
        confidence: string | null;
      };
      // Parsed, not string-compared: the stored blob is the camelCase internal shape and
      // the wire is snake_case, so this pins the adapter in BOTH directions at once.
      expect(parseConfidence(row.confidence)).toEqual({
        band: p.confidence.band,
        value: p.confidence.value,
        coverage: p.confidence.coverage,
        margin: p.confidence.margin,
        evidence: p.confidence.evidence,
        marginBasis: p.confidence.margin_basis,
        binding: p.confidence.binding,
        counts: {
          dimsInformative: p.confidence.counts.dims_informative,
          dimsActive: p.confidence.counts.dims_active,
          evidenceRows: p.confidence.counts.evidence_rows,
          eligible: p.confidence.counts.eligible,
        },
        v: p.confidence.v,
      });
    }
  });

  it('is absent where there is no pick — the refusal arm and an all-empty payload', async () => {
    enableTriality();
    seedConfirmed(5);
    const refusal = await api(srv.url, '/api/triality/next');
    // Exact body: the refusal arm is unchanged by v2.2, and "not enough history" must not
    // acquire a confidence — there is no pick for one to be about.
    expect(refusal.body).toEqual({ refused: 'sparse_history', have: 5, need: 10 });

    // Over the floor, but nothing to suggest: three honestly-empty slots. A null pick
    // carries no block at all rather than a 0-valued `guess` — no data must never render
    // as a number, not even the lowest one.
    seedConfirmed(7);
    const empty = await api(srv.url, '/api/triality/next');
    expect(empty.body.picks).toEqual([null, null, null]);
    expect(Object.keys(empty.body.empty_reasons).sort()).toEqual(['contextual', 'habitual', 'novel']);
    expect(empty.body.vector?.dims).toBeTruthy();          // the vector still ships; only the picks are empty
    expect(JSON.stringify(empty.body)).not.toContain('confidence');
    expect(logCount()).toBe(0);
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

    await flushAudits();
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
