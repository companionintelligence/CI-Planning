/**
 * Phase M §C1 (docs/M-ai-scheduler.md:322): an overrun on timer-stop is a natural
 * requestReplan('overrun') trigger — a block running long shifts the day's obstacles,
 * so the remaining blocks should re-pack. This asserts the route wires that trigger
 * (and does NOT fire it on a normal, non-overrun stop). requestReplan is mocked so the
 * test asserts the wire-up, not the (separately-tested) debounced reflow itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.hoisted: the spy must exist before the hoisted vi.mock factory runs.
const { requestReplanSpy } = vi.hoisted(() => ({ requestReplanSpy: vi.fn() }));
vi.mock('../src/engine/auto-defense.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/engine/auto-defense.js')>();
  return { ...actual, requestReplan: requestReplanSpy };
});

import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';
import { startTimer } from '../src/services/timer.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

function insertTask(title = 'Timed'): string {
  return (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`).get(title, OWNER) as { id: string }).id;
}
function insertBlock(taskId: string, startAt: string, endAt: string): string {
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, status, owner_id) VALUES (uuid7(), ?, 'Block', 'task', ?, ?, 'planned', ?) RETURNING id`)
    .get(taskId, startAt, endAt, OWNER) as { id: string }).id;
}
/** Start a timer on (task, block) and backdate its start so the session lasts `sessionMin`. */
function startBackdated(task: string, block: string | undefined, sessionMin: number): void {
  runWithOwner(OWNER, ALL_SCOPES, () => {
    const { entry } = startTimer(task, block as unknown as number);
    const startedAt = new Date(Date.now() - sessionMin * 60_000).toISOString();
    sqlite.prepare(`UPDATE time_entries SET started_at = ? WHERE id = ?`).run(startedAt, entry.id);
  });
}

let srv: TestServer;
beforeEach(async () => { resetDb(); requestReplanSpy.mockClear(); srv = await startTestServer(); });
afterEach(async () => { await srv.close(); });

describe('overrun → requestReplan (C1)', () => {
  it("fires requestReplan('overrun') when a session overruns its block", async () => {
    const task = insertTask();
    const block = insertBlock(task, '2026-06-15T09:00:00.000Z', '2026-06-15T09:30:00.000Z'); // 30m span
    startBackdated(task, block, 45); // 45m session > 30m + tolerance → overrun

    const res = await api(srv.url, `/api/tasks/${task}/timer/stop`, { method: 'POST', json: {} });
    expect(res.status).toBe(200);
    // The block flipped to overrun, and the route requested a reactive reflow.
    expect((sqlite.prepare(`SELECT status FROM time_blocks WHERE id = ?`).get(block) as { status: string }).status).toBe('overrun');
    expect(requestReplanSpy).toHaveBeenCalledWith('overrun', OWNER);
  });

  it('does NOT fire a reflow on a normal (within-span) stop', async () => {
    const task = insertTask();
    const block = insertBlock(task, '2026-06-15T09:00:00.000Z', '2026-06-15T09:30:00.000Z');
    startBackdated(task, block, 10); // well under the span → no overrun

    const res = await api(srv.url, `/api/tasks/${task}/timer/stop`, { method: 'POST', json: {} });
    expect(res.status).toBe(200);
    expect(requestReplanSpy).not.toHaveBeenCalled();
  });
});
