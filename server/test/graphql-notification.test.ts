import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';

/**
 * Phase W · W10 — ReminderType + PushSubscriptionType end-to-end over HTTP. Proves the
 * reminders/pushSubscriptions/pushVapidKey queries, createReminder (task- and
 * block-linked, exactly-one-of validation), cancelReminder (soft-cancel, excluded from
 * the live list, visible via REST GET reflecting the same), snoozeReminder, push
 * subscribe/unsubscribe, the task/block field resolvers (mutually exclusive), cross-owner
 * isolation, and REST cross-checks (reuses the SAME services/notifications.ts the REST
 * routes call).
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function insertTask(owner = OWNER, title = 'T'): string {
  return (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (?, ?, ?, 'open') RETURNING id`)
    .get(newId(), title, owner) as { id: string }).id;
}
function insertBlock(owner = OWNER, title = 'B'): string {
  return (sqlite.prepare(`INSERT INTO time_blocks (id, title, start_at, end_at, owner_id) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(newId(), title, FUTURE, FUTURE, owner) as { id: string }).id;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('W10 — ReminderType', () => {
  it('createReminder (task-linked) is visible via query + REST GET; task resolves, block is null', async () => {
    const taskId = insertTask();
    const m = await gql(`mutation { createReminder(input: { taskId: "${taskId}", fireAt: "${FUTURE}" }) { success reminder { id status source fireAt task { id } block { id } } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createReminder.success).toBe(true);
    const r = m.body.data.createReminder.reminder;
    expect(r.status).toBe('pending');
    expect(r.source).toBe('manual');
    expect(r.task).toEqual({ id: taskId });
    expect(r.block).toBeNull();

    const q = await gql('{ reminders { id fireAt } }');
    expect(q.body.data.reminders.map((x: any) => x.id)).toContain(r.id);

    const rest = await api(srv.url, '/api/reminders');
    expect((rest.body.reminders as { id: string }[]).some((x) => x.id === r.id)).toBe(true);
  });

  it('createReminder (block-linked) resolves block, task is null', async () => {
    const blockId = insertBlock();
    const m = await gql(`mutation { createReminder(input: { blockId: "${blockId}", fireAt: "${FUTURE}" }) { reminder { task { id } block { id } } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createReminder.reminder.task).toBeNull();
    expect(m.body.data.createReminder.reminder.block).toEqual({ id: blockId });
  });

  it('createReminder resolves date+time to a tz-correct UTC fireAt (UTC owner)', async () => {
    const taskId = insertTask(); // resetDb pins scheduling_prefs.timezone = 'UTC'
    const m = await gql(`mutation { createReminder(input: { taskId: "${taskId}", date: "2026-07-01", time: "09:00" }) { reminder { fireAt } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createReminder.reminder.fireAt).toBe('2026-07-01T09:00:00.000Z');
  });

  it('createReminder validation: exactly one of taskId/blockId required', async () => {
    const taskId = insertTask(); const blockId = insertBlock();
    const both = await gql(`mutation { createReminder(input: { taskId: "${taskId}", blockId: "${blockId}", fireAt: "${FUTURE}" }) { success } }`);
    expect(both.body.errors?.[0]?.message).toMatch(/exactly one/i);
    const neither = await gql(`mutation { createReminder(input: { fireAt: "${FUTURE}" }) { success } }`);
    expect(neither.body.errors?.[0]?.message).toMatch(/exactly one/i);
    const noTime = await gql(`mutation { createReminder(input: { taskId: "${taskId}" }) { success } }`);
    expect(noTime.body.errors?.[0]?.message).toMatch(/fireAt.*date.*time|date\+time/i);
  });

  it('cancelReminder soft-cancels: excluded from the live list, visible via REST GET reflecting cancelled', async () => {
    const taskId = insertTask();
    const id = (await gql(`mutation { createReminder(input: { taskId: "${taskId}", fireAt: "${FUTURE}" }) { reminder { id } } }`)).body.data.createReminder.reminder.id;

    const c = await gql(`mutation { cancelReminder(input: { id: "${id}" }) { success reminder { id status } } }`);
    expect(c.body.errors).toBeUndefined();
    expect(c.body.data.cancelReminder).toEqual({ success: true, reminder: { id, status: 'cancelled' } });

    const q = await gql('{ reminders { id } }');
    expect(q.body.data.reminders.find((x: any) => x.id === id)).toBeUndefined();

    const rest = await api(srv.url, '/api/reminders');
    expect((rest.body.reminders as { id: string }[]).find((x) => x.id === id)).toBeUndefined();

    const row = sqlite.prepare(`SELECT status FROM reminders WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe('cancelled'); // row survives — soft cancel, not a real delete
  });

  it('cancelReminder on an unknown id is not-found', async () => {
    const r = await gql(`mutation { cancelReminder(input: { id: "${newId()}" }) { success } }`);
    expect(r.body.errors?.[0]?.message).toMatch(/not found/i);
  });

  it('snoozeReminder re-arms a fired reminder forward', async () => {
    const taskId = insertTask();
    const id = (await gql(`mutation { createReminder(input: { taskId: "${taskId}", fireAt: "${PAST}" }) { reminder { id } } }`)).body.data.createReminder.reminder.id;
    sqlite.prepare(`UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?`).run(PAST, id);

    const s = await gql(`mutation { snoozeReminder(input: { id: "${id}", minutes: 10 }) { success reminder { id status firedAt } } }`);
    expect(s.body.errors).toBeUndefined();
    expect(s.body.data.snoozeReminder.success).toBe(true);
    expect(s.body.data.snoozeReminder.reminder.status).toBe('pending');
    expect(s.body.data.snoozeReminder.reminder.firedAt).toBeNull();

    const row = sqlite.prepare(`SELECT fire_at FROM reminders WHERE id = ?`).get(id) as { fire_at: string };
    expect(Date.parse(row.fire_at)).toBeGreaterThan(Date.now());
  });

  it('snoozeReminder validation: minutes must be a positive number', async () => {
    const taskId = insertTask();
    const id = (await gql(`mutation { createReminder(input: { taskId: "${taskId}", fireAt: "${FUTURE}" }) { reminder { id } } }`)).body.data.createReminder.reminder.id;
    const r = await gql(`mutation { snoozeReminder(input: { id: "${id}", minutes: 0 }) { success } }`);
    expect(r.body.errors?.[0]?.message).toMatch(/positive/i);
  });

  it('snoozeReminder on an unknown id is not-found', async () => {
    const r = await gql(`mutation { snoozeReminder(input: { id: "${newId()}", minutes: 5 }) { success } }`);
    expect(r.body.errors?.[0]?.message).toMatch(/not found/i);
  });
});

describe('W10 — PushSubscriptionType', () => {
  it('pushVapidKey returns a string (empty when unconfigured)', async () => {
    const r = await gql('{ pushVapidKey }');
    expect(r.body.errors).toBeUndefined();
    expect(typeof r.body.data.pushVapidKey).toBe('string');
  });

  it('subscribePush upserts by endpoint; visible via pushSubscriptions + REST has no leak of secrets', async () => {
    const endpoint = 'https://push.example/gql1';
    const m = await gql(`mutation { subscribePush(input: { endpoint: "${endpoint}", p256dh: "key1", auth: "a" }) { success } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.subscribePush).toEqual({ success: true });

    const q = await gql('{ pushSubscriptions { id endpoint userAgent createdAt } }');
    expect(q.body.errors).toBeUndefined();
    const sub = q.body.data.pushSubscriptions.find((s: any) => s.endpoint === endpoint);
    expect(sub).toBeTruthy();
    expect(sub.createdAt).toBeTruthy();
    expect(Object.keys(sub).sort()).toEqual(['createdAt', 'endpoint', 'id', 'userAgent']); // no p256dh/auth

    // Upsert: re-subscribing the same endpoint updates the one row, doesn't duplicate.
    await gql(`mutation { subscribePush(input: { endpoint: "${endpoint}", p256dh: "key2", auth: "a" }) { success } }`);
    const rows = sqlite.prepare(`SELECT p256dh FROM push_subscriptions WHERE endpoint = ?`).all(endpoint) as { p256dh: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('key2');
  });

  it('subscribePush validation: endpoint + keys required', async () => {
    const r = await gql(`mutation { subscribePush(input: { endpoint: "", p256dh: "", auth: "" }) { success } }`);
    expect(r.body.errors?.[0]?.message).toMatch(/subscription with endpoint/i);
  });

  it('unsubscribePush removes by endpoint (input.id), visible via REST GET', async () => {
    const endpoint = 'https://push.example/gql-bye';
    await gql(`mutation { subscribePush(input: { endpoint: "${endpoint}", p256dh: "p", auth: "a" }) { success } }`);
    const u = await gql(`mutation { unsubscribePush(input: { id: "${endpoint}" }) { success } }`);
    expect(u.body.errors).toBeUndefined();
    expect(u.body.data.unsubscribePush).toEqual({ success: true });
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM push_subscriptions WHERE endpoint = ?`).get(endpoint) as { c: number }).c).toBe(0);

    const q = await gql('{ pushSubscriptions { endpoint } }');
    expect(q.body.data.pushSubscriptions.some((s: any) => s.endpoint === endpoint)).toBe(false);
  });

  it('a subscription created via REST is visible via the GraphQL query (shared service)', async () => {
    const endpoint = 'https://push.example/rest-then-gql';
    await api(srv.url, '/api/push/subscribe', { method: 'POST', json: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } } });
    const q = await gql('{ pushSubscriptions { endpoint } }');
    expect(q.body.data.pushSubscriptions.some((s: any) => s.endpoint === endpoint)).toBe(true);
  });
});

describe('W10 — owner scoping', () => {
  it('another owner cannot cancel/snooze this owner\'s reminder (not-found, not a leak)', async () => {
    createOwner(OTHER);
    const taskId = insertTask(OWNER);
    const id = (await gql(`mutation { createReminder(input: { taskId: "${taskId}", fireAt: "${FUTURE}" }) { reminder { id } } }`)).body.data.createReminder.reminder.id;

    const cancel = await gql(`mutation { cancelReminder(input: { id: "${id}" }) { success } }`, { 'x-test-owner': OTHER });
    expect(cancel.body.errors?.[0]?.message).toMatch(/not found/i);
    const snooze = await gql(`mutation { snoozeReminder(input: { id: "${id}", minutes: 5 }) { success } }`, { 'x-test-owner': OTHER });
    expect(snooze.body.errors?.[0]?.message).toMatch(/not found/i);

    // Owner A's reminder survives, untouched.
    const row = sqlite.prepare(`SELECT status FROM reminders WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe('pending');

    // B's reminders list doesn't include A's reminder.
    const listB = await gql('{ reminders { id } }', { 'x-test-owner': OTHER });
    expect(listB.body.data.reminders.some((r: any) => r.id === id)).toBe(false);
  });

  it('another owner does not see this owner\'s push subscriptions', async () => {
    createOwner(OTHER);
    await gql('mutation { subscribePush(input: { endpoint: "https://push.example/owner-a", p256dh: "p", auth: "a" }) { success } }');
    const listB = await gql('{ pushSubscriptions { endpoint } }', { 'x-test-owner': OTHER });
    expect(listB.body.data.pushSubscriptions.some((s: any) => s.endpoint === 'https://push.example/owner-a')).toBe(false);
  });

  it('a reminder linked to another owner\'s task/block cannot be created cross-owner (task/block not_found is not enforced at create — but ownership of the reminder itself is)', async () => {
    // createReminder does not currently validate that taskId/blockId belongs to the
    // caller (mirrors the REST route, which also doesn't) — but the created reminder is
    // always owned by the CALLER, so a malicious taskId from another owner just produces
    // a reminder whose task field resolver returns null (cross-owner getTask → undefined).
    createOwner(OTHER);
    const otherTaskId = insertTask(OTHER);
    const m = await gql(`mutation { createReminder(input: { taskId: "${otherTaskId}", fireAt: "${FUTURE}" }) { reminder { id task { id } } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.createReminder.reminder.task).toBeNull(); // cross-owner task never resolves
  });
});
