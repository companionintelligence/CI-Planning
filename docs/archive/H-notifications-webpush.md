# H — Notifications + service worker / Web Push (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **B0** (migration runner, `lib/context.ts`, owner-scoped `broadcast`). Content is richer once **D** (actuals) and **G** (rituals) exist — those generate the events worth reminding on — but H ships standalone with task/block reminders.

## Goal
1. A **real service worker** (today the PWA is manifest-only) that receives Web Push, shows notifications, and routes notification clicks — *without* breaking the existing read-cache install path.
2. **Web Push via VAPID** with an owner-scoped `push_subscriptions` store and a `reminders(task_id|block_id, fire_at, status)` table.
3. A **cron dispatcher** that fires each due reminder **exactly once** at a tz-correct `fire_at`, delivering **in-app via owner-scoped SSE + push**, with **push failure falling back to in-app**, and **snooze** that reschedules `fire_at` without double-firing.

## Non-goals
- No push-message **encryption of payload content beyond** what `web-push` (RFC 8291 aes128gcm) already does; no E2E key escrow.
- No third-party push relay, no FCM/APNs SDKs — browser Push API + self-hosted VAPID only.
- No recurring/RRULE reminders (single `fire_at` per row; G/recurrence is a later phase).
- No quiet-hours / digest batching / per-channel routing UI. One reminder = one notification.
- No iOS-specific install funnels; we degrade gracefully where Push is unsupported.

## Current state (what exists today)
- **PWA is manifest-only.** `client/index.html:10` links `/manifest.webmanifest`; `client/public/manifest.webmanifest` declares `display: standalone` + the favicon icon. **There is no service worker and no `navigator.serviceWorker.register` call** — `client/src/main.tsx` only mounts SolidJS. So the app is installable but has zero offline/push capability.
- **Static serving:** `client/vite.config.ts` builds to `../server/public`; the server serves it via `koa-static` (`server/src/app.ts:4,31` → `serve(config.staticDir)`). A SW file must be emitted at the web root with the right scope/headers through this same path.
- **SSE:** `server/src/routes/sse.ts` — after B0 this is `broadcast(ownerId, event, data)` over a `Map<PassThrough, ownerId>`; `/api/events` registers the stream at `currentOwnerId()`. This is the in-app channel H reuses.
- **Cron:** `server/src/jobs/index.ts` registers crons via **croner** from `scheduled_jobs` rows (`startCronJobs()`), runs each through `runJob(kind)` which records a `job_runs` row and `broadcast(...)`s. Seed crons live in `db/setup.ts` (folded into a B0 migration), e.g. `auto_schedule` at `'0 3 * * *'`. H adds one more job kind on a 1-minute tick.
- **Schema/migrations:** `server/src/db/schema.ts` (Drizzle, `owner_id` FKs to `owners`). After B0, schema changes ship as **new numbered TS migrations** through `db/migrate.ts` (forward-only, idempotent, explicit `MIGRATIONS` array).
- **tz:** `server/src/lib/tz.ts` → `zonedWallTimeToUTC(date, 'HH:MM', tz)` and `utcDayBounds`. All timestamps stored as **UTC ISO text**; wall-clock reminder times must round-trip through this, not `${date}T${time}Z`.

## Design

### 1. The service worker
Ship a hand-written SW at the web root so its scope is `/` (a SW only controls paths at/under its own URL). Emit it as `client/public/sw.js` → built to `server/public/sw.js`, served by `koa-static` with `Service-Worker-Allowed: /` and `Cache-Control: no-cache` (the SW file itself must never be stale-cached). Register **after load**, additively:

```ts
// client/src/sw/register.ts — called once from main.tsx, never throws
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); }
  catch (e) { console.warn('SW registration failed', e); } // app still runs
}
```

```js
// client/public/sw.js — push + click only; a tiny read-through cache, no precache manifest
self.addEventListener('push', (e) => {
  const d = e.data?.json() ?? {};
  e.waitUntil(self.registration.showNotification(d.title ?? 'Reminder', {
    body: d.body, tag: d.tag, data: { url: d.url ?? '/' }, // tag de-dupes re-delivery
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url));
});
```

The cache must be **read-through only** (cache-on-fetch, never a build-time precache list) so adding the SW does not change install behavior or strand users on stale bundles — see Risks.

### 2. Web Push / VAPID
Add the `web-push` dependency (server) and two env vars `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (generated once via `web-push generate-vapid-keys`; documented in README + `.env.example`). A thin `server/src/lib/push.ts` wraps it:

```ts
import webpush from 'web-push';
import { config } from '../config.js';
webpush.setVapidDetails('mailto:' + config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);

