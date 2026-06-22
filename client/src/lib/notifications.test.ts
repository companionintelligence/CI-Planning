import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scheduleTaskReminders, type ReminderTask } from './notifications.js';

/**
 * T7 — pure reminder scheduling. We mock the Web Notifications API (the node test
 * env has none) by assigning a vi.fn() constructor with a static
 * `permission='granted'` to globalThis, then drive time with fake timers and assert
 * on how many timeouts get armed (vi.getTimerCount) and that firing them constructs
 * a Notification with the right title/body.
 */

// A constructor spy standing in for the browser's `Notification`.
const NotificationMock = vi.fn();
(NotificationMock as any).permission = 'granted';
(NotificationMock as any).requestPermission = vi.fn(() => Promise.resolve('granted'));

const HOUR = '2026-06-15T12:00:00'; // local noon (TZ pinned in vitest.config.ts)
const at = (iso: string): Date => new Date(iso);

function reminder(overrides: Partial<ReminderTask> = {}): ReminderTask {
  return {
    title: 'Stretch',
    scheduledAt: at(HOUR),
    patternTagIds: ['wellness'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T11:00:00')); // "now" = an hour before the task
  (globalThis as any).Notification = NotificationMock;
  NotificationMock.mockClear();
});

afterEach(() => {
  scheduleTaskReminders([], {}); // drain module-level pending handles between tests
  vi.useRealTimers();
  delete (globalThis as any).Notification;
});

describe('scheduleTaskReminders', () => {
  it('arms exactly one timeout for a task 30 min out with reminder_offsets:[15]', () => {
    const task = reminder({ scheduledAt: at('2026-06-15T11:30:00') }); // 30 min from now
    scheduleTaskReminders([task], { wellness: { reminder_offsets: [15] } });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('fires the notification at scheduledAt - offset with a localized body', () => {
    const task = reminder({ scheduledAt: at('2026-06-15T11:30:00'), title: 'Standup' });
    scheduleTaskReminders([task], { wellness: { reminder_offsets: [15] } });

    vi.advanceTimersByTime(15 * 60_000 - 1); // 1ms before the 15-min mark
    expect(NotificationMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // now at the fire time (11:15, 15 min before 11:30)
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith('Standup', {
      body: expect.stringContaining('Starting at'),
    });
  });

  it('is idempotent — a second call clears the first (no double-count)', () => {
    const task = reminder({ scheduledAt: at('2026-06-15T11:30:00') });
    const prefs = { wellness: { reminder_offsets: [15] } };

    scheduleTaskReminders([task], prefs);
    expect(vi.getTimerCount()).toBe(1);
    scheduleTaskReminders([task], prefs);
    expect(vi.getTimerCount()).toBe(1); // not 2 — the first timeout was cleared

    vi.runAllTimers();
    expect(NotificationMock).toHaveBeenCalledTimes(1); // fires once, not twice
  });

  it('schedules nothing when the task pattern has no prefs entry', () => {
    const task = reminder({ patternTagIds: ['no-such-pattern'] });
    scheduleTaskReminders([task], { wellness: { reminder_offsets: [15] } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reminder_offsets:[0] schedules a reminder at the start time itself', () => {
    const task = reminder({ scheduledAt: at('2026-06-15T11:30:00') });
    scheduleTaskReminders([task], { wellness: { reminder_offsets: [0] } });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(30 * 60_000 - 1); // just before 11:30
    expect(NotificationMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // at 11:30 — the start time
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith(task.title, { body: 'Starting now' });
  });

  it('de-dupes identical fire-times across a task’s patterns', () => {
    // Two patterns, same 15-min offset → one fire-time, so one notification.
    const task = reminder({ scheduledAt: at('2026-06-15T11:30:00'), patternTagIds: ['a', 'b'] });
    scheduleTaskReminders([task], {
      a: { reminder_offsets: [15] },
      b: { reminder_offsets: [15] },
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('skips offsets whose fire-time is already in the past', () => {
    // Task starts in 10 min; a 15-min-before offset would fire 5 min ago → skip it,
    // but a 5-min-before offset (fires in 5 min) is armed.
    const task = reminder({ scheduledAt: at('2026-06-15T11:10:00') });
    scheduleTaskReminders([task], { wellness: { reminder_offsets: [15, 5] } });
    expect(vi.getTimerCount()).toBe(1);
  });
});
