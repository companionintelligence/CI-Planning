/**
 * Phase Z · Z4 (Time-Sense) — Focus Ritual background cue reminders + push vibrate.
 *
 * The Focus screen arms a block's T1/T3/T4 cues for tab-closed Web Push delivery;
 * they carry distinct haptic patterns and fall silent once the block is skipped/
 * completed or its task is done. sendPush is mocked so we can assert the payload
 * (incl. vibrate) without a real push service.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../src/lib/push.js', () => ({
  sendPush: vi.fn(async () => 'ok'),
  pushEnabled: () => true,
}));

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { fireDueReminders, syncBlockFocusReminders } from '../src/engine/reminders.js';
import { sendPush } from '../src/lib/push.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

// Real-future times so arming (which uses Date.now()) keeps all three cues.
const START = '2099-01-01T10:00:00.000Z';
const END = '2099-01-01T11:00:00.000Z';
const WARN = '2099-01-01T10:57:00.000Z'; // END − 3 min
const AFTER = '2099-01-01T11:00:00.001Z'; // past all cues, for firing

function setFlag(on: boolean) {
  sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = ? WHERE owner_id = ?`).run(on ? 1 : 0, SYSTEM_OWNER);
}
function makeBlock(opts: { kind?: string; status?: string; task?: string | null; start?: string; end?: string }): string {
  return (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, status, task_id, owner_id)
       VALUES (uuid7(), 'Focus', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(opts.kind ?? 'task', opts.start ?? START, opts.end ?? END, opts.status ?? 'planned', opts.task ?? null, SYSTEM_OWNER) as { id: string }).id;
}
function makeTask(status = 'scheduled'): string {
  return (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'T', ?, ?) RETURNING id`)
    .get(SYSTEM_OWNER, status) as { id: string }).id;
}
function focusRows(blockId: string) {
  return sqlite
    .prepare(`SELECT source, fire_at, status FROM reminders WHERE block_id = ? AND source LIKE 'focus_%' ORDER BY fire_at`)
    .all(blockId) as { source: string; fire_at: string; status: string }[];
}
function addSub() {
  sqlite.prepare(`INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth) VALUES (uuid7(), ?, 'e', 'p', 'a')`).run(SYSTEM_OWNER);
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  vi.mocked(sendPush).mockClear();
  vi.mocked(sendPush).mockResolvedValue('ok');
});

describe('arming focus cues (syncBlockFocusReminders)', () => {
  it('arms T1/T3/T4 at start, end−3min, and end for an eligible planned block', () => {
    const b = makeBlock({ kind: 'task' });
    const n = syncBlockFocusReminders(SYSTEM_OWNER, b);
    expect(n).toBe(3);
    const rows = focusRows(b);
    expect(rows.map((r) => r.source)).toEqual(['focus_start', 'focus_warn', 'focus_end']);
    expect(rows.map((r) => r.fire_at)).toEqual([START, WARN, END]);
  });

  it('is idempotent — re-arming replaces, never duplicates', () => {
    const b = makeBlock({ kind: 'task' });
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    expect(focusRows(b)).toHaveLength(3);
  });

  it('arms nothing for an ineligible kind or a non-planned block', () => {
    expect(syncBlockFocusReminders(SYSTEM_OWNER, makeBlock({ kind: 'meeting' }))).toBe(0);
    expect(syncBlockFocusReminders(SYSTEM_OWNER, makeBlock({ kind: 'break' }))).toBe(0);
    expect(syncBlockFocusReminders(SYSTEM_OWNER, makeBlock({ kind: 'task', status: 'skipped' }))).toBe(0);
  });

  it('skips cues whose instant is already past (no backfill)', () => {
    // A block that started in the past but ends in the future: only future cues arm.
    const b = makeBlock({ kind: 'task', start: '2000-01-01T10:00:00.000Z', end: END });
    const rows = focusRows(b);
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    const armed = focusRows(b);
    expect(armed.map((r) => r.source)).toEqual(['focus_warn', 'focus_end']); // focus_start (past) skipped
  });
});

describe('POST/DELETE /api/blocks/:id/focus-reminders', () => {
  it('404s when Time-Sense is off', async () => {
    setFlag(false);
    const b = makeBlock({ kind: 'task' });
    expect((await api(srv.url, `/api/blocks/${b}/focus-reminders`, { method: 'POST' })).status).toBe(404);
  });

  it('arms via POST and clears via DELETE when the flag is on', async () => {
    setFlag(true);
    const b = makeBlock({ kind: 'task' });
    const armRes = await api(srv.url, `/api/blocks/${b}/focus-reminders`, { method: 'POST' });
    expect(armRes.status).toBe(200);
    expect(armRes.body.armed).toBe(3);
    expect(focusRows(b)).toHaveLength(3);

    const delRes = await api(srv.url, `/api/blocks/${b}/focus-reminders`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(focusRows(b)).toHaveLength(0);
  });

  it('reschedule clears a block\'s armed focus cues', async () => {
    setFlag(true);
    const t = makeTask('scheduled');
    const b = makeBlock({ kind: 'task', task: t });
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    expect(focusRows(b)).toHaveLength(3);
    await api(srv.url, `/api/blocks/${b}/reschedule`, { method: 'POST' });
    expect(focusRows(b)).toHaveLength(0);
  });
});

describe('firing focus cues + vibrate payload', () => {
  it('delivers each cue with its title and haptic pattern', async () => {
    addSub();
    const b = makeBlock({ kind: 'task' });
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    const fired = await fireDueReminders(AFTER);
    expect(fired).toBe(3);

    const payloads = vi.mocked(sendPush).mock.calls.map((c) => c[1] as Record<string, unknown>);
    const byTitle = Object.fromEntries(payloads.map((p) => [p.title, p]));
    expect(byTitle['Focus started']?.vibrate).toEqual([200]);
    expect(byTitle['3 minutes left']?.vibrate).toEqual([100, 50, 100]);
    expect(byTitle["Time's up"]?.vibrate).toEqual([300, 120, 300]);
  });

  it('a skipped block\'s cues never fire', async () => {
    addSub();
    const b = makeBlock({ kind: 'task' });
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    sqlite.prepare(`UPDATE time_blocks SET status = 'skipped' WHERE id = ?`).run(b);
    expect(await fireDueReminders(AFTER)).toBe(0);
  });

  it('cues fall silent once the linked task is done (Objective complete)', async () => {
    addSub();
    const t = makeTask('scheduled');
    const b = makeBlock({ kind: 'task', task: t });
    syncBlockFocusReminders(SYSTEM_OWNER, b);
    sqlite.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(t);
    expect(await fireDueReminders(AFTER)).toBe(0); // block still 'planned', but its task is done
  });

  it('ordinary (non-focus) reminders carry no vibrate', async () => {
    addSub();
    const t = makeTask('scheduled');
    sqlite.prepare(`INSERT INTO reminders (id, owner_id, task_id, fire_at, source, status) VALUES (uuid7(), ?, ?, ?, 'auto', 'pending')`)
      .run(SYSTEM_OWNER, t, START);
    await fireDueReminders(AFTER);
    const payload = vi.mocked(sendPush).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.vibrate).toBeUndefined();
  });
});