export async function sendPush(sub: PushSub, payload: object): Promise<'ok' | 'gone' | 'fail'> {
  try { await webpush.sendNotification(sub, JSON.stringify(payload)); return 'ok'; }
  catch (e: any) { return (e.statusCode === 404 || e.statusCode === 410) ? 'gone' : 'fail'; }
}
```

A `410 Gone` / `404` means the subscription is dead → delete the row. The client fetches the public key from `GET /api/push/vapid-key` and subscribes via `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.

### 3. `push_subscriptions` + `reminders` schema
New numbered migration (`00NN_notifications.ts`, appended to `MIGRATIONS`), idempotent `CREATE TABLE IF NOT EXISTS`, both **owner-scoped**:

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES owners(id),
  endpoint   TEXT NOT NULL UNIQUE,            -- one row per browser endpoint
  p256dh     TEXT NOT NULL, auth TEXT NOT NULL,
  user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES owners(id),
  task_id    INTEGER REFERENCES tasks(id)        ON DELETE CASCADE,
  block_id   INTEGER REFERENCES time_blocks(id)  ON DELETE CASCADE,
  fire_at    TEXT NOT NULL,                   -- UTC ISO; tz-correct via lib/tz
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | fired | snoozed | cancelled
  fired_at   TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CHECK ((task_id IS NULL) <> (block_id IS NULL))  -- exactly one target
);
CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(status, fire_at);
```

Drizzle definitions mirror these in `schema.ts`. Routes (owner-scoped via `currentOwnerId()`, mounted behind `requireOwner` from B0):
- `POST /api/push/subscribe` — upsert by `endpoint`; `DELETE /api/push/subscribe` — remove on unsubscribe.
- `GET /api/push/vapid-key` — returns `{ key: VAPID_PUBLIC_KEY }`.
- `POST /api/reminders` `{ taskId|blockId, fireAt }`, `DELETE /api/reminders/:id` (→ `cancelled`), `POST /api/reminders/:id/snooze` `{ minutes }`.

Computing `fire_at`: a UI offset like "15 min before due" or a wall-clock time resolves through `zonedWallTimeToUTC(date, 'HH:MM', prefs.timezone)` (or `dueAt − offset`), stored as UTC ISO — never `${date}T${time}Z`.

### 4. The cron dispatcher
One new `scheduled_jobs` row seeded in the notifications migration — `{ name:'fire_reminders', kind:'fire_reminders', cron:'* * * * *' }` — picked up by the existing `startCronJobs()` loop, no croner change. Add the case to `execute()` in `jobs/index.ts`:

```ts
case 'fire_reminders': {
  const now = new Date().toISOString();
  // claim-by-update: the UPDATE is the lock → a reminder can transition pending→fired only once
  const due = sqlite.prepare(
    `UPDATE reminders SET status='fired', fired_at=?
       WHERE id IN (SELECT id FROM reminders WHERE status='pending' AND fire_at <= ?)
       RETURNING id, owner_id, task_id, block_id`).all(now, now) as Due[];
  for (const r of due) await deliver(r);      // SSE + push
  return { itemsCreated: 0, itemsUpdated: due.length, log: `Fired ${due.length} reminders` };
}
```

The atomic `UPDATE ... RETURNING` (better-sqlite3 is synchronous, single-writer) is what guarantees **exactly-once**: only rows still `pending` flip to `fired`, so the next minute's tick re-selects nothing — **never twice**. `deliver()` always emits the in-app event first, then attempts push:

```ts
async function deliver(r: Due) {
  broadcast(r.owner_id, 'reminder:fire', { id: r.id, taskId: r.task_id, blockId: r.block_id });
  const subs = subsFor(r.owner_id);
  for (const s of subs) {
    const res = await sendPush(s, payloadFor(r));
    if (res === 'gone') deleteSub(s.id);       // push failure → already delivered in-app (fallback)
  }
}
```

Because SSE fires unconditionally before push, **push failure (or push denied / no subscription) falls back to in-app** automatically — no extra branch needed.

### 5. Snooze
Snooze reschedules the *same* row forward and re-arms it so the dispatcher re-selects it later:

```ts
// POST /api/reminders/:id/snooze {minutes}
sqlite.prepare(
  `UPDATE reminders SET fire_at=?, status='pending', fired_at=NULL
     WHERE id=? AND owner_id=?`).run(addMinutes(now, minutes), id, currentOwnerId());
