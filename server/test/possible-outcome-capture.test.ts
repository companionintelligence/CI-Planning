import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, ALL_SCOPES, runWithOwner } from '../src/lib/context.js';
import { promoteAllPending } from '../src/services/possibles.js';
import { promotePossibles } from '../src/agents/groom.js';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';

/**
 * Close-loop wave, ticket 2 — the capture seam. `dismissPossible`/`promotePossible`
 * (services/possibles.ts) still do exactly what they always did (Non-goals: capture is
 * strictly additive); this proves the second, append-only write into
 * `possible_outcome_log` actually happens, is owner-scoped off `proposed_owner_id`, and
 * can never turn a successful decision into a failed one.
 */

let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

function insertPossible(
  rawTitle: string,
  opts: { rawSummary?: string; sourceKind?: string; owner?: string } = {},
): string {
  return (sqlite
    .prepare(
      `INSERT INTO possible_tasks (id, raw_title, raw_summary, source_kind, status, proposed_owner_id)
       VALUES (uuid7(), ?, ?, ?, 'pending', ?) RETURNING id`,
    )
    .get(rawTitle, opts.rawSummary ?? null, opts.sourceKind ?? null, opts.owner ?? OWNER) as { id: string }).id;
}

function outcomeRows(possibleId: string): {
  id: string;
  owner_id: string;
  possible_task_id: string;
  source_kind: string | null;
  input_text: string;
  outcome: string;
  decided_at: string;
  local_date: string;
}[] {
  return sqlite
    .prepare(`SELECT * FROM possible_outcome_log WHERE possible_task_id = ? ORDER BY decided_at ASC`)
    .all(possibleId) as any[];
}

function possibleStatus(id: string): string | undefined {
  return (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string } | undefined)
    ?.status;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('dismiss records outcome evidence', () => {
  it('writes exactly one dismissed row with the right owner, an ISO decided_at, and a YYYY-MM-DD local_date', async () => {
    const id = insertPossible('Renew passport');
    const res = await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
    expect(res.body).toEqual({ ok: true });

    const rows = outcomeRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('dismissed');
    expect(rows[0].owner_id).toBe(OWNER);
    expect(rows[0].decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows[0].local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('writes no row for a cross-owner dismiss, which still returns not_found', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', { owner: OWNER });
    const res = await api(srv.url, `/api/possible-tasks/${mine}/dismiss`, {
      method: 'POST', json: {}, headers: { 'x-test-owner': OTHER },
    });
    expect(res.status).toBe(404);
    expect(possibleStatus(mine)).toBe('pending');
    expect(outcomeRows(mine)).toHaveLength(0);
  });

  it('writes no row for an unknown id', async () => {
    const res = await api(srv.url, `/api/possible-tasks/does-not-exist/dismiss`, { method: 'POST', json: {} });
    expect(res.status).toBe(404);
    const rows = sqlite.prepare(`SELECT COUNT(*) n FROM possible_outcome_log`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('appends two rows when the same possible is dismissed twice (append-only, no dedupe)', async () => {
    const id = insertPossible('Renew passport');
    const first = await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
    expect(first.body).toEqual({ ok: true });
    // The row is already 'dismissed'; the WHERE clause still matches on id + owner, so a
    // second click still flips (no-op) status and still logs — the log is append-only.
    const second = await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
    expect(second.body).toEqual({ ok: true });

    expect(outcomeRows(id)).toHaveLength(2);
  });

  it('still returns ok:true and still flips status when the log table is missing', async () => {
    const id = insertPossible('Renew passport');
    sqlite.exec(`ALTER TABLE possible_outcome_log RENAME TO possible_outcome_log_hidden`);
    try {
      const res = await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
      expect(res.body).toEqual({ ok: true });
      expect(possibleStatus(id)).toBe('dismissed');
    } finally {
      sqlite.exec(`ALTER TABLE possible_outcome_log_hidden RENAME TO possible_outcome_log`);
    }
  });

  it('input_text is raw_title alone when raw_summary is null, and the joined pair when present', async () => {
    const bare = insertPossible('Call the dentist');
    await api(srv.url, `/api/possible-tasks/${bare}/dismiss`, { method: 'POST', json: {} });
    expect(outcomeRows(bare)[0].input_text).toBe('Call the dentist');

    const withSummary = insertPossible('Call the dentist', { rawSummary: 'reschedule the cleaning' });
    await api(srv.url, `/api/possible-tasks/${withSummary}/dismiss`, { method: 'POST', json: {} });
    expect(outcomeRows(withSummary)[0].input_text).toBe('Call the dentist reschedule the cleaning');
  });
});

describe('promote records outcome evidence', () => {
  it('writes exactly one promoted row', async () => {
    const id = insertPossible('Renew passport');
    const res = await api(srv.url, `/api/possible-tasks/${id}/promote`, { method: 'POST', json: {} });
    expect(res.status).toBe(201);

    const rows = outcomeRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('promoted');
    expect(rows[0].owner_id).toBe(OWNER);
  });
});

/**
 * The evidence log is OWNER DECISIONS ONLY (services/possibles.ts `PromoteActor`).
 *
 * Since AF-3 the overwhelming majority of promotes are machine-driven: every ingest and
 * memory-suggest batch auto-promotes its non-review-gated possibles, and the nightly
 * grooming sweeper mops up the stragglers. Logging those would put one row per ingested
 * item into the denominator of ticket 6's noise rate (`dismissed / decided`), pinning it
 * near zero however noisy the queue actually is, and would grow an append-only table
 * without bound. Both sweepers therefore pass `actor: 'auto'`.
 */
describe('machine auto-promotes are not owner decisions', () => {
  const run = <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(OWNER, ALL_SCOPES, fn);
  const logCount = () =>
    (sqlite.prepare(`SELECT COUNT(*) n FROM possible_outcome_log`).get() as { n: number }).n;

  it('promoteAllPending (AF-3, every ingest batch) writes no evidence', async () => {
    const id = insertPossible('Newsletter blurb', { sourceKind: 'text' });
    const r = await run(() => promoteAllPending(OWNER));
    expect(r.promoted).toBe(1); // it really did promote — the behaviour is unchanged
    expect(possibleStatus(id)).toBe('promoted');
    expect(outcomeRows(id)).toHaveLength(0);
    expect(logCount()).toBe(0);
  });

  it('promotePossibles (the nightly straggler sweeper) writes no evidence', async () => {
    const id = insertPossible('Calendar noise', { sourceKind: 'gcal' });
    await run(() => promotePossibles(OWNER));
    expect(possibleStatus(id)).toBe('promoted');
    expect(outcomeRows(id)).toHaveLength(0);
    expect(logCount()).toBe(0);
  });

  it('an owner dismiss is still captured after the sweepers have run', async () => {
    const auto = insertPossible('Newsletter blurb', { sourceKind: 'text' });
    const gated = insertPossible('Real ask from a colleague', { sourceKind: 'gmail' });
    await run(() => promoteAllPending(OWNER)); // sweeps `auto`, leaves the gmail row pending
    expect(possibleStatus(gated)).toBe('pending');

    await api(srv.url, `/api/possible-tasks/${gated}/dismiss`, { method: 'POST', json: {} });

    // Exactly one row in the whole corpus: the owner's dismiss. The auto-promote of the
    // other row contributed nothing, so the rate's denominator counts decisions only.
    expect(logCount()).toBe(1);
    expect(outcomeRows(gated)).toHaveLength(1);
    expect(outcomeRows(gated)[0].outcome).toBe('dismissed');
    expect(outcomeRows(auto)).toHaveLength(0);
  });
});
