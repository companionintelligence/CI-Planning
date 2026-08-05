import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { config } from '../lib/config.js';
import { broadcast } from './sse.js';
import {
  subscribePushChecked, unsubscribePushChecked,
  listReminders, createReminderChecked, cancelReminderChecked, snoozeReminderChecked,
} from '../services/notifications.js';

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
    const res = await subscribePushChecked(currentOwnerId(), {
      endpoint: sub?.endpoint,
      p256dh: sub?.keys?.p256dh,
      auth: sub?.keys?.auth,
      userAgent: ctx.get('user-agent') || null,
    });
    if (!res.ok) { ctx.status = 400; ctx.body = { error: 'a subscription with endpoint + keys is required' }; return; }
    ctx.status = 201; ctx.body = { ok: true };
  });

  // DELETE /api/push/subscribe — { endpoint }. Remove on unsubscribe.
  router.delete('/api/push/subscribe', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { endpoint?: string };
    const res = await unsubscribePushChecked(currentOwnerId(), body.endpoint);
    if (!res.ok) { ctx.status = 400; ctx.body = { error: 'endpoint is required' }; return; }
    ctx.body = { ok: true };
  });

  // ── Reminders ─────────────────────────────────────────────────────────────

  // GET /api/reminders — the owner's live reminders (not cancelled), soonest first.
  router.get('/api/reminders', async (ctx) => {
    ctx.body = {
      reminders: (await listReminders(currentOwnerId())).map((r) => ({
        id: r.id, task_id: r.task_id, block_id: r.block_id, fire_at: r.fire_at, status: r.status, fired_at: r.fired_at,
      })),
    };
  });

  // POST /api/reminders — { taskId|blockId, fireAt? | (date+time) }. Exactly one
  // target. fire_at is stored UTC ISO: pass `fireAt` directly, or `date`+`time`
  // resolved tz-correctly via the owner's timezone (never the naive `${date}T${time}Z`).
  router.post('/api/reminders', async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      taskId?: string; blockId?: string; fireAt?: string; date?: string; time?: string;
    };
    const res = await createReminderChecked(currentOwnerId(), body);
    if (!res.ok) {
      const error = res.error === 'target' ? 'exactly one of taskId or blockId is required' : 'fireAt (UTC ISO) or date+time is required';
      ctx.status = 422; ctx.body = { error }; return;
    }
    broadcast(currentOwnerId(), 'reminder:created', { id: res.reminder.id });
    ctx.status = 201;
    ctx.body = { reminder: { id: res.reminder.id, task_id: res.reminder.task_id, block_id: res.reminder.block_id, fire_at: res.reminder.fire_at, status: res.reminder.status } };
  });

  // DELETE /api/reminders/:id — soft-cancel (keeps the row, off the dispatcher).
  router.delete('/api/reminders/:id', async (ctx) => {
    const res = await cancelReminderChecked(currentOwnerId(), ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'reminder:cancelled', { id: ctx.params.id });
    ctx.body = { ok: true };
  });

  // POST /api/reminders/:id/snooze — { minutes }. Re-arm the SAME row forward:
  // status→pending + fire_at advanced cancels the original firing (already 'fired')
  // and schedules exactly one new one — no double-fire.
  router.post('/api/reminders/:id/snooze', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { minutes?: number };
    const res = await snoozeReminderChecked(currentOwnerId(), ctx.params.id, body.minutes);
    if (!res.ok) {
      if (res.error === 'bad_minutes') { ctx.status = 422; ctx.body = { error: 'minutes must be a positive number' }; return; }
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }
    broadcast(currentOwnerId(), 'reminder:snoozed', { id: ctx.params.id, fireAt: res.reminder.fire_at });
    ctx.body = { reminder: { id: res.reminder.id, task_id: res.reminder.task_id, block_id: res.reminder.block_id, fire_at: res.reminder.fire_at, status: res.reminder.status } };
  });

  return router;
}
