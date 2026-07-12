import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';
import { zonedWallTimeToUTC, serverTimezone } from '../lib/tz.js';

/**
 * Phase W · W10 — services/notifications.ts, extracted from routes/notifications.ts
 * (which had no service layer at all — every write was inline in the router). REST +
 * GraphQL share this one path (Decision 3): validation + write + audit live here; the
 * transport layer (route/resolver) still fires the same SSE `broadcast()` calls itself,
 * matching the split established by services/blocks.ts and services/tasks.ts.
 */

export interface Reminder {
  id: string;
  task_id: string | null;
  block_id: string | null;
  fire_at: string;
  status: string;
  fired_at: string | null;
  source: string;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
}

/** The owner's IANA timezone (falls back to the server zone). */
export function ownerTz(ownerId: string): string {
  const row = sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(ownerId) as
    | { timezone: string | null }
    | undefined;
  return row?.timezone || serverTimezone();
}

// ── Web Push subscriptions ──────────────────────────────────────────────────
// The VAPID public key itself isn't a notifications-service concern — both the REST
// route and the GraphQL resolver read `config.vapidPublicKey` directly (the one source
// of truth already established in lib/config.ts).

export type SubscribePushInput = { endpoint?: string; p256dh?: string; auth?: string; userAgent?: string | null };
export type SubscribePushResult = { ok: true } | { ok: false; error: 'missing_fields' };

/** Upsert by endpoint (one row per browser endpoint), re-pointing keys/owner on conflict. */
export function subscribePushChecked(ownerId: string, input: SubscribePushInput): SubscribePushResult {
  if (!input.endpoint || !input.p256dh || !input.auth) return { ok: false, error: 'missing_fields' };
  sqlite
    .prepare(
      `INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         owner_id = excluded.owner_id, p256dh = excluded.p256dh,
         auth = excluded.auth, user_agent = excluded.user_agent`,
    )
    .run(newId(), ownerId, input.endpoint, input.p256dh, input.auth, input.userAgent ?? null);
  writeAudit({ ownerId, actor: 'owner', action: 'subscribe', entity: 'push:subscribe' });
  return { ok: true };
}

export type UnsubscribePushResult = { ok: true } | { ok: false; error: 'missing_endpoint' };

