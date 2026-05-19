// Companion Planning service worker — stale-while-revalidate for the app shell,
// network-first for API calls so changes show up immediately when online,
// cache-fallback for last-viewed files so the app reads offline.

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const API_CACHE = `api-${VERSION}`;
const FILE_CACHE = `files-${VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.ico',
  '/vendor/marked.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.endsWith(`-${VERSION}`))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SSE stream — never cache, never intercept
  if (url.pathname === '/api/events') return;

  // App shell: stale-while-revalidate
  if (SHELL_ASSETS.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // File reads: network-first with cache fallback (so offline = last seen)
  if (url.pathname === '/api/file') {
    event.respondWith(networkFirst(req, FILE_CACHE));
    return;
  }

  // Other API: network-first, do not cache mutations
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // Default
  event.respondWith(networkFirst(req, SHELL_CACHE));
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((resp) => {
      if (resp && resp.status === 200) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
