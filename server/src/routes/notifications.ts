import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { currentOwnerId } from '../lib/context.js';
import { config } from '../lib/config.js';
import { broadcast } from './sse.js';
import { zonedWallTimeToUTC, serverTimezone } from '../lib/tz.js';

/** The owner's IANA timezone (falls back to the server zone). */
function ownerTz(ownerId: string): string {
  const row = sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(ownerId) as
    | { timezone: string | null }
    | undefined;
  return row?.timezone || serverTimezone();
}

export function notificationsRouter() {
  const router = new Router();

  // ── Web Push subscriptions ────────────────────────────────────────────────

  // GET /api/push/vapid-key — the public key the browser subscribes with. Empty
  // when VAPID isn't configured (client hides the toggle → in-app SSE only).
  router.get('/api/push/vapid-key', async (ctx) => {
    ctx.body = { key: config.vapidPublicKey };
  });

  // POST /api/push/subscribe — { subscription: PushSubscriptionJSON }. Upsert by
  // endpoint (one row per browser endpoint), re-pointing keys/owner on conflict.
  router.post('/api/push/subscribe', async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    };
    const sub = body.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      ctx.status = 400; ctx.body = { error: 'a subscription with endpoint + keys is required' }; return;
    }
    sqlite
      .prepare(
        `INSERT INTO push_subscriptions (id, owner_id, endpoint, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           owner_id = excluded.owner_id, p256dh = excluded.p256dh,
           auth = excluded.auth, user_agent = excluded.user_agent`,
      )
      .run(newId(), currentOwnerId(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, ctx.get('user-agent') || null);
    ctx.status = 201; ctx.body = { ok: true };
  });

  // DELETE /api/push/subscribe — { endpoint }. Remove on unsubscribe.
  router.delete('/api/push/subscribe', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { endpoint?: string };
    if (!body.endpoint) { ctx.status = 400; ctx.body = { error: 'endpoint is required' }; return; }
    sqlite.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND owner_id = ?`).run(body.endpoint, currentOwnerId());
    ctx.body = { ok: true };
  });

  // ── Reminders ─────────────────────────────────────────────────────────────

  // GET /api/reminders — the owner's live reminders (not cancelled), soonest first.
  router.get('/api/reminders', async (ctx) => {
    ctx.body = {
      reminders: sqlite
        .prepare(
          `SELECT id, task_id, block_id, fire_at, status, fired_at
             FROM reminders WHERE owner_id = ? AND status <> 'cancelled' ORDER BY fire_at`,
        )
        .all(currentOwnerId()),
    };
  });

  // POST /api/reminders — { taskId|blockId, fireAt? | (date+time) }. Exactly one
  // target. fire_at is stored UTC ISO: pass `fireAt` directly, or `date`+`time`
  // resolved tz-correctly via the owner's timezone (never the naive `${date}T${time}Z`).
  router.post('/api/reminders', async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      taskId?: string; blockId?: string; fireAt?: string; date?: string; time?: string;
    };
    const hasTask = !!body.taskId, hasBlock = !!body.blockId;
    if (hasTask === hasBlock) { ctx.status = 422; ctx.body = { error: 'exactly one of taskId or blockId is required' }; return; }

    let fireAt = body.fireAt;
    if (!fireAt && body.date && body.time) fireAt = zonedWallTimeToUTC(body.date, body.time, ownerTz(currentOwnerId()));
    if (!fireAt) { ctx.status = 422; ctx.body = { error: 'fireAt (UTC ISO) or date+time is required' }; return; }

    const reminder = sqlite
      .prepare(
        `INSERT INTO reminders (id, owner_id, task_id, block_id, fire_at) VALUES (?, ?, ?, ?, ?)
         RETURNING id, task_id, block_id, fire_at, status`,
      )
      .get(newId(), currentOwnerId(), body.taskId ?? null, body.blockId ?? null, fireAt) as { id: string };
    broadcast(currentOwnerId(), 'reminder:created', { id: reminder.id });
    ctx.status = 201; ctx.body = { reminder };
  });

  // DELETE /api/reminders/:id — soft-cancel (keeps the row, off the dispatcher).
  router.delete('/api/reminders/:id', async (ctx) => {
    const row = sqlite
      .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND owner_id = ? RETURNING id`)
      .get(ctx.params.id, currentOwnerId());
    if (!row) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'reminder:cancelled', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  // POST /api/reminders/:id/snooze — { minutes }. Re-arm the SAME row forward:
  // status→pending + fire_at advanced cancels the original firing (already 'fired')
  // and schedules exactly one new one — no double-fire.
  router.post('/api/reminders/:id/snooze', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { minutes?: number };
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) { ctx.status = 422; ctx.body = { error: 'minutes must be a positive number' }; return; }
    const fireAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const reminder = sqlite
      .prepare(
        `UPDATE reminders SET fire_at = ?, status = 'pending', fired_at = NULL
           WHERE id = ? AND owner_id = ? RETURNING id, task_id, block_id, fire_at, status`,
      )
      .get(fireAt, ctx.params.id, currentOwnerId());
    if (!reminder) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'reminder:snoozed', { id: ctx.params.id, fireAt });
    ctx.body = { reminder };
  });

  return router;
}
