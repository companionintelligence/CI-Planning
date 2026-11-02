import { api } from './api.js';
import { isNativeShell } from './server-config.js';

/** base64url VAPID public key → ArrayBuffer for `applicationServerKey` (a BufferSource). */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'subscribed' | 'unsubscribed';

function supported(): boolean {
  // Web Push needs the service worker, which the Capacitor shell does not register
  // (sw/register.ts). Native push (APNs/FCM) is a separate, unbuilt path.
  if (isNativeShell()) return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Current push capability + subscription state, WITHOUT prompting. */
export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}

/**
 * Opt in: subscribe via the service worker and register the subscription server-side.
 * Resolves to the resulting state — 'unconfigured' if the server has no VAPID keys,
 * 'denied' if the user blocks the prompt, 'unsupported' if the platform can't do push.
 * The server key is checked BEFORE prompting, so we never show a permission dialog we
 * can't act on.
 */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';

  const { key } = await api.push.vapidKey();
  if (!key) return 'unconfigured'; // server has no VAPID keys → push dormant; don't prompt

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'unsubscribed';

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBuffer(key),
  });
  await api.push.subscribe(sub.toJSON() as PushSubscriptionJSON);
  return 'subscribed';
}

/** Opt out: drop the browser subscription and the server-side row. */
export async function disablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.push.unsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return 'unsubscribed';
}