/** Remove a subscription by endpoint, owner-scoped. */
export function unsubscribePushChecked(ownerId: string, endpoint: string | undefined): UnsubscribePushResult {
  if (!endpoint) return { ok: false, error: 'missing_endpoint' };
  sqlite.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND owner_id = ?`).run(endpoint, ownerId);
  writeAudit({ ownerId, actor: 'owner', action: 'unsubscribe', entity: 'push:unsubscribe' });
  return { ok: true };
}

/** The owner's push subscriptions (no REST GET for this today — new for GraphQL, W10). */
export function listPushSubscriptions(ownerId: string): PushSubscriptionRow[] {
  return sqlite
    .prepare(
      `SELECT id, endpoint, user_agent, created_at FROM push_subscriptions WHERE owner_id = ? ORDER BY created_at`,
    )
    .all(ownerId) as PushSubscriptionRow[];
}

// ── Reminders ────────────────────────────────────────────────────────────────

/** The owner's live (non-cancelled) reminders, soonest fire_at first. */
export function listReminders(ownerId: string): Reminder[] {
  return sqlite
    .prepare(
      `SELECT id, task_id, block_id, fire_at, status, fired_at, source
         FROM reminders WHERE owner_id = ? AND status <> 'cancelled' ORDER BY fire_at`,
    )
    .all(ownerId) as Reminder[];
}

/** A single reminder, owner-scoped (used by field resolvers / cross-owner checks). */
export function getReminder(ownerId: string, id: string): Reminder | undefined {
  return sqlite
    .prepare(
      `SELECT id, task_id, block_id, fire_at, status, fired_at, source FROM reminders WHERE id = ? AND owner_id = ?`,
    )
    .get(id, ownerId) as Reminder | undefined;
}

export type CreateReminderInput = { taskId?: string | null; blockId?: string | null; fireAt?: string | null; date?: string | null; time?: string | null };
export type CreateReminderResult = { ok: true; reminder: Reminder } | { ok: false; error: 'target' | 'fire_at_required' };

/**
 * Create a reminder. Exactly one of taskId/blockId is required (422-equivalent
 * otherwise). fire_at is stored UTC ISO: pass `fireAt` directly, or `date`+`time`
 * resolved tz-correctly via the owner's timezone (never the naive `${date}T${time}Z`).
 */
export function createReminderChecked(ownerId: string, input: CreateReminderInput): CreateReminderResult {
  const hasTask = !!input.taskId, hasBlock = !!input.blockId;
  if (hasTask === hasBlock) return { ok: false, error: 'target' };

  // The target must be the caller's own. Without this a caller could point a reminder at
  // another owner's task/block id; the dispatcher would then render that row's title into
  // this owner's notification. Treated as an invalid target (same 'target' error, so a
  // foreign id is indistinguishable from a missing one — no cross-owner probe).
  if (hasTask && !sqlite.prepare(`SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?`).get(input.taskId, ownerId)) {
    return { ok: false, error: 'target' };
  }
  if (hasBlock && !sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(input.blockId, ownerId)) {
    return { ok: false, error: 'target' };
  }

  let fireAt = input.fireAt ?? undefined;
  if (!fireAt && input.date && input.time) fireAt = zonedWallTimeToUTC(input.date, input.time, ownerTz(ownerId));
  if (!fireAt) return { ok: false, error: 'fire_at_required' };

  const reminder = sqlite
    .prepare(
      `INSERT INTO reminders (id, owner_id, task_id, block_id, fire_at) VALUES (?, ?, ?, ?, ?)
       RETURNING id, task_id, block_id, fire_at, status, fired_at, source`,
    )
    .get(newId(), ownerId, input.taskId ?? null, input.blockId ?? null, fireAt) as Reminder;
  writeAudit({ ownerId, actor: 'owner', action: 'create', entity: `reminder:${reminder.id}` });
  return { ok: true, reminder };
}

export type CancelReminderResult = { ok: true; reminder: Reminder } | { ok: false; error: 'not_found' };

/** Soft-cancel: status='cancelled', row stays (kept off the dispatcher, still queryable). */
export function cancelReminderChecked(ownerId: string, id: string): CancelReminderResult {
  const row = sqlite
    .prepare(
      `UPDATE reminders SET status = 'cancelled' WHERE id = ? AND owner_id = ?
       RETURNING id, task_id, block_id, fire_at, status, fired_at, source`,
    )
    .get(id, ownerId) as Reminder | undefined;
  if (!row) return { ok: false, error: 'not_found' };
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `reminder:${id}` });
  return { ok: true, reminder: row };
}

export type SnoozeReminderResult = { ok: true; reminder: Reminder } | { ok: false; error: 'not_found' | 'bad_minutes' };

/**
 * Re-arm the SAME row forward: status→pending + fire_at advanced cancels the original
 * firing (already 'fired') and schedules exactly one new one — no double-fire.
 */
export function snoozeReminderChecked(ownerId: string, id: string, minutesRaw: unknown): SnoozeReminderResult {
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'bad_minutes' };
  const fireAt = new Date(Date.now() + minutes * 60_000).toISOString();
  const reminder = sqlite
    .prepare(
      `UPDATE reminders SET fire_at = ?, status = 'pending', fired_at = NULL
         WHERE id = ? AND owner_id = ?
       RETURNING id, task_id, block_id, fire_at, status, fired_at, source`,
    )
    .get(fireAt, id, ownerId) as Reminder | undefined;
  if (!reminder) return { ok: false, error: 'not_found' };
  writeAudit({ ownerId, actor: 'owner', action: 'snooze', entity: `reminder:${id}` });
  return { ok: true, reminder };
}
