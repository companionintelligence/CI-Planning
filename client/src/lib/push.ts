import { api } from './api.js';

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

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed';

function supported(): boolean {
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
 * Opt in: request permission, subscribe via the service worker, and register the
 * subscription server-side. Resolves to the resulting state ('denied' if the user
 * blocks, 'unsupported' if the platform or server VAPID config can't do push).
 */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'unsubscribed';

  const { key } = await api.push.vapidKey();
  if (!key) return 'unsupported'; // server has no VAPID keys → push disabled

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
