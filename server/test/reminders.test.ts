import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { registerClient } from '../src/routes/sse.js';
import { zonedWallTimeToUTC } from '../src/lib/tz.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

// web-push is mocked so the dispatcher's delivery is observable without a real push
// service. sendPush default is 'ok'; individual tests override per case.
vi.mock('../src/lib/push.js', () => ({
  sendPush: vi.fn(async () => 'ok'),
  pushEnabled: () => true,
}));

import { fireDueReminders, syncTaskReminders } from '../src/engine/reminders.js';
import { generateRecurrences } from '../src/engine/recurrence-generate.js';
import { sendPush } from '../src/lib/push.js';

/**
 * Phase H — reminder dispatch + the push/reminder API. The dispatcher's exactly-once
 * guarantee (claim-by-UPDATE), tz-correct fire_at, push→in-app fallback, dead-sub
 * pruning, owner isolation, and the CHECK (task XOR block) are the load-bearing cases.
 */

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const collect = (s: PassThrough) => { let buf = ''; s.on('data', (c) => { buf += c.toString(); }); return () => buf; };
const tick = () => new Promise((r) => setImmediate(r));
const fireCount = (buf: string) => (buf.match(/event: reminder:fire/g) ?? []).length;

function insertTask(title = 'T'): string {
  return (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (?, ?, ?, 'open') RETURNING id`)
    .get(newId(), title, SYSTEM_OWNER) as { id: string }).id;
}
function insertBlock(title = 'B'): string {
  return (sqlite.prepare(`INSERT INTO time_blocks (id, title, start_at, end_at, owner_id) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(newId(), title, FUTURE, FUTURE, SYSTEM_OWNER) as { id: string }).id;
}
function insertReminder(o: { taskId?: string; blockId?: string; fireAt: string; status?: string; owner?: string }): string {
  return (sqlite.prepare(
    `INSERT INTO reminders (id, owner_id, task_id, block_id, fire_at, status) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(newId(), o.owner ?? SYSTEM_OWNER, o.taskId ?? null, o.blockId ?? null, o.fireAt, o.status ?? 'pending') as { id: string }).id;
}
function insertPushSub(owner: string, endpoint: string): void {
  sqlite.prepare(`INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth) VALUES (?, ?, ?, 'p', 'a')`)
    .run(newId(), owner, endpoint);
}
function insertTaskDue(dueAt: string | null): string {
  return (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, due_at) VALUES (?, 'Due task', ?, 'open', ?) RETURNING id`)
    .get(newId(), SYSTEM_OWNER, dueAt) as { id: string }).id;
}
/** Mimic Settings "Reminder Defaults": write the offsets onto a (fresh) pattern tag's prefs. */
function setReminderOffsets(offsets: number[]): void {
  const tagId = (sqlite.prepare(`INSERT INTO tags (id, name, kind, is_base, owner_id) VALUES (?, ?, 'pattern', 1, ?) RETURNING id`)
    .get(newId(), `pat-${newId().slice(0, 8)}`, SYSTEM_OWNER) as { id: string }).id;
  sqlite.prepare(`INSERT INTO tag_prefs (id, owner_id, tag_id, kind, reminder_offsets) VALUES (?, ?, ?, 'pattern', ?)`)
    .run(newId(), SYSTEM_OWNER, tagId, JSON.stringify(offsets));
}
const autoCount = (taskId: string) =>
  (sqlite.prepare(`SELECT COUNT(*) c FROM reminders WHERE task_id = ? AND source = 'auto'`).get(taskId) as { c: number }).c;
const setTaskStatus = (id: string, status: string) => sqlite.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id);
const reminderStatus = (taskId: string) =>
  (sqlite.prepare(`SELECT status FROM reminders WHERE task_id = ? LIMIT 1`).get(taskId) as { status: string } | undefined)?.status;
const firstFireAt = (taskId: string) =>
  (sqlite.prepare(`SELECT fire_at FROM reminders WHERE task_id = ? AND source = 'auto' ORDER BY fire_at LIMIT 1`).get(taskId) as
    { fire_at: string } | undefined)?.fire_at;
