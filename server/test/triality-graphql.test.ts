import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Triality T5 — GraphQL parity (design §8, owner-locked: parity ships with the
 * build). For each T4 route behavior, the GraphQL twin asserts the same
 * observable over the same service layer: gate, refusal, event-not-cache
 * logging, enum round-trip, once-only stamping, foreign-id NOT_FOUND.
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
    `INSERT INTO tasks (id, title, owner_id, status, completed_at, completion_mood)
     VALUES (uuid7(), ?, ?, 'done', ?, 'flat')`,
  );
  for (let i = 0; i < n; i++) stmt.run(`done-${i}`, OWNER, new Date(Date.now() - (i + 1) * 86_400_000).toISOString());
}

const seedOpen = (title: string) =>
  sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), ?, ?, 'open', 20)`)
    .run(title, OWNER);

const logCount = () =>
  (sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log WHERE owner_id = ?`).get(OWNER) as { c: number }).c;

const NEXT_QUERY = `{
  trialityNext {
    refused { reason have need }
    picks { slot actionKind actionRef title logId motivation scores { f h total } ternary }
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

    // Parity with REST: same fixture ⇒ same actions in the same slots (log ids differ).
    const rest = await api(srv.url, '/api/triality/next');
    const restRefs = rest.body.picks.filter(Boolean).map((p: { action_ref: string; slot: string }) => `${p.slot}:${p.action_ref}`);
    const gqlRefs = gPicks.map((p: { actionRef: string; slot: string }) => `${p.slot.toLowerCase()}:${p.actionRef}`);
    expect(gqlRefs).toEqual(restRefs);

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
    const audits = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE entity = ?`).get(`triality:${logId}`) as { c: number }
    ).c;
    expect(audits).toBe(1);
  });
});
