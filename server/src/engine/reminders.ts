import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { sendPush, type PushSub } from '../lib/push.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { serverTimezone } from '../lib/tz.js';
import { instanceStartUTC } from './recurrence.js';

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

/** An owner's push subscriptions, each shaped for `web-push`. Exported so other
 *  notifiers (B4 replan nudge) reuse the same query + shape. */
export function subsFor(ownerId: string): { id: string; sub: PushSub }[] {
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
  // A task-targeted reminder must NOT fire once its task is in a terminal state
  // (done/cancelled/skipped/missed). Soft-delete only flips status (the row stays, so
  // the FK CASCADE never runs), and completing/skipping never deletes the reminder —
  // so this guard is the authoritative chokepoint covering every status-change path.
  // Such rows stay 'pending' (never fired) until the task is hard-deleted or re-derived.
  const due = sqlite
    .prepare(
      `UPDATE reminders SET status = 'fired', fired_at = ?
         WHERE status = 'pending' AND fire_at <= ?
           AND (task_id IS NULL OR task_id IN (
                 SELECT id FROM tasks WHERE status NOT IN ('done','completed','cancelled','skipped','missed')))
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

/**
 * Phase H (b) — auto-derive a task's reminders from the owner's Reminder Defaults.
 * Called whenever a task is created/updated. Idempotent: it replaces only its OWN
 * (`source='auto'`) rows, never the manual ones.
 *
 * Anchor = the task's scheduled start (`scheduled_for`/`occurrence_date` + `task_time`),
 * else `due_at`; offsets = the owner's `pattern_prefs.reminder_offsets`. Settings writes the
 * SAME offsets to every pattern tag (one shared "Reminder Defaults" config), so we union them
 * rather than resolving the task's specific tags. Already-due fire times are skipped (no
 * backfill flood). Returns the number of reminders created.
 */
export function syncTaskReminders(ownerId: string, taskId: string): number {
  sqlite.prepare(`DELETE FROM reminders WHERE task_id = ? AND source = 'auto'`).run(taskId);

  const task = sqlite
    .prepare(`SELECT due_at, scheduled_for, occurrence_date, task_time, status FROM tasks WHERE id = ? AND owner_id = ?`)
    .get(taskId, ownerId) as
    | { due_at: string | null; scheduled_for: string | null; occurrence_date: string | null; task_time: string | null; status: string }
    | undefined;
  if (!task) return 0;
  // A done/cancelled/skipped/missed task gets no reminders — clearing the auto rows
  // above is the whole job (completing a task via PATCH flows through here).
  if (['done', 'completed', 'cancelled', 'skipped', 'missed'].includes(task.status)) return 0;

  // Anchor on the task's SCHEDULED START — `scheduled_for`/`occurrence_date` + `task_time`,
  // which is exactly what the offsets ("minutes before start") are defined against and what
  // recurring-instance due_at is computed from — else fall back to `due_at`. An untimed task
  // with no due_at has no instant to anchor on, so it gets no reminders.
  const day = task.scheduled_for ?? task.occurrence_date;
  let anchorMs: number;
  if (day && task.task_time) {
    const tz =
      (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(ownerId) as
        | { timezone: string | null }
        | undefined)?.timezone || serverTimezone();
    anchorMs = Date.parse(instanceStartUTC(day, task.task_time, tz));
  } else if (task.due_at) {
    anchorMs = Date.parse(task.due_at);
  } else {
    return 0;
  }
  if (!Number.isFinite(anchorMs)) return 0;

  const rows = sqlite.prepare(`SELECT reminder_offsets FROM tag_prefs WHERE owner_id = ? AND kind = 'pattern'`).all(ownerId) as
    { reminder_offsets: string }[];
  const offsets = new Set<number>();
  for (const r of rows) {
    try {
      for (const o of JSON.parse(r.reminder_offsets) as number[]) if (Number.isFinite(o) && o >= 0) offsets.add(o);
    } catch {
      /* malformed JSON → skip this row */
    }
  }
  if (offsets.size === 0) return 0;

  const now = Date.now();
  const ins = sqlite.prepare(
    `INSERT INTO reminders (id, owner_id, task_id, fire_at, source) VALUES (?, ?, ?, ?, 'auto')`,
  );
  let n = 0;
  for (const off of offsets) {
    const fireMs = anchorMs - off * 60_000;
    if (fireMs <= now) continue; // don't create an already-due reminder (no backfill)
    ins.run(newId(), ownerId, taskId, new Date(fireMs).toISOString());
    n++;
  }
  return n;
}