function insertScheduledTask(o: { scheduledFor?: string; taskTime?: string; dueAt?: string; status?: string }): string {
  return (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, scheduled_for, task_time, due_at) VALUES (?, 'Sched', ?, ?, ?, ?, ?) RETURNING id`,
  ).get(newId(), SYSTEM_OWNER, o.status ?? 'open', o.scheduledFor ?? null, o.taskTime ?? null, o.dueAt ?? null) as { id: string }).id;
}
function insertTemplate(rule: string, taskTime: string | null, dtstart: string): string {
  return (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, task_time, subtype, recurrence_rule, recurrence_dtstart)
     VALUES (?, 'Recurring habit', ?, 'open', ?, 'habit', ?, ?) RETURNING id`,
  ).get(newId(), SYSTEM_OWNER, taskTime, rule, dtstart) as { id: string }).id;
}
const FAR_FUTURE_DUE = '2999-01-01T12:00:00.000Z';
const getReminder = (id: string) => sqlite.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as
  { status: string; fired_at: string | null; fire_at: string } | undefined;

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  vi.mocked(sendPush).mockClear();
  vi.mocked(sendPush).mockResolvedValue('ok');
});

describe('dispatcher — fireDueReminders', () => {
  it('fires a due reminder exactly once and delivers reminder:fire in-app', async () => {
    const id = insertReminder({ taskId: insertTask('Pay rent'), fireAt: PAST });
    const pt = new PassThrough(); const text = collect(pt); const off = registerClient(pt, SYSTEM_OWNER);

    const n1 = await fireDueReminders(); await tick();
    expect(n1).toBe(1);
    expect(getReminder(id)).toMatchObject({ status: 'fired' });
    expect(getReminder(id)!.fired_at).toBeTruthy();
    expect(fireCount(text())).toBe(1);

    // Second tick re-selects nothing — never a double-fire.
    const n2 = await fireDueReminders(); await tick();
    expect(n2).toBe(0);
    expect(fireCount(text())).toBe(1);
    off();
  });

  it('does not fire before the tz-correct instant; fires at/after it', async () => {
    // 09:00 in America/Los_Angeles on a summer (PDT, -7) day = 16:00 UTC.
    const fireAt = zonedWallTimeToUTC('2026-07-01', '09:00', 'America/Los_Angeles');
    expect(fireAt).toBe('2026-07-01T16:00:00.000Z'); // locks the tz math (not naive `${date}T${time}Z`)
    insertReminder({ taskId: insertTask(), fireAt });

    const oneMinBefore = new Date(Date.parse(fireAt) - 60_000).toISOString();
    expect(await fireDueReminders(oneMinBefore)).toBe(0);
    expect(await fireDueReminders(fireAt)).toBe(1);
  });

  it('push failure falls back to in-app (SSE still delivered)', async () => {
    vi.mocked(sendPush).mockResolvedValue('fail');
    insertPushSub(SYSTEM_OWNER, 'https://push.example/ep1');
    insertReminder({ taskId: insertTask(), fireAt: PAST });
    const pt = new PassThrough(); const text = collect(pt); const off = registerClient(pt, SYSTEM_OWNER);

    const n = await fireDueReminders(); await tick();
    expect(n).toBe(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(fireCount(text())).toBe(1); // in-app fired despite push failure
    off();
  });

  it('prunes a dead subscription (404/410 → gone)', async () => {
    vi.mocked(sendPush).mockResolvedValue('gone');
    insertPushSub(SYSTEM_OWNER, 'https://push.example/dead');
    insertReminder({ taskId: insertTask(), fireAt: PAST });

    await fireDueReminders();
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM push_subscriptions`).get() as { c: number }).c).toBe(0);
  });

  it('owner isolation: only the target owner receives the event + uses their subs', async () => {
    const ownerB = newId();
    sqlite.prepare(`INSERT INTO owners (id, name) VALUES (?, 'B')`).run(ownerB);
    insertPushSub(SYSTEM_OWNER, 'https://push.example/a');
    insertPushSub(ownerB, 'https://push.example/b');
    insertReminder({ taskId: insertTask(), fireAt: PAST }); // SYSTEM_OWNER's reminder

    const a = new PassThrough(); const textA = collect(a); const offA = registerClient(a, SYSTEM_OWNER);
    const b = new PassThrough(); const textB = collect(b); const offB = registerClient(b, ownerB);

    await fireDueReminders(); await tick();
    expect(fireCount(textA())).toBe(1);
    expect(textB()).not.toContain('reminder:fire');
    expect(sendPush).toHaveBeenCalledTimes(1); // only SYSTEM_OWNER's sub, not owner B's
    offA(); offB();
  });
});

describe('reminders — CHECK (exactly one target)', () => {
  it('rejects both task and block targets', () => {
    const taskId = insertTask(); const blockId = insertBlock();
    expect(() => sqlite.prepare(
      `INSERT INTO reminders (id, owner_id, task_id, block_id, fire_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(newId(), SYSTEM_OWNER, taskId, blockId, FUTURE)).toThrow(/CHECK/i);
  });

  it('rejects neither target', () => {
    expect(() => sqlite.prepare(
      `INSERT INTO reminders (id, owner_id, task_id, block_id, fire_at) VALUES (?, ?, NULL, NULL, ?)`,
    ).run(newId(), SYSTEM_OWNER, FUTURE)).toThrow(/CHECK/i);
  });
});

describe('routes — push subscriptions', () => {
  it('GET /api/push/vapid-key returns a key field', async () => {
    const r = await api(srv.url, '/api/push/vapid-key');
    expect(r.status).toBe(200);
    expect(typeof r.body.key).toBe('string');
  });

  it('POST /api/push/subscribe upserts by endpoint (one row, keys updated)', async () => {
    const endpoint = 'https://push.example/route1';
    const sub = (p: string) => ({ subscription: { endpoint, keys: { p256dh: p, auth: 'a' } } });
    expect((await api(srv.url, '/api/push/subscribe', { method: 'POST', json: sub('key1') })).status).toBe(201);
    expect((await api(srv.url, '/api/push/subscribe', { method: 'POST', json: sub('key2') })).status).toBe(201);

    const rows = sqlite.prepare(`SELECT p256dh FROM push_subscriptions WHERE endpoint = ?`).all(endpoint) as { p256dh: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('key2');
  });

  it('DELETE /api/push/subscribe removes the endpoint (bodyparser reads the DELETE body)', async () => {
    const endpoint = 'https://push.example/bye';
    await api(srv.url, '/api/push/subscribe', { method: 'POST', json: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } } });
    const r = await api(srv.url, '/api/push/subscribe', { method: 'DELETE', json: { endpoint } });
    expect(r.status).toBe(200);
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM push_subscriptions WHERE endpoint = ?`).get(endpoint) as { c: number }).c).toBe(0);
  });
});

describe('routes — reminders', () => {
  it('POST /api/reminders resolves date+time to a tz-correct UTC fire_at (UTC owner)', async () => {
    const taskId = insertTask(); // resetDb pins scheduling_prefs.timezone = 'UTC'
    const r = await api(srv.url, '/api/reminders', { method: 'POST', json: { taskId, date: '2026-07-01', time: '09:00' } });
    expect(r.status).toBe(201);
    expect(r.body.reminder.fire_at).toBe('2026-07-01T09:00:00.000Z');
    expect(r.body.reminder.status).toBe('pending');
  });

  it('POST /api/reminders 422s unless exactly one target + a time is given', async () => {
    const taskId = insertTask(); const blockId = insertBlock();
    expect((await api(srv.url, '/api/reminders', { method: 'POST', json: { taskId, blockId, fireAt: FUTURE } })).status).toBe(422);
    expect((await api(srv.url, '/api/reminders', { method: 'POST', json: { fireAt: FUTURE } })).status).toBe(422);
    expect((await api(srv.url, '/api/reminders', { method: 'POST', json: { taskId } })).status).toBe(422);
    expect((await api(srv.url, '/api/reminders', { method: 'POST', json: { taskId, fireAt: FUTURE } })).status).toBe(201);
  });

  it('DELETE /api/reminders/:id cancels and drops it from the live list', async () => {
    const taskId = insertTask();
    const id = (await api(srv.url, '/api/reminders', { method: 'POST', json: { taskId, fireAt: FUTURE } })).body.reminder.id;
    expect((await api(srv.url, `/api/reminders/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(getReminder(id)).toMatchObject({ status: 'cancelled' });
    const list = (await api(srv.url, '/api/reminders')).body.reminders as { id: string }[];
    expect(list.find((x) => x.id === id)).toBeUndefined();
  });

  it('POST /api/reminders/:id/snooze re-arms a fired reminder forward, no double-fire', async () => {
    const taskId = insertTask();
    const id = (await api(srv.url, '/api/reminders', { method: 'POST', json: { taskId, fireAt: PAST } })).body.reminder.id;
    const pt = new PassThrough(); const text = collect(pt); const off = registerClient(pt, SYSTEM_OWNER);

    expect(await fireDueReminders()).toBe(1); await tick();
    expect(getReminder(id)).toMatchObject({ status: 'fired' });
    expect(fireCount(text())).toBe(1);

    const r = await api(srv.url, `/api/reminders/${id}/snooze`, { method: 'POST', json: { minutes: 10 } });
    expect(r.status).toBe(200);
    expect(getReminder(id)).toMatchObject({ status: 'pending', fired_at: null });
    expect(Date.parse(getReminder(id)!.fire_at)).toBeGreaterThan(Date.now()); // re-armed into the future

    // The original (past) instant never re-fires; the new fire_at hasn't arrived.
    expect(await fireDueReminders()).toBe(0); await tick();
    expect(fireCount(text())).toBe(1);
    off();
  });
});

