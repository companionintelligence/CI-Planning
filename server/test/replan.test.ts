/**
 * B2 — requestReplan debounce/toggle + sweepMissedBlocks.
 *
 * `broadcast` is mocked so we can count `schedule:done` emissions (one per reflow).
 * The debounce uses setTimeout, so the burst tests drive fake timers.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/routes/sse.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/routes/sse.js')>();
  return { ...actual, broadcast: vi.fn() };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';
import { requestReplan, sweepMissedBlocks, _resetReplanState } from '../src/engine/auto-defense.js';
import { broadcast } from '../src/routes/sse.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-06-24';
const mockBroadcast = vi.mocked(broadcast);

function setAutoDefense(on: boolean): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET auto_defense_enabled = ? WHERE owner_id = ?`).run(on ? 1 : 0, OWNER);
}
const eventCount = (name: string): number => mockBroadcast.mock.calls.filter((c) => c[1] === name).length;

function insertTask(title: string, status = 'open'): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), ?, ?, ?, 3) RETURNING id`)
      .get(title, OWNER, status) as { id: string }
  ).id;
}
function insertAutoBlock(taskId: string, startAt: string, endAt: string, status = 'planned'): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_auto, source_kind, status)
         VALUES (uuid7(), ?, 'B', 'task', ?, ?, 1, 'agent', ?) RETURNING id`
      )
      .get(taskId, startAt, endAt, status) as { id: string }
  ).id;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.exec(`DELETE FROM flight_plan`);
  sqlite.exec(`DELETE FROM daily_plan WHERE owner_id = '${OWNER}'`);
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC', workday_start = '09:00', workday_end = '18:00' WHERE owner_id = ?`).run(OWNER);
  _resetReplanState();
  mockBroadcast.mockClear();
});

describe('requestReplan — debounce + toggle', () => {
  it('collapses a burst of 5 calls into exactly one reflow', () => {
    vi.useFakeTimers();
    try {
      setAutoDefense(true);
      for (let i = 0; i < 5; i++) requestReplan('task:updated', OWNER, DATE);
      expect(eventCount('schedule:done')).toBe(0); // trailing — nothing fired yet
      vi.advanceTimersByTime(1500);
      expect(eventCount('schedule:done')).toBe(1); // one reflow for the whole burst
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op (no reflow, no broadcast) when auto_defense_enabled = 0', () => {
    vi.useFakeTimers();
    try {
      setAutoDefense(false);
      requestReplan('task:updated', OWNER, DATE);
      vi.advanceTimersByTime(1500);
      expect(eventCount('schedule:done')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws into the caller', () => {
    setAutoDefense(true);
    expect(() => requestReplan('task:updated', OWNER, DATE)).not.toThrow();
    _resetReplanState(); // cancel the real-timer we just scheduled so it can't leak
  });
});

describe('sweepMissedBlocks', () => {
  const NOON = Date.parse(`${DATE}T12:00:00.000Z`);

  it('marks a past planned block missed and re-queues its open task', () => {
    const taskId = insertTask('Missed work');
    const blockId = insertAutoBlock(taskId, `${DATE}T09:00:00.000Z`, `${DATE}T10:00:00.000Z`); // ended 10:00, now noon

    const res = sweepMissedBlocks(OWNER, DATE, NOON);

    expect(res.skipped).toBe(1);
    expect(res.requeued).toBe(1);
    expect((sqlite.prepare(`SELECT status FROM time_blocks WHERE id = ?`).get(blockId) as { status: string }).status).toBe('skipped');
    expect(sqlite.prepare(`SELECT 1 FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(OWNER, taskId)).toBeTruthy();
  });

  it('leaves a block whose planned time has not yet passed', () => {
    const taskId = insertTask('Future work');
    const blockId = insertAutoBlock(taskId, `${DATE}T14:00:00.000Z`, `${DATE}T15:00:00.000Z`); // ends 15:00, after noon

    const res = sweepMissedBlocks(OWNER, DATE, NOON);

    expect(res.skipped).toBe(0);
    expect((sqlite.prepare(`SELECT status FROM time_blocks WHERE id = ?`).get(blockId) as { status: string }).status).toBe('planned');
  });

  it('sweeps the block but does not re-queue a non-open task', () => {
    const taskId = insertTask('Already done', 'done');
    insertAutoBlock(taskId, `${DATE}T09:00:00.000Z`, `${DATE}T10:00:00.000Z`);

    const res = sweepMissedBlocks(OWNER, DATE, NOON);

    expect(res.skipped).toBe(1);
    expect(res.requeued).toBe(0); // a completed task's stale block isn't re-queued work
    expect(sqlite.prepare(`SELECT 1 FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(OWNER, taskId)).toBeFalsy();
  });

  it('does not touch a started (in_progress) block', () => {
    const taskId = insertTask('In progress');
    const blockId = insertAutoBlock(taskId, `${DATE}T09:00:00.000Z`, `${DATE}T10:00:00.000Z`, 'in_progress');

    const res = sweepMissedBlocks(OWNER, DATE, NOON);

    expect(res.skipped).toBe(0);
    expect((sqlite.prepare(`SELECT status FROM time_blocks WHERE id = ?`).get(blockId) as { status: string }).status).toBe('in_progress');
  });
});

describe('trigger wiring — task mutation over HTTP requests a reflow', () => {
  it('POST /api/tasks fires a debounced reflow when auto-defense is on', async () => {
    setAutoDefense(true);
    const res = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'New task', priority: 2 } });
    expect(res.status).toBe(201);
    expect(eventCount('schedule:done')).toBe(0); // still debouncing

    // Wait out the 1.5 s trailing debounce (one real wait — the only timed path).
    await new Promise((r) => setTimeout(r, 1700));
    expect(eventCount('schedule:done')).toBe(1);
  });

  it('POST /api/tasks does NOT reflow when auto-defense is off', async () => {
    setAutoDefense(false);
    const res = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Quiet task' } });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 1700));
    expect(eventCount('schedule:done')).toBe(0);
  });
});
