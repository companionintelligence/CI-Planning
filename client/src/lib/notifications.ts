/**
 * T7 — browser reminders for pattern-tagged tasks (Web Notifications).
 *
 * Pure, store-free helpers so the scheduling logic is unit-testable: the caller
 * feeds in a plain `ReminderTask[]` (mapped from the day's scheduled blocks) plus
 * the per-pattern `reminder_offsets` and we fire a `Notification` at
 * `scheduledAt - offset minutes` for each (task, pattern, offset) still in the
 * future. Every `Notification` touch is guarded with a `typeof` check so this is
 * safe to import in the node test environment (where `Notification` is undefined).
 */

/** A scheduled task we may want to remind about. */
export interface ReminderTask {
  title: string;
  scheduledAt: Date;       // the block's start time
  patternTagIds: string[]; // ids of the task's kind='pattern' tags
}

/** The slice of a pattern's prefs we need — just the reminder offsets. */
interface OffsetPref {
  reminder_offsets: number[];
}

// Module-level handles for every timeout we've armed. Cleared at the top of each
// scheduleTaskReminders call so repeated calls (e.g. on focus / data change) never
// double-fire the same reminder.
let pending: ReturnType<typeof setTimeout>[] = [];

/** True only in a browser that exposes the Notifications API. */
function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

/**
 * Ask for notification permission once. No-op if unsupported or already
 * decided (granted/denied) — the browser only shows the prompt while the
 * permission is still 'default'.
 */
export function requestNotificationPermission(): void {
  if (!notificationsSupported()) return;
  if (Notification.permission === 'default') {
    // Fire-and-forget; the returned promise's result is reflected in
    // Notification.permission, which scheduleTaskReminders re-checks.
    void Notification.requestPermission();
  }
}

/** Format a reminder body: "Starting now" at offset 0, else the localized start time. */
function reminderBody(scheduledAt: Date, isAtStart: boolean): string {
  if (isAtStart) return 'Starting now';
  return `Starting at ${scheduledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** Cancel and forget every pending reminder timeout. */
function clearPending(): void {
  for (const h of pending) clearTimeout(h);
  pending = [];
}

/**
 * Clear any previously-scheduled reminders, then for each (task, pattern, offset)
 * arm a Notification at `scheduledAt - offset*60_000` when that instant is still in
 * the future. Idempotent: safe to call repeatedly (clears first, so no duplicates).
 *
 * Offsets are unioned across a task's pattern tags and de-duped by fire-time, so a
 * task in two patterns that both want a 15-min heads-up only notifies once.
 *
 * @param tasks  today's future-scheduled, pattern-tagged tasks
 * @param prefs  per-pattern-tag-id prefs ({ reminder_offsets }); tags missing here
 *               contribute no offsets (→ no reminder)
 */
export function scheduleTaskReminders(
  tasks: ReminderTask[],
  prefs: Record<string, OffsetPref>,
): void {
  clearPending();
  if (!notificationsSupported() || Notification.permission !== 'granted') return;

  const now = Date.now();

  for (const task of tasks) {
    const startMs = task.scheduledAt.getTime();
    if (Number.isNaN(startMs)) continue; // unparseable start → skip

    // Union the offsets across every pattern tag this task carries, then collapse
    // to distinct fire-times so the user never gets two notifications for the same
    // task at the same instant.
    const fireTimes = new Set<number>();
    for (const tagId of task.patternTagIds) {
      const offsets = prefs[tagId]?.reminder_offsets;
      if (!offsets) continue;
      for (const offset of offsets) fireTimes.add(startMs - offset * 60_000);
    }

    for (const fireAt of fireTimes) {
      if (fireAt <= now) continue; // already past — don't fire late
      const body = reminderBody(task.scheduledAt, fireAt === startMs);
      const handle = setTimeout(() => {
        if (notificationsSupported() && Notification.permission === 'granted') {
          new Notification(task.title, { body });
        }
      }, fireAt - now);
      pending.push(handle);
    }
  }
}
