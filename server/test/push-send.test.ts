import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

/**
 * The Web Push send path, with only the network cut off.
 *
 * `web-push` is mocked at the package boundary, so everything the product does with a push
 * service's answer is the real code: lib/push.ts sendPush (the one function that calls
 * sendNotification) and, one level up, the reminder dispatcher in engine/reminders.ts that
 * acts on what sendPush reports. The contract as the code stands:
 *
 *   - 404 and 410 mean the subscription is dead. sendPush answers 'gone' (it never touches
 *     the database); the dispatcher deletes the row, and only that row.
 *   - Any other rejection, a 4xx or 5xx or a network error with no status at all, is 'fail':
 *     one warning carrying the status code, and the row stays, because the next send may work.
 *   - Without BOTH VAPID keys nothing is sent: 'fail', and web-push is never called.
 *
 * lib/push.ts latches "configured" in a module variable the first time it finds both keys,
 * so the sendPush-level tests load a fresh push.ts (with the config and logger it reads) per
 * test via vi.resetModules, none of which touches the database. The dispatcher tests use the
 * statically imported modules instead: engine/reminders.ts and the store under it must keep
 * their original instances, and every one of those tests has the keys set anyway.
 */

const webpush = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'mock-vapid-public', privateKey: 'mock-vapid-private' })),
}));
vi.mock('web-push', () => ({ default: webpush }));

import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { fireDueReminders } from '../src/engine/reminders.js';
import { resetDb } from './helpers.js';

const PUB = 'test-vapid-public-key';
const PRIV = 'test-vapid-private-key';
const SUB = { endpoint: 'https://push.example/send/abc123', keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } };
const PAYLOAD = { title: 'Task reminder', body: 'Pay rent', tag: 'reminder:1', url: '/' };
const DELIVERED = { statusCode: 201, body: '', headers: {} };

// The real error class, so the status code reaches sendPush the way web-push puts it there:
// the mock replaces sendNotification, not the error a non-2xx answer makes it reject with.
const actualWebPush = await vi.importActual<any>('web-push');
const WebPushError = (actualWebPush.default ?? actualWebPush).WebPushError;

/** What sendNotification rejects with: a WebPushError for an answer, a bare error for no answer. */
function pushFailure(status: number | undefined, endpoint: string = SUB.endpoint): Error {
  return status === undefined
    ? Object.assign(new Error('getaddrinfo ENOTFOUND push.example'), { code: 'ENOTFOUND' })
    : new WebPushError('Received unexpected response code', status, {}, '', endpoint);
}

/** Every rejection sendPush does NOT read as a dead subscription. */
const OTHER_FAILURES: [label: string, status: number | undefined][] = [
  ['a 400', 400],
  ['a 401', 401],
  ['a 403', 403],
  ['a 429', 429],
  ['a 500', 500],
  ['a 503', 503],
  ['a network error with no status code', undefined],
];

beforeEach(() => {
  webpush.setVapidDetails.mockReset();
  webpush.sendNotification.mockReset();
});

/** A fresh push.ts (its "configured" latch unset) plus the config and logger it reads. */
async function freshPush() {
  vi.resetModules();
  const { config: cfg } = await import('../src/lib/config.js');
  const { logger } = await import('../src/lib/logger.js');
  const { sendPush, pushEnabled } = await import('../src/lib/push.js');
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  return { cfg, sendPush, pushEnabled, warn };
}

describe('sendPush: the push service answers', () => {
  it('delivers: sets VAPID up once, then hands web-push the subscription and the JSON payload', async () => {
    const { cfg, sendPush, pushEnabled } = await freshPush();
    cfg.vapidPublicKey = PUB;
    cfg.vapidPrivateKey = PRIV;
    webpush.sendNotification.mockResolvedValue(DELIVERED);

    expect(pushEnabled()).toBe(true);
    expect(await sendPush(SUB, PAYLOAD)).toBe('ok');
    expect(await sendPush(SUB, PAYLOAD)).toBe('ok');

    expect(webpush.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(cfg.vapidSubject, PUB, PRIV);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(webpush.sendNotification).toHaveBeenCalledWith(SUB, JSON.stringify(PAYLOAD));
  });

  it.each([404, 410])('reports a %i as gone, so the caller can drop the subscription', async (status) => {
    const { cfg, sendPush } = await freshPush();
    cfg.vapidPublicKey = PUB;
    cfg.vapidPrivateKey = PRIV;
    webpush.sendNotification.mockRejectedValue(pushFailure(status));

    expect(await sendPush(SUB, PAYLOAD)).toBe('gone');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1); // no retry
  });

  it.each(OTHER_FAILURES)('reports %s as a failure, with the status code as the only thing logged', async (_label, status) => {
    const { cfg, sendPush, warn } = await freshPush();
    cfg.vapidPublicKey = PUB;
    cfg.vapidPrivateKey = PRIV;
    webpush.sendNotification.mockRejectedValue(pushFailure(status));

    expect(await sendPush(SUB, PAYLOAD)).toBe('fail');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toEqual({ code: status });
  });
});

