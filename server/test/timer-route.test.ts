/**
 * Phase M §C1 — route-level overrun wiring.
 *
 * timer.test.ts covers the service (stopRunning flips the block + returns
 * `overran`). This file covers the HTTP layer: the stop/start endpoints must
 * broadcast `block:updated` when (and only when) the session overran, so the
 * client repaints the block. `broadcast` is mocked to record calls; the real
 * sseRouter is preserved so the app still builds.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/routes/sse.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/routes/sse.js')>();
  return { ...actual, broadcast: vi.fn() };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { broadcast } from '../src/routes/sse.js';

const OWNER = SYSTEM_OWNER;
const mockBroadcast = vi.mocked(broadcast);

function insertTask(title = 'Overrun task'): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, priority, owner_id, status) VALUES (uuid7(), ?, 3, ?, 'open') RETURNING id`)
      .get(title, OWNER) as { id: string }
  ).id;
}

function insertBlock(taskId: string, startAt: string, endAt: string): string {
  return (
    sqlite
      .prepare(`INSERT INTO time_blocks (id, task_id, title, start_at, end_at, status, owner_id) VALUES (uuid7(), ?, 'planned block', ?, ?, 'planned', ?) RETURNING id`)
      .get(taskId, startAt, endAt, OWNER) as { id: string }
  ).id;
}

const blockStatus = (id: string): string =>
  (sqlite.prepare(`SELECT status FROM time_blocks WHERE id = ?`).get(id) as { status: string }).status;

/** Backdate the single running entry so the session reads as `minutesAgo` long. */
function backdateRunning(minutesAgo: number): void {
  const startedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  sqlite.prepare(`UPDATE time_entries SET started_at = ? WHERE ended_at IS NULL`).run(startedAt);
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); mockBroadcast.mockClear(); });

describe('§C1 — timer/stop route broadcasts block:updated on overrun', () => {
  it('overrun stop → block:updated broadcast carries the block id', async () => {
    const task = insertTask();
    const blockId = insertBlock(task, '2026-06-20T09:00:00.000Z', '2026-06-20T10:00:00.000Z'); // 60 min span

    await api(srv.url, `/api/tasks/${task}/timer/start`, { method: 'POST', json: { block_id: blockId } });
    backdateRunning(63); // 63 min > 60 + 2 tolerance → overrun

    const res = await api(srv.url, `/api/tasks/${task}/timer/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(blockStatus(blockId)).toBe('overrun');

    const calls = mockBroadcast.mock.calls.filter((c) => c[1] === 'block:updated');
    expect(calls).toHaveLength(1);
    expect((calls[0][2] as { id: string }).id).toBe(blockId);
  });

  it('non-overrun stop → no block:updated broadcast', async () => {
    const task = insertTask();
    const blockId = insertBlock(task, '2026-06-20T09:00:00.000Z', '2026-06-20T10:00:00.000Z');

    await api(srv.url, `/api/tasks/${task}/timer/start`, { method: 'POST', json: { block_id: blockId } });
    backdateRunning(61); // within 62-min threshold → no overrun

    const res = await api(srv.url, `/api/tasks/${task}/timer/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(blockStatus(blockId)).toBe('planned');
    expect(mockBroadcast.mock.calls.filter((c) => c[1] === 'block:updated')).toHaveLength(0);
  });

  it('implicit stop on a new start → overrun of the superseded block still broadcasts', async () => {
    const taskA = insertTask('A');
    const taskB = insertTask('B');
    const blockA = insertBlock(taskA, '2026-06-20T09:00:00.000Z', '2026-06-20T10:00:00.000Z');

    await api(srv.url, `/api/tasks/${taskA}/timer/start`, { method: 'POST', json: { block_id: blockA } });
    backdateRunning(63); // A overran
    mockBroadcast.mockClear();

    // Starting B implicitly stops A — A's overrun must still broadcast.
    const res = await api(srv.url, `/api/tasks/${taskB}/timer/start`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(blockStatus(blockA)).toBe('overrun');

    const calls = mockBroadcast.mock.calls.filter((c) => c[1] === 'block:updated');
    expect(calls).toHaveLength(1);
    expect((calls[0][2] as { id: string }).id).toBe(blockA);
  });
});
