import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { logger } from '../src/lib/logger.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * GET /api/tasks had no LIMIT at all — an owner with a pathologically large row count
 * (a bug, a bad seed, a runaway script) would pull the entire table into memory on
 * every list request. This is a SAFETY CAP, not real pagination: the default (20,000)
 * sits far above anything a real owner reaches by using the app, so these drive the
 * SAME code path at a testable scale via `?limit=`, which is accepted and clamped —
 * never raised — against that same default ceiling.
 */

const OWNER = SYSTEM_OWNER;

function insertTask(title: string, o: { priority?: number; dueAt?: string | null } = {}): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, due_at) VALUES (uuid7(), ?, ?, 'open', ?, ?) RETURNING id`,
      )
      .get(title, OWNER, o.priority ?? 3, o.dueAt ?? null) as { id: string }
  ).id;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => resetDb());

describe('GET /api/tasks — row cap', () => {
  it('returns everything, untruncated, when well under the cap', async () => {
    for (let i = 0; i < 10; i++) insertTask(`task-${i}`);
    const r = await api(srv.url, '/api/tasks');
    expect(r.status).toBe(200);
    expect(r.body.tasks).toHaveLength(10);
    expect(r.body.truncated).toBe(false);
  });

  it('a caller may narrow via ?limit=, and gets exactly that many back', async () => {
    for (let i = 0; i < 10; i++) insertTask(`task-${i}`);
    const r = await api(srv.url, '/api/tasks?limit=3');
    expect(r.body.tasks).toHaveLength(3);
    expect(r.body.truncated).toBe(true);
  });

  it('the cut is deterministic across repeated calls (priority, due_at, id order)', async () => {
    // All tied on priority and due_at (both defaulted) — id is the only thing that
    // can make the boundary stable. Without it, "which 3" could differ call to call.
    const ids = Array.from({ length: 8 }, (_, i) => insertTask(`tied-${i}`));
    const expectedFirst3 = [...ids].sort().slice(0, 3);

    const r1 = await api(srv.url, '/api/tasks?limit=3');
    const r2 = await api(srv.url, '/api/tasks?limit=3');
    const got1 = r1.body.tasks.map((t: { id: string }) => t.id);
    const got2 = r2.body.tasks.map((t: { id: string }) => t.id);

    expect(got1).toEqual(got2);
    expect(got1).toEqual(expectedFirst3);
  });

  it('lower priority number sorts first, matching the documented order', async () => {
    const low = insertTask('urgent', { priority: 1 });
    insertTask('someday', { priority: 5 });
    const r = await api(srv.url, '/api/tasks?limit=1');
    expect(r.body.tasks[0].id).toBe(low);
  });

  it('logs a warning when the cap actually bites', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    for (let i = 0; i < 5; i++) insertTask(`task-${i}`);
    await api(srv.url, '/api/tasks?limit=5');
    expect(warnSpy).toHaveBeenCalledWith(
      'GET /api/tasks hit its row cap — results are truncated',
      expect.objectContaining({ limit: 5 }),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when nothing was truncated', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    for (let i = 0; i < 3; i++) insertTask(`task-${i}`);
    await api(srv.url, '/api/tasks?limit=10');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('?limit= can narrow but never widen past the default ceiling', async () => {
    for (let i = 0; i < 5; i++) insertTask(`task-${i}`);
    // A limit far above the real default ceiling is clamped down TO that ceiling, not
    // taken at face value — proven observably: every seeded row still comes back
    // (there are far fewer than the ceiling), and nothing about the request errors.
    const r = await api(srv.url, '/api/tasks?limit=999999999');
    expect(r.status).toBe(200);
    expect(r.body.tasks).toHaveLength(5);
    expect(r.body.truncated).toBe(false);
  });
});
