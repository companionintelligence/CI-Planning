import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { config } from '../lib/config.js';
import { broadcast } from '../routes/sse.js';
import { getTask } from '../services/tasks.js';
import { getBlock } from '../services/blocks.js';
import {
  listReminders, createReminderChecked, cancelReminderChecked, snoozeReminderChecked,
  listPushSubscriptions, subscribePushChecked, unsubscribePushChecked,
  type Reminder, type PushSubscriptionRow,
} from '../services/notifications.js';

/**
 * ReminderType + PushSubscriptionType resolvers (Phase W · W10). Reuse
 * services/notifications.ts (Decision 3) — the SAME owner-scoped functions the REST
 * routes call. Owner comes from `currentOwnerId()`, never the client. SSE fires here
 * (the transport layer), mirroring the split established by block-resolvers.ts /
 * task-resolvers.ts: service = validation + write + audit, resolver = broadcast.
 */

export const notificationResolvers = {
  Query: {
    reminders: (): Reminder[] => listReminders(currentOwnerId()),
    pushSubscriptions: () => listPushSubscriptions(currentOwnerId()),
    pushVapidKey: (): string => config.vapidPublicKey,
  },

  Mutation: {
    createReminder: (
      _p: unknown,
      args: { input: { taskId?: string | null; blockId?: string | null; fireAt?: string | null; date?: string | null; time?: string | null } },
    ) => {
      const owner = currentOwnerId();
      const res = createReminderChecked(owner, args.input);
      if (!res.ok) {
        const msg = res.error === 'target' ? 'exactly one of taskId or blockId is required' : 'fireAt (UTC ISO) or date+time is required';
        throw new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'reminder:created', { id: res.reminder.id });
      return { reminder: res.reminder, success: true };
    },

    cancelReminder: (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = cancelReminderChecked(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('reminder not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'reminder:cancelled', { id: args.input.id });
      return { reminder: res.reminder, success: true };
    },

    snoozeReminder: (_p: unknown, args: { input: { id: string; minutes: number } }) => {
      const owner = currentOwnerId();
      const res = snoozeReminderChecked(owner, args.input.id, args.input.minutes);
      if (!res.ok) {
        if (res.error === 'bad_minutes') throw new GraphQLError('minutes must be a positive number', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('reminder not found', { extensions: { code: 'NOT_FOUND' } });
      }
      broadcast(owner, 'reminder:snoozed', { id: args.input.id, fireAt: res.reminder.fire_at });
      return { reminder: res.reminder, success: true };
    },

    subscribePush: (_p: unknown, args: { input: { endpoint: string; p256dh: string; auth: string } }) => {
      const res = subscribePushChecked(currentOwnerId(), args.input);
      if (!res.ok) throw new GraphQLError('a subscription with endpoint + keys is required', { extensions: { code: 'BAD_USER_INPUT' } });
      return { success: true };
    },

    unsubscribePush: (_p: unknown, args: { input: { id: string } }) => {
      const res = unsubscribePushChecked(currentOwnerId(), args.input.id);
      if (!res.ok) throw new GraphQLError('endpoint is required', { extensions: { code: 'BAD_USER_INPUT' } });
      return { success: true };
    },
  },

  ReminderType: {
    task: async (r: Reminder) => (r.task_id ? (await getTask(currentOwnerId(), r.task_id)) ?? null : null),
    block: async (r: Reminder) => (r.block_id ? (await getBlock(currentOwnerId(), r.block_id)) ?? null : null),
    fireAt: (r: Reminder) => r.fire_at,
    firedAt: (r: Reminder) => r.fired_at,
    // id/status/source map by name via the default resolver.
  },

  PushSubscriptionType: {
    // id = the endpoint (natural-key-as-Node-id, per the SDL comment) — NOT the DB `id`
    // column, so it lines up with unsubscribePush's `DeleteByIdInput.id` expecting an
    // endpoint. endpoint maps by name via the default resolver.
    id: (p: PushSubscriptionRow) => p.endpoint,
    userAgent: (p: PushSubscriptionRow) => p.user_agent,
    createdAt: (p: PushSubscriptionRow) => p.created_at,
  },
};
