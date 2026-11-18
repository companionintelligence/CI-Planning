import { LocalNotifications } from '@capacitor/local-notifications';
import type { Reminder } from './api.js';
import { isCapacitorShell } from './server-config.js';

const ENABLED_KEY = 'ci-planning.native-reminders-enabled';
const IDS_KEY = 'ci-planning.native-reminder-ids';
const MAX_PENDING = 60; // iOS limits an app to 64 pending local notifications.

export type NativeReminderPermission = 'granted' | 'denied' | 'unsupported';

export function nativeRemindersEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === 'true'; } catch { return false; }
}

export function setNativeRemindersEnabled(enabled: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false'); } catch { /* device storage unavailable */ }
}

export async function requestNativeReminderPermission(): Promise<NativeReminderPermission> {
  if (!isCapacitorShell()) return 'unsupported';
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return 'granted';
    const result = await LocalNotifications.requestPermissions();
    return result.display === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

function readScheduledIds(): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(IDS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  } catch { return []; }
}

async function cancelScheduled(): Promise<void> {
  const ids = readScheduledIds();
  if (ids.length) {
    await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }).catch(() => {});
  }
  try { localStorage.removeItem(IDS_KEY); } catch { /* device storage unavailable */ }
}

export async function disableNativeReminders(): Promise<void> {
  setNativeRemindersEnabled(false);
  if (isCapacitorShell()) await cancelScheduled();
}

/**
 * Refresh this device's reminders from the selected server. Local notifications are
 * deliberately generic so task names and other planning details are not shown on a
 * locked screen. On Android these use inexact alarms to avoid requesting the special
 * exact-alarm permission; the OS may deliver them a little later to save battery.
 */
export async function syncNativeReminders(reminders: Reminder[]): Promise<void> {
  if (!isCapacitorShell() || !nativeRemindersEnabled()) return;

  const permission = await LocalNotifications.checkPermissions().catch(() => ({ display: 'denied' as const }));
  if (permission.display !== 'granted') {
    await cancelScheduled();
    return;
  }

  const now = Date.now();
  const upcoming = reminders
    .filter((reminder) => reminder.status === 'pending' && Date.parse(reminder.fire_at) > now)
    .sort((a, b) => Date.parse(a.fire_at) - Date.parse(b.fire_at))
    .slice(0, MAX_PENDING);

  await cancelScheduled();
  if (!upcoming.length) return;

  const used = new Set<number>();
  const notifications = upcoming.map((reminder) => {
    // Stable positive 31-bit id for the OS API, with deterministic collision handling.
    let id = 2166136261;
    for (const char of reminder.id) id = Math.imul(id ^ char.charCodeAt(0), 16777619) >>> 0;
    id = (id & 0x7fffffff) || 1;
    while (used.has(id)) id = id === 0x7fffffff ? 1 : id + 1;
    used.add(id);
    return {
      id,
      title: 'Companion Planning',
      body: 'A reminder is due.',
      schedule: { at: new Date(reminder.fire_at) },
      // Avoid the Android exact-alarm special access prompt in v1.
      isExactNotification: false,
      extra: { kind: 'planner-reminder' },
    };
  });

  await LocalNotifications.schedule({ notifications });
  try { localStorage.setItem(IDS_KEY, JSON.stringify(notifications.map((item) => item.id))); } catch { /* best-effort bookkeeping */ }
}