describe('auto-derive — syncTaskReminders (Phase H b)', () => {
  it('derives one reminder per configured offset at due − offset (source=auto)', () => {
    setReminderOffsets([0, 15]);
    const taskId = insertTaskDue(FAR_FUTURE_DUE);
    expect(syncTaskReminders(SYSTEM_OWNER, taskId)).toBe(2);
    const rows = sqlite.prepare(`SELECT fire_at, status, source FROM reminders WHERE task_id = ? ORDER BY fire_at`).all(taskId) as
      { fire_at: string; status: string; source: string }[];
    expect(rows.map((r) => r.fire_at)).toEqual(['2999-01-01T11:45:00.000Z', '2999-01-01T12:00:00.000Z']);
    expect(rows.every((r) => r.status === 'pending' && r.source === 'auto')).toBe(true);
  });

  it('replaces only its own auto rows on re-sync; manual reminders survive', () => {
    setReminderOffsets([0]);
    const taskId = insertTaskDue(FAR_FUTURE_DUE);
    insertReminder({ taskId, fireAt: FAR_FUTURE_DUE }); // manual (source defaults to 'manual')
    expect(syncTaskReminders(SYSTEM_OWNER, taskId)).toBe(1);
    expect(autoCount(taskId)).toBe(1);
    expect(syncTaskReminders(SYSTEM_OWNER, taskId)).toBe(1); // re-derive replaces the auto row
    expect(autoCount(taskId)).toBe(1);
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM reminders WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(2); // manual + auto
  });

  it('creates nothing without a due_at, and clears stale auto rows', () => {
    setReminderOffsets([0]);
    const taskId = insertTaskDue(null);
    expect(syncTaskReminders(SYSTEM_OWNER, taskId)).toBe(0);
    expect(autoCount(taskId)).toBe(0);
  });

  it('creates nothing when no Reminder Defaults are configured', () => {
    expect(syncTaskReminders(SYSTEM_OWNER, insertTaskDue(FAR_FUTURE_DUE))).toBe(0);
  });

  it('skips already-due fire times (no backfill)', () => {
    setReminderOffsets([0]);
    expect(syncTaskReminders(SYSTEM_OWNER, insertTaskDue(PAST))).toBe(0);
  });

  it('POST /api/tasks with a due date auto-creates reminders (route hook)', async () => {
    setReminderOffsets([10]);
    const r = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Ship it', due_at: FAR_FUTURE_DUE } });
    expect(r.status).toBe(201);
    const taskId = r.body.task.id as string;
    expect(autoCount(taskId)).toBe(1);
    expect((sqlite.prepare(`SELECT fire_at FROM reminders WHERE task_id = ? AND source = 'auto'`).get(taskId) as { fire_at: string }).fire_at)
      .toBe('2999-01-01T11:50:00.000Z'); // due − 10min
  });
});

