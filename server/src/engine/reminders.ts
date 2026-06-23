import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { sendPush, type PushSub } from '../lib/push.js';
import { logger } from '../lib/logger.js';

/**
 * Reminder dispatch (Phase H). The 1-minute `fire_reminders` cron calls
 * `fireDueReminders()`. Exactly-once rides on an atomic claim: the `UPDATE … RETURNING`
 * flips only rows still `pending` with `fire_at <= now` to `fired`, so the next tick
 * re-selects nothing. better-sqlite3 is synchronous + single-writer, so no row is
 * claimed twice — never a double-fire.
 *
 * Delivery emits the in-app SSE event FIRST, then attempts Web Push. Because SSE fires
 * unconditionally, push failure / push-denied / no-subscription all fall back to in-app
 * automatically. Dead subscriptions (404/410 → 'gone') are pruned.
 */

interface DueReminder {
  id: string;
  owner_id: string;
  task_id: string | null;
  block_id: string | null;
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** An owner's push subscriptions, each shaped for `web-push`. */
function subsFor(ownerId: string): { id: string; sub: PushSub }[] {
  const rows = sqlite
    .prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id = ?`)
    .all(ownerId) as SubRow[];
  return rows.map((r) => ({ id: r.id, sub: { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } } }));
}

/** Minimal, privacy-light notification content (full context fetched on click). */
function contentFor(r: DueReminder): { title: string; body: string; url: string } {
  if (r.task_id) {
    const t = sqlite.prepare(`SELECT title FROM tasks WHERE id = ?`).get(r.task_id) as { title: string } | undefined;
    return { title: 'Task reminder', body: t?.title ?? 'A task is due', url: '/' };
  }
  const b = sqlite.prepare(`SELECT title FROM time_blocks WHERE id = ?`).get(r.block_id!) as { title: string } | undefined;
  return { title: 'Upcoming block', body: b?.title ?? 'A block is starting', url: '/' };
}

async function deliver(r: DueReminder): Promise<void> {
  broadcast(r.owner_id, 'reminder:fire', { id: r.id, taskId: r.task_id, blockId: r.block_id });
  const c = contentFor(r);
  for (const s of subsFor(r.owner_id)) {
    const res = await sendPush(s.sub, { title: c.title, body: c.body, tag: `reminder:${r.id}`, url: c.url });
    if (res === 'gone') sqlite.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(s.id);
  }
}

/**
 * Claim and fire every due reminder exactly once. Returns the count fired.
 * `nowISO` is injectable for deterministic tests.
 */
export async function fireDueReminders(nowISO: string = new Date().toISOString()): Promise<number> {
  const due = sqlite
    .prepare(
      `UPDATE reminders SET status = 'fired', fired_at = ?
         WHERE status = 'pending' AND fire_at <= ?
       RETURNING id, owner_id, task_id, block_id`,
    )
    .all(nowISO, nowISO) as DueReminder[];
  for (const r of due) {
    try {
      await deliver(r);
    } catch (e) {
      logger.error('reminder deliver failed', { id: r.id, err: (e as Error).message });
    }
  }
  return due.length;
}
