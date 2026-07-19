import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return { ...mod, generate: vi.fn() };
});

import { sqlite } from '../src/db/index.js';
import { generate } from '../src/mcp/ollama.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { consolidateSessions, type PlanningSession } from '../src/services/planning-sessions.js';

/**
 * FTUE · T10 (#346) — consolidate/summarize planning logs.
 *
 * `generate` is mocked exactly like plan-week-next-step.test.ts. CI has no reachable
 * Ollama anyway, but mocking makes both the fallback path AND the (much smaller) model
 * path deterministic rather than relying on the environment.
 */

const mockGenerate = generate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDb();
  mockGenerate.mockReset();
});

describe('consolidateSessions (service)', () => {
  function seed(id: string, entryBranch: string, startedAt: string, turns: { text: string; kind?: string }[]) {
    sqlite
      .prepare(`INSERT INTO planning_sessions (id, owner_id, entry_branch, started_at, transcript) VALUES (?, ?, ?, ?, ?)`)
      .run(id, SYSTEM_OWNER, entryBranch, startedAt, JSON.stringify(turns.map((t, i) => ({
        role: 'system', text: t.text, ts: startedAt, ...(t.kind ? { kind: t.kind } : {}),
      }))));
  }

  it('422s on a missing/empty/non-array ids', async () => {
    expect((await consolidateSessions(undefined)).ok).toBe(false);
    expect((await consolidateSessions([])).ok).toBe(false);
    expect((await consolidateSessions('not-an-array')).ok).toBe(false);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('digest content: count, date range, branches, and derived action/task counts (fallback path)', async () => {
    mockGenerate.mockRejectedValue(new Error('ECONNREFUSED'));

    seed('s-a', 'fill_week', '2026-07-01T00:00:00.000Z', [
      { text: 'Horizon: 5 days', kind: 'plan_week:horizon' },
      { text: 'Confirmed: placed 3, unplaced 0', kind: 'plan_week:confirm' },
    ]);
    seed('s-b', 'schedule_tasks', '2026-07-05T00:00:00.000Z', [
      { text: 'Scheduled "A" for tomorrow', kind: 'plan_week:schedule_set' },
      { text: 'Scheduled "B" for tomorrow', kind: 'plan_week:schedule_set' },
      { text: 'Auto placed "C"', kind: 'plan_week:schedule_auto' },
    ]);

    const res = await consolidateSessions(['s-a', 's-b']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('fallback');

    const summary = res.value.summary;
    expect(summary).toContain('2 planning sessions');
    expect(summary).toContain('2026-07-01 to 2026-07-05');
    expect(summary).toContain('fill_week, schedule_tasks');
    expect(summary).toContain('5 actions recorded'); // 2 + 3 transcript turns
    expect(summary).toContain('3 tasks placed'); // schedule_set x2 + schedule_auto x1; fill_week's confirm line doesn't count

    expect(mockGenerate).toHaveBeenCalledTimes(1); // exactly one renderCopy call
  });

  it('persists onto the newest selected session only, and deletes nothing', async () => {
    mockGenerate.mockRejectedValue(new Error('ECONNREFUSED'));
    seed('s-old', 'review', '2026-07-01T00:00:00.000Z', [{ text: 'x' }]);
    seed('s-new', 'review', '2026-07-05T00:00:00.000Z', [{ text: 'y' }]);

    const res = await consolidateSessions(['s-old', 's-new']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const rows = sqlite.prepare(`SELECT id, summary FROM planning_sessions ORDER BY id`).all() as
      { id: string; summary: string | null }[];
    expect(rows).toHaveLength(2); // both source rows still exist
    expect(rows.find((r) => r.id === 's-new')?.summary).toBe(res.value.summary);
    expect(rows.find((r) => r.id === 's-old')?.summary).toBeNull(); // unchanged
  });

  it('returns source: model and persists the model text when Ollama is reachable', async () => {
    mockGenerate.mockResolvedValueOnce('One tidy week of planning: three sessions, all on track.');
    seed('s-1', 'review', '2026-07-01T00:00:00.000Z', [{ text: 'x' }]);

    const res = await consolidateSessions(['s-1']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('model');
    expect(res.value.summary).toBe('One tidy week of planning: three sessions, all on track.');
  });

  it('owner scoping: ignores ids from another owner and never mutates their rows', async () => {
    createOwner(SECOND_OWNER_ID);
    mockGenerate.mockRejectedValue(new Error('ECONNREFUSED'));
    seed('s-mine', 'review', '2026-07-01T00:00:00.000Z', [{ text: 'x' }]);
    sqlite
      .prepare(`INSERT INTO planning_sessions (id, owner_id, entry_branch, started_at) VALUES (?, ?, ?, ?)`)
      .run('s-theirs', SECOND_OWNER_ID, 'review', '2026-07-01T00:00:00.000Z');

    // Mixed selection: only the caller's own row resolves.
    const res = await consolidateSessions(['s-mine', 's-theirs']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.summary).toContain('1 planning session');

    const theirs = sqlite.prepare(`SELECT summary FROM planning_sessions WHERE id = 's-theirs'`).get() as { summary: string | null };
    expect(theirs.summary).toBeNull(); // never touched

    // All-foreign selection resolves to zero owned sessions ⇒ the 422 path.
    const foreignOnly = await consolidateSessions(['s-theirs']);
    expect(foreignOnly.ok).toBe(false);
  });
});

describe('POST /api/plan-week/sessions/consolidate (route)', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  const open = (entry_branch = 'review') =>
    api<{ session: PlanningSession }>(server.url, '/api/plan-week/sessions', { method: 'POST', json: { entry_branch } });

  it('200s with { summary, source } for a valid owned selection', async () => {
    mockGenerate.mockRejectedValue(new Error('ECONNREFUSED'));
    const id = (await open()).body.session.id;

    const res = await api<{ summary: string; source: string }>(server.url, '/api/plan-week/sessions/consolidate', {
      method: 'POST', json: { ids: [id] },
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('fallback');
    expect(typeof res.body.summary).toBe('string');
  });

  it('422s on missing/empty/non-array ids', async () => {
    expect((await api(server.url, '/api/plan-week/sessions/consolidate', { method: 'POST', json: {} })).status).toBe(422);
    expect((await api(server.url, '/api/plan-week/sessions/consolidate', { method: 'POST', json: { ids: [] } })).status).toBe(422);
    expect((await api(server.url, '/api/plan-week/sessions/consolidate', { method: 'POST', json: { ids: 'nope' } })).status).toBe(422);
  });

  it('422s when every id belongs to another owner (or is unknown)', async () => {
    createOwner(SECOND_OWNER_ID);
    const theirId = (await api<{ session: PlanningSession }>(server.url, '/api/plan-week/sessions', {
      method: 'POST', json: { entry_branch: 'review' }, headers: { 'x-test-owner': SECOND_OWNER_ID },
    })).body.session.id;

    const res = await api(server.url, '/api/plan-week/sessions/consolidate', {
      method: 'POST', json: { ids: [theirId, 'unknown-id'] },
    });
    expect(res.status).toBe(422);
  });

  it('does not delete any source session', async () => {
    mockGenerate.mockRejectedValue(new Error('ECONNREFUSED'));
    const id = (await open()).body.session.id;
    await api(server.url, '/api/plan-week/sessions/consolidate', { method: 'POST', json: { ids: [id] } });
    expect((await api(server.url, `/api/plan-week/sessions/${id}`)).status).toBe(200);
  });
});
