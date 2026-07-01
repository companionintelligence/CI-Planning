import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * T-CORE-4 — POST /api/days/:date/clear clears ONLY the day's auto-placed agent
 * task blocks, mirroring clearPriorAuto. It must preserve user-placed, locked,
 * calendar meetings, pattern/habit placements, and completed/skipped blocks.
 */

const exists = (id: string) => !!sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(id);

// Insert a time_block directly (the API can't create agent/auto blocks).
function insertBlock(o: {
  title: string;
  kind?: string;
  auto?: boolean;
  locked?: boolean;
  source?: string;
  status?: string;
  start?: string;
  end?: string;
}): string {
  const row = sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      o.title,
      o.kind ?? 'task',
      o.start ?? '2026-06-20T10:00:00.000Z',
      o.end ?? '2026-06-20T11:00:00.000Z',
      o.locked ? 1 : 0,
      o.auto ? 1 : 0,
      o.source ?? 'agent',
      o.status ?? 'open',
    ) as { id: string };
  return row.id;
}

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
beforeEach(() => {
  resetDb(); // pins timezone='UTC' → the 2026-06-20 local day is [00:00Z, +24h)
});

describe('POST /api/days/:date/clear', () => {
  it('clears only auto-placed agent task blocks; preserves everything else', async () => {
    const autoAgent = insertBlock({ title: 'auto task', auto: true, source: 'agent' });
    const locked = insertBlock({ title: 'locked auto', auto: true, locked: true, source: 'agent' });
    const manual = insertBlock({ title: 'user placed', auto: false, source: 'manual' });
    const meeting = insertBlock({ title: 'standup', kind: 'meeting', auto: false, source: 'google' });
    const habit = insertBlock({ title: 'habit placement', auto: true, source: 'pattern' });
    const completed = insertBlock({ title: 'done auto', auto: true, source: 'agent', status: 'completed' });

    const { status, body } = await api(srv.url, '/api/days/2026-06-20/clear', { method: 'POST', json: {} });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(1);

    expect(exists(autoAgent)).toBe(false); // the only one cleared
    expect(exists(locked)).toBe(true);
    expect(exists(manual)).toBe(true);
    expect(exists(meeting)).toBe(true);
    expect(exists(habit)).toBe(true);
    expect(exists(completed)).toBe(true);
  });

  it('does not touch auto blocks on a different day', async () => {
    const otherDay = insertBlock({
      title: 'tomorrow auto',
      auto: true,
      source: 'agent',
      start: '2026-06-21T10:00:00.000Z',
      end: '2026-06-21T11:00:00.000Z',
    });
    const { body } = await api(srv.url, '/api/days/2026-06-20/clear', { method: 'POST', json: {} });
    expect(body.cleared).toBe(0);
    expect(exists(otherDay)).toBe(true);
  });

  it('is idempotent — a second call (and an empty day) clears 0', async () => {
    insertBlock({ title: 'auto task', auto: true, source: 'agent' });
    expect((await api(srv.url, '/api/days/2026-06-20/clear', { method: 'POST', json: {} })).body.cleared).toBe(1);
    expect((await api(srv.url, '/api/days/2026-06-20/clear', { method: 'POST', json: {} })).body.cleared).toBe(0);
  });

  it('reverts a scheduled task to open when clear removes its last placement (no strand)', async () => {
    // A task at status='scheduled' (as a manual placement would leave it) whose only
    // remaining block is an agent auto-block that clear-day removes.
    const taskId = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Scheduled thing', ?, 'scheduled') RETURNING id`).get(SYSTEM_OWNER) as { id: string }).id;
    sqlite.prepare(
      `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status)
       VALUES (uuid7(), ?, 'Scheduled thing', 'task', '2026-06-20T10:00:00.000Z', '2026-06-20T11:00:00.000Z', 0, 1, 'agent', 'planned')`,
    ).run(taskId);

    const { body } = await api(srv.url, '/api/days/2026-06-20/clear', { method: 'POST', json: {} });
    expect(body.cleared).toBe(1);
    const status = (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status;
    expect(status).toBe('open'); // returned to the backlog, not stranded at 'scheduled'
  });
});