```

Setting `status` back to `pending` and pushing `fire_at` out **cancels the original firing** (it is already `fired`, so the old instant never re-triggers) and schedules exactly one new firing — no double-fire. `broadcast(owner, 'reminder:snoozed', { id, fireAt })` updates open clients.

### 6. Permission flow
Strictly opt-in and non-blocking — the app must fully function with push **denied or unsupported**:
1. SW registers on load regardless of notification permission (§1).
2. A Settings toggle (not an on-load prompt) calls `Notification.requestPermission()`; only on `granted` do we `pushManager.subscribe(...)` and `POST /api/push/subscribe`.
3. If `Notification.permission !== 'granted'` or `'serviceWorker'`/`'PushManager'` are absent → hide the toggle, rely on in-app SSE. Install/use is never gated on push.
4. Unsubscribe in Settings → `subscription.unsubscribe()` + `DELETE /api/push/subscribe`.

## Tests
- **`reminders.test.ts` — fires exactly once:** seed a `pending` reminder with `fire_at <= now`; run `fire_reminders` → status `fired`, **one** `reminder:fire` broadcast; run the tick **again** → zero rows selected, **no second fire**.
- **tz-correctness:** a "09:00 local" reminder in `America/Los_Angeles` stores the UTC instant from `zonedWallTimeToUTC` (not the naive `Z`), and is *not* due before that instant; assert across a DST boundary day.
- **snooze:** snooze a `fired` reminder by 10m → row is `pending`, `fire_at` advanced, `fired_at` null; the original instant never re-fires; exactly one fire after the new `fire_at`.
- **push fallback:** stub `sendPush` → `'fail'`; assert the in-app `reminder:fire` SSE still emitted (owner-scoped); a `'gone'` result deletes the subscription row.
- **owner isolation:** reminder for owner A broadcasts only to A's SSE stream; A's push subs only (reuse B0 isolation harness).
- **SW does not break install (Playwright):** with `/sw.js` served, the PWA still installs and loads after a hard reload (no precache-stranded blank screen); registration failure (404 stub) does not throw or block mount.
- **CHECK constraint:** inserting a reminder with both `task_id` and `block_id` (or neither) is rejected.
- **Standing suites:** full Vitest + container Playwright green; runs with push **denied** (the default headless case) must pass.

## Acceptance criteria
1. A real SW registers at scope `/`; the existing manifest install path still works, **app installs and loads with push denied**.
2. Web Push delivers when the app is backgrounded; in-app SSE delivers when open; **both** for a foregrounded subscriber is acceptable (notification `tag` de-dupes).
3. A reminder fires **exactly once** at its tz-correct `fire_at` — never twice across consecutive dispatcher ticks.
4. **Snooze** moves the next fire and cancels the original; no double-fire.
5. **Push failure (or no subscription) falls back to in-app** with no lost reminder; dead subscriptions (`404/410`) are pruned.
6. `push_subscriptions` + `reminders` are owner-scoped, added via a **new numbered migration** through the B0 runner; full suite green.

## Risks / notes
- **SW caching can strand installs.** The #1 PWA footgun is a precache SW serving a stale `index.html`/old JS hashes. Use **read-through cache only** (no build-time precache manifest, no Workbox `precacheAndRoute`), and serve `/sw.js` itself with `Cache-Control: no-cache` + `Service-Worker-Allowed: /`. This is why we hand-write the SW rather than pull `vite-plugin-pwa` injectManifest.
- **Dispatcher granularity = 1 min.** `fire_at` resolution is one minute; a reminder fires on the first tick at/after `fire_at` (slightly late, never early, never twice). Acceptable for human reminders; finer needs a different mechanism.
- **Missed ticks while down.** Because the query is `fire_at <= now` (not `== now`), reminders that came due while the server was off all fire on the next boot tick — correct (deliver late) but a long outage produces a burst; acceptable for v1.
- **VAPID keys are deployment identity.** Rotating them invalidates every existing subscription (clients must re-subscribe). Generate once per install; document in README; never commit. Missing keys → push disabled, in-app still works (degrade gracefully).
- **Payload size / privacy.** Push payloads ride the user's browser-vendor push service; keep them minimal (`{title, body, tag, url}`), no sensitive task detail — fetch full context from the app on click.
- **`userVisibleOnly: true`** is mandatory in Chromium; silent push is not allowed, which matches our "always show a notification" model.

## Effort
**M** — ~3–4 days. The deterministic core (schema migration + claim-by-`UPDATE` dispatcher + snooze) is small and well-bounded; most of the time is the SW lifecycle, VAPID/`web-push` wiring, the permission-flow UI, and the install-not-broken Playwright check.

## Suggested PR breakdown
1. **Server foundation (no client):** migration (`push_subscriptions`, `reminders`, `fire_reminders` seed), `lib/push.ts` + `web-push` dep + VAPID env, push/reminder routes, `fire_reminders` job case, owner-scoped `deliver()`. Ship with `reminders.test.ts` (exactly-once, snooze, tz, fallback, isolation).
2. **Service worker + registration:** `client/public/sw.js`, `register.ts` wired into `main.tsx`, `Service-Worker-Allowed`/`no-cache` headers, the **install-not-broken** Playwright test.
3. **Permission flow + UI:** Settings toggle, subscribe/unsubscribe, `vapid-key` fetch, in-app `reminder:fire` toast on the SSE channel, snooze control.

Splitting keeps the deterministic server core (where the exactly-once guarantee lives) independently testable before any SW/browser surface lands.