describe('sendPush: no VAPID keys', () => {
  it.each([
    ['neither key', '', ''],
    ['only the public key', PUB, ''],
    ['only the private key', '', PRIV],
  ])('sends nothing with %s set', async (_label, publicKey, privateKey) => {
    const { cfg, sendPush, pushEnabled } = await freshPush();
    cfg.vapidPublicKey = publicKey;
    cfg.vapidPrivateKey = privateKey;

    expect(pushEnabled()).toBe(false);
    expect(await sendPush(SUB, PAYLOAD)).toBe('fail');
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

// ── One level up: what the reminder dispatcher does with the answer ──────────────────────────

function insertSub(endpoint: string): void {
  sqlite
    .prepare(`INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth) VALUES (?, ?, ?, 'p', 'a')`)
    .run(newId(), SYSTEM_OWNER, endpoint);
}
const storedEndpoints = (): string[] =>
  (sqlite.prepare(`SELECT endpoint FROM push_subscriptions ORDER BY endpoint`).all() as { endpoint: string }[]).map(
    (r) => r.endpoint,
  );

function insertDueReminder(taskTitle: string): string {
  const taskId = newId();
  sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (?, ?, ?, 'open')`).run(taskId, taskTitle, SYSTEM_OWNER);
  const id = newId();
  sqlite
    .prepare(`INSERT INTO reminders (id, owner_id, task_id, fire_at) VALUES (?, ?, ?, '2020-01-01T00:00:00.000Z')`)
    .run(id, SYSTEM_OWNER, taskId);
  return id;
}
const reminderStatus = (id: string): string =>
  (sqlite.prepare(`SELECT status FROM reminders WHERE id = ?`).get(id) as { status: string }).status;

/** The endpoints web-push was asked to send to, in a stable order. */
const attemptedEndpoints = (): string[] =>
  webpush.sendNotification.mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint).sort();

/** The push service answers every endpoint listed with a rejection (undefined = no answer at all), the rest with a delivery. */
function pushServiceRejects(rejections: Record<string, number | undefined>): void {
  webpush.sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
    if (sub.endpoint in rejections) throw pushFailure(rejections[sub.endpoint], sub.endpoint);
    return DELIVERED;
  });
}

describe('fireDueReminders over the real send path', () => {
  const SAVED = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  const A = 'https://push.example/send/a'; // the subscription the push service is asked about
  const B = 'https://push.example/send/b'; // a second subscription of the same owner

  beforeEach(() => {
    resetDb();
    config.vapidPublicKey = PUB;
    config.vapidPrivateKey = PRIV;
    webpush.sendNotification.mockResolvedValue(DELIVERED);
  });

  afterEach(() => {
    config.vapidPublicKey = SAVED.publicKey;
    config.vapidPrivateKey = SAVED.privateKey;
  });

  // The suite shares one database across files; leave no subscriptions or reminders behind.
  afterAll(() => {
    resetDb();
  });

  it('sends the due reminder to each of the owner\'s subscriptions and keeps them all when the push service accepts it', async () => {
    insertSub(A);
    insertSub(B);
    const reminder = insertDueReminder('Pay rent');

    expect(await fireDueReminders()).toBe(1);

    expect(attemptedEndpoints()).toEqual([A, B]);
    expect(JSON.parse(webpush.sendNotification.mock.calls[0]![1] as string)).toMatchObject({
      title: 'Task reminder',
      body: 'Pay rent',
      url: '/',
    });
    expect(storedEndpoints()).toEqual([A, B]);
    expect(reminderStatus(reminder)).toBe('fired');
  });

  it.each([404, 410])('removes the subscription the push service answers %i for, and only that one', async (status) => {
    insertSub(A);
    insertSub(B);
    const reminder = insertDueReminder('Pay rent');
    pushServiceRejects({ [A]: status });

    expect(await fireDueReminders()).toBe(1);

    expect(storedEndpoints()).toEqual([B]);
    expect(attemptedEndpoints()).toEqual([A, B]); // the dead one did not stop the other
    expect(reminderStatus(reminder)).toBe('fired');
  });

  it.each(OTHER_FAILURES)('keeps the subscription after %s, and still sends to the owner\'s other one', async (_label, status) => {
    insertSub(A);
    insertSub(B);
    const reminder = insertDueReminder('Pay rent');
    pushServiceRejects({ [A]: status });

    expect(await fireDueReminders()).toBe(1);

    expect(storedEndpoints()).toEqual([A, B]);
    expect(attemptedEndpoints()).toEqual([A, B]);
    expect(reminderStatus(reminder)).toBe('fired');
  });
});
