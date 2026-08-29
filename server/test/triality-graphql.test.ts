import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { parseConfidence } from '../src/services/triality-confidence.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Triality T5 — GraphQL parity (design §8, owner-locked: parity ships with the
 * build). For each T4 route behavior, the GraphQL twin asserts the same
 * observable over the same service layer: gate, refusal, event-not-cache
 * logging, enum round-trip, once-only stamping, foreign-id NOT_FOUND.
 *
 * v2.2 (R2) extends the pick-parity assertion to `confidence`. Parity is a
 * CORRECTNESS requirement, not a nicety — triality.graphql:1-4 makes a behavioral
 * divergence from REST a bug by definition — and confidence is the field most able to
 * drift unnoticed: it is derived per surface at render time rather than read off the
 * pick, so the two adapters are two chances to get it wrong.
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as {
    data?: any;
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  return { status: res.status, body };
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

const enable = () =>
  sqlite.prepare(`UPDATE scheduling_prefs SET triality_enabled = 1 WHERE owner_id = ?`).run(OWNER);

function seedConfirmed(n: number): void {
  const stmt = sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, completed_at, completion_score, reaction_at)
     VALUES (uuid7(), ?, ?, 'done', ?, 3, ?)`,
  );
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - (i + 1) * 86_400_000).toISOString();
    stmt.run(`done-${i}`, OWNER, at, at);
  }
}

const seedOpen = (title: string) =>
  sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), ?, ?, 'open', 20)`)
    .run(title, OWNER);