describe('reminder lifecycle vs task status (Phase H b)', () => {
  it('does not fire a reminder once its task is terminal; fires again if re-opened', async () => {
    const taskId = insertTask('Finish me');
    insertReminder({ taskId, fireAt: PAST });
    setTaskStatus(taskId, 'done');
    expect(await fireDueReminders()).toBe(0);          // task is done → reminder withheld
    expect(reminderStatus(taskId)).toBe('pending');     // not fired, still claimable
    setTaskStatus(taskId, 'open');
    expect(await fireDueReminders()).toBe(1);           // re-opened → fires
  });

  it('syncTaskReminders clears and stops deriving once a task is completed', () => {
    setReminderOffsets([0]);
    const taskId = insertTaskDue(FAR_FUTURE_DUE);
    expect(syncTaskReminders(SYSTEM_OWNER, taskId)).toBe(1);
    expect(autoCount(taskId)).toBe(1);
    setTaskStatus(taskId, 'done');
    expect(syncTaskReminders(SYSTEM_OWNER, taskId)).toBe(0); // terminal → cleared, nothing derived
    expect(autoCount(taskId)).toBe(0);
  });

  it('DELETE /api/tasks/:id drops the task’s auto reminders', async () => {
    setReminderOffsets([10]);
    const taskId = (await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Temp', due_at: FAR_FUTURE_DUE } })).body.task.id as string;
    expect(autoCount(taskId)).toBe(1);
    expect((await api(srv.url, `/api/tasks/${taskId}`, { method: 'DELETE' })).status).toBe(200);
    expect(autoCount(taskId)).toBe(0);
  });
});

describe('auto-derive — scheduled-start anchor (PR A)', () => {
  it('anchors on scheduled_for + task_time when there is no due_at', () => {
    setReminderOffsets([15]);
    const id = insertScheduledTask({ scheduledFor: '2999-01-01', taskTime: '09:00' });
    expect(syncTaskReminders(SYSTEM_OWNER, id)).toBe(1);
    expect(firstFireAt(id)).toBe('2999-01-01T08:45:00.000Z'); // 09:00 UTC − 15min
  });

  it('prefers the scheduled start over due_at when both are present', () => {
    setReminderOffsets([0]);
    const id = insertScheduledTask({ scheduledFor: '2999-01-01', taskTime: '09:00', dueAt: '2999-06-01T00:00:00.000Z' });
    expect(syncTaskReminders(SYSTEM_OWNER, id)).toBe(1);
    expect(firstFireAt(id)).toBe('2999-01-01T09:00:00.000Z'); // scheduled start, not the deadline
  });

  it('creates nothing for an untimed task (no task_time, no due_at)', () => {
    setReminderOffsets([0]);
    expect(syncTaskReminders(SYSTEM_OWNER, insertScheduledTask({ scheduledFor: '2999-01-01' }))).toBe(0);
  });
});

describe('auto-derive — recurring instances (PR A: generateRecurrences hook)', () => {
  it('derives reminders for each materialized instance, idempotently', () => {
    setReminderOffsets([10]);
    insertTemplate('FREQ=DAILY', '09:00', '2999-01-01T09:00:00.000Z');
    const res = generateRecurrences({ today: '2999-01-01', horizonDays: 2 });
    expect(res.created).toBeGreaterThanOrEqual(1);

    const autos = sqlite.prepare(
      `SELECT r.fire_at FROM reminders r JOIN tasks t ON t.id = r.task_id
        WHERE t.recurrence_parent_id IS NOT NULL AND r.source = 'auto' ORDER BY r.fire_at`,
    ).all() as { fire_at: string }[];
    expect(autos.length).toBe(res.created);                              // one reminder per instance (offset 10)
    expect(autos.map((a) => a.fire_at)).toContain('2999-01-01T08:50:00.000Z'); // 09:00 − 10min

    // Idempotent: re-running materializes no new instances → no new reminders.
    generateRecurrences({ today: '2999-01-01', horizonDays: 2 });
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM reminders WHERE source = 'auto'`).get() as { c: number }).c).toBe(autos.length);
  });
});
