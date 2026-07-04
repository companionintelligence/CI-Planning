/*
 * Companion Planning service worker (Phase H).
 *
 * Push notifications + notification-click routing ONLY — intentionally NO fetch /
 * cache handler. A precache or read-through cache is the #1 PWA footgun: a stale
 * index.html / old JS hashes can strand installs on a blank screen after a deploy.
 * Offline caching isn't needed for notifications and is deliberately deferred. With
 * no fetch handler every request passes straight to the network, so adding this SW
 * cannot change the existing install / read path.
 */

// Activate immediately and take control of open clients so reminders can fire and
// notification clicks can focus an existing tab without requiring a manual reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || 'Reminder', {
        body: d.body || '',
        tag: d.tag, // collapses re-delivery of the same reminder into one notification
        // Phase Z · Z4: Focus Ritual cues carry a haptic pattern. Honored where the
        // platform supports it (Android/Chrome); a silent no-op on iOS — a degrade,
        // never a block. Absent for ordinary reminders.
        ...(Array.isArray(d.vibrate) ? { vibrate: d.vibrate } : {}),
        data: { url: d.url || '/' },
      }),
      // Phase L (gap 9): tell open tabs to flush their op-log. Without this,
      // writes queued while the tab is backgrounded stall until the user opens
      // the window and the 'online' event fires. The client registers a
      // 'message' listener in stores/mutations.ts that calls flush() on receipt.
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => { for (const c of clients) c.postMessage({ type: 'sync-flush' }); }),
    ]),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