const logCount = () =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log WHERE owner_id = ?`).get(OWNER) as { c: number }).c;

/** The blob as it was written at show time — the lowercase side of every enum. */
const storedConfidence = (logId: string) =>
  parseConfidence(
    (sqlite.prepare(`SELECT confidence FROM triality_log WHERE id = ?`).get(logId) as { confidence: string | null })
      .confidence,
  );

const NEXT_QUERY = `{
  trialityNext {
    refused { reason have need }
    picks {
      slot actionKind actionRef title logId motivation scores { f h total } ternary
      confidence {
        band value coverage margin evidence marginBasis binding
        counts { dimsInformative dimsActive evidenceRows eligible }
        v
      }
    }
    emptyReasons
    computedAt
  }
}`;

describe('gate parity', () => {
  it('flag off → NOT_FOUND error on query AND mutation, zero log rows', async () => {
    const q = await gql(NEXT_QUERY);
    expect(q.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    const m = await gql(`mutation { trialityFeedback(logId: "x", outcome: OPENED) { changed } }`);
    expect(m.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(logCount()).toBe(0);
  });
});

describe('trialityNext parity', () => {
  it('typed refusal below the floor, no log rows', async () => {
    enable();
    seedConfirmed(4);
    const r = await gql(NEXT_QUERY);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.trialityNext.refused).toEqual({ reason: 'sparse_history', have: 4, need: 10 });
    expect(r.body.data.trialityNext.picks).toBeNull();
    expect(logCount()).toBe(0);
  });

  it('returns SCREAMING enums over lowercase storage, logs every show, matches REST picks', async () => {
    enable();
    seedConfirmed(12);
    seedOpen('alpha'); seedOpen('beta');

    const g = await gql(NEXT_QUERY);
    expect(g.body.errors).toBeUndefined();
    const gPicks = g.body.data.trialityNext.picks.filter(Boolean);
    expect(gPicks.length).toBeGreaterThan(0);
    for (const p of gPicks) {
      expect(['HABITUAL', 'CONTEXTUAL', 'NOVEL']).toContain(p.slot);
      expect(['TASK', 'ROUTINE', 'FLIGHT', 'TEMPLATE']).toContain(p.actionKind);
    }
    // Enum round-trip: the stored log row keeps the lowercase vocabulary.
    const slotRow = sqlite
      .prepare(`SELECT slot FROM triality_log WHERE id = ?`)
      .get(gPicks[0].logId) as { slot: string };
    expect(slotRow.slot).toBe(gPicks[0].slot.toLowerCase());

    // …and so does every confidence enum (v2.2). SCREAMING on the wire, lowercase in the
    // blob: pickToNode upper-cases three fields by hand, so each is its own chance for the
    // stored row and the rendered value to stop being the same reading.
    for (const p of gPicks) {
      expect(['FIRM', 'TENTATIVE', 'GUESS']).toContain(p.confidence.band);
      expect(['UNCONTESTED', 'DOT', 'SCORE', 'TIE']).toContain(p.confidence.marginBasis);
      expect(['COVERAGE', 'MARGIN', 'EVIDENCE']).toContain(p.confidence.binding);
      const stored = storedConfidence(p.logId)!;
      expect(stored.band).toBe(p.confidence.band.toLowerCase());
      expect(stored.marginBasis).toBe(p.confidence.marginBasis.toLowerCase());
      expect(stored.binding).toBe(p.confidence.binding.toLowerCase());
      expect(stored.value).toBe(p.confidence.value);   // only the enums change case; the numbers don't change at all
    }

    // The literal GUESS/UNCONTESTED round-trip, on the one pick whose band is STRUCTURAL
    // rather than fixture-dependent: two candidates with no spread ⇒ no axis veto, so
    // Habitual takes one and Contextual chooses from a singleton pool. Nothing was
    // compared, margin is 0 (never 1 — no data is not certainty), and under weakest link
    // that pins the band no matter what coverage and evidence say.
    const ctx = gPicks.find((p: { slot: string }) => p.slot === 'CONTEXTUAL');
    expect(ctx, 'Contextual fills from the singleton pool Habitual left behind').toBeTruthy();
    expect(ctx.confidence.marginBasis).toBe('UNCONTESTED');
    expect(ctx.confidence.margin).toBe(0);
    expect(ctx.confidence.band).toBe('GUESS');
    expect(storedConfidence(ctx.logId)).toMatchObject({ band: 'guess', marginBasis: 'uncontested' });

    // Parity with REST: same fixture ⇒ same actions in the same slots (log ids differ).
    const rest = await api(srv.url, '/api/triality/next');
    const restPicks = rest.body.picks.filter(Boolean) as {
      action_ref: string;
      slot: string;
      confidence: Record<string, unknown>;
    }[];
    const restRefs = restPicks.map((p) => `${p.slot}:${p.action_ref}`);
    const gqlRefs = gPicks.map((p: { actionRef: string; slot: string }) => `${p.slot.toLowerCase()}:${p.actionRef}`);
    expect(gqlRefs).toEqual(restRefs);

    // Same picks ⇒ same confidence, to the digit. Confidence is DERIVED at render time on
    // each surface rather than carried on the pick, so equal refs do not imply equal
    // bands — this is the assertion that catches one adapter drifting. `band` and `value`
    // are the pair that must match; the components travel with them because the two
    // surfaces report ONE reading, and any component that differs makes that false whether
    // or not the weakest link happens to hide it (here it would: margin is 0 in this
    // fixture, so a coverage drift could never surface in `value` alone).
    const asWireShape = (c: {
      band: string; value: number; coverage: number; margin: number; evidence: number;
      marginBasis: string; binding: string;
      counts: { dimsInformative: number; dimsActive: number; evidenceRows: number; eligible: number };
      v: number;
    }) => ({
      band: c.band.toLowerCase(),
      value: c.value,
      coverage: c.coverage,
      margin: c.margin,
      evidence: c.evidence,
      margin_basis: c.marginBasis.toLowerCase(),
      binding: c.binding.toLowerCase(),
      counts: {
        dims_informative: c.counts.dimsInformative,
        dims_active: c.counts.dimsActive,
        evidence_rows: c.counts.evidenceRows,
        eligible: c.counts.eligible,
      },
      v: c.v,
    });
    expect(gPicks.map((p: { confidence: Parameters<typeof asWireShape>[0] }) => asWireShape(p.confidence))).toEqual(
      restPicks.map((p) => p.confidence),
    );

    // Both surfaces logged their own shown events.
    expect(logCount()).toBe(2 * gPicks.length);
  });
});

describe('trialityFeedback parity', () => {
  it('stamps once via the enum, no-ops on repeat, NOT_FOUND on foreign id, BAD_USER_INPUT never fires for valid enums', async () => {
    enable();
    seedConfirmed(12);
    seedOpen('to-act-on');
    const g = await gql(NEXT_QUERY);
    const logId = g.body.data.trialityNext.picks.find(Boolean).logId as string;

    const first = await gql(`mutation { trialityFeedback(logId: "${logId}", outcome: STAGED) { changed success } }`);
    expect(first.body.errors).toBeUndefined();
    expect(first.body.data.trialityFeedback).toEqual({ changed: true, success: true });

    const repeat = await gql(`mutation { trialityFeedback(logId: "${logId}", outcome: DISMISSED) { changed } }`);
    expect(repeat.body.data.trialityFeedback.changed).toBe(false);
    const row = sqlite.prepare(`SELECT outcome FROM triality_log WHERE id = ?`).get(logId) as { outcome: string };
    expect(row.outcome).toBe('staged');

    const foreign = await gql(`mutation { trialityFeedback(logId: "no-such-row", outcome: OPENED) { changed } }`);
    expect(foreign.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');

    // A landing stamp audits exactly once — REST/GraphQL identical (WHO rule).
    await flushAudits();
    const audits = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE entity = ?`).get(`triality:${logId}`) as { c: number }
    ).c;
    expect(audits).toBe(1);
  });
});
