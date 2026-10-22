# H — Notifications + service worker / Web Push (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md) and [GLOSSARY.md](GLOSSARY.md). **Revised for
the post-consolidation base (2026-06-21).**

**Base & dependencies.** H lands on `main` *after* the Consolidation Pass and the
cockpit-v2 batch:
- **Merged to `main` (HEAD `7fb071e`, ceiling mig `0035`):** CON-1 UUIDv7 identity
  (#74, mig `0030`), CON-2 vocabulary + `tasks.subtype` (#75, mig `0031`/`0032`),
  CON-3 `entity_tags` (#78, mig `0033`), CON-5 drag-to-place, and **#77 cockpit-v2**
  (mig `0035`, recall=clone). So entity ids are already **TEXT UUIDv7**, block states
  are `scheduled`/`someday`, and Habit is a **Task subtype**.
- **The one unbuilt H prerequisite — CON-4 recurrence unification** (reserved mig
  `0034`, *no branch yet*). H's *recurring/Routine* reminders ride CON-4's single
  engine — see §4b. **H's own migration is `0036`.**

**Reminder is a *facet*, not a noun.** The [GLOSSARY](GLOSSARY.md) budget is 8 nouns
(7 in use + 1 reserved); "Reminder"/"Notification" are not in it and a new top-level
noun would have to retire one. So a reminder is modeled as a **facet of Task and
scheduled Time Block** ("Remind me at…"), backed by an internal owner-scoped
`reminders` table — exactly as `patterns` backs the **Routine** noun. There is **no
"Reminders" screen or nav item**; reminders are authored on the entity and surfaced
as a transient toast on fire.

## Goal
1. A **real service worker** (today the PWA is manifest-only) that receives Web Push,
   shows notifications, and routes notification clicks — *without* breaking the
   existing read-cache install path.
2. **Web Push via VAPID** with an owner-scoped `push_subscriptions` store and a
   `reminders(task_id | block_id, fire_at, status)` table (UUIDv7 ids), where a
   reminder is a facet of a **Task** or a **scheduled Time Block**.
3. A **cron dispatcher** that fires each due reminder **exactly once** at a tz-correct
   `fire_at`, delivering **in-app via owner-scoped SSE + push**, with **push failure
   falling back to in-app**, and **snooze** that reschedules `fire_at` without
   double-firing.

## Non-goals
- No push-message **encryption of payload content beyond** what `web-push`
  (RFC 8291 aes128gcm) already does; no E2E key escrow.
- No third-party push relay, no FCM/APNs SDKs — browser Push API + self-hosted VAPID
  only.
- **No second recurrence engine.** H stores **one `fire_at` per row** and never
  expands an RRULE itself. Recurring reminders exist only by **riding CON-4's unified
  engine**, which mints one reminder row per materialized occurrence (§4b).
- **No new top-level noun.** Reminder stays a facet of Task/Time Block (above).
- No quiet-hours / digest batching / per-channel routing UI. One reminder = one
  notification.
- No iOS-specific install funnels; we degrade gracefully where Push is unsupported.

## Current state (post-consolidation `main`)
- **Identity is UUIDv7 (CON-1).** Every entity PK is `text('id').primaryKey()
  .$defaultFn(newId)`; `newId()` / the `uuid7()` SQLite UDF / `SYSTEM_OWNER_ID`
  (`'00000000-0000-7000-8000-000000000001'`) live in `server/src/lib/ids.ts`. Treat
  ids as **opaque strings** — never `Number(id)`. **Drizzle inserts** get an id via
  `$defaultFn`; **raw-SQL inserts in a migration** must pass an explicit `newId()` —
  the migrate runner uses a bare connection where neither `$defaultFn` nor the
  `uuid7()` UDF is available (the CON-3 pattern, see `0033_entity_tags.ts`).
- **Vocabulary (CON-2).** `time_blocks.block_type` values are `scheduled` (was
  `plan`) / `someday` (was `concept`); the list param is `?state=`. `tasks.subtype`
  is `standard | habit | quick` (`is_habit`/`is_fast_task` kept as in-sync runtime
  aliases). **Habit is a Task subtype**, surfaced in Routines — so a habit reminder
  is just a Task reminder.
- **PWA is manifest-only.** `client/index.html` links `/manifest.webmanifest`;
  there is **no service worker and no `navigator.serviceWorker.register`** —
  `client/src/main.tsx` only mounts SolidJS. Installable, zero offline/push.
- **Static serving:** `client/vite.config.ts` builds to `../server/public`; the
  server serves it via `koa-static` (`server/src/app.ts` → `serve(config.staticDir)`)
  with an SPA fallback for non-`/api` paths. The SW must be emitted at the web root
  and served through this path with the right scope/headers.
- **SSE:** `server/src/routes/sse.ts` — `broadcast(ownerId, event, data)` over a
  `Map<PassThrough, string>` (owner ids are now strings); `/api/events` registers the
  stream at `currentOwnerId()`. This is the in-app channel H reuses.
- **Cron:** `server/src/jobs/index.ts` registers crons via **croner** from
  `scheduled_jobs` rows (`startCronJobs()`), running each through `runJob(kind)` →
  `execute(kind)`, which records a `job_runs` row and `broadcast(...)`s under
  `currentOwnerId()` (cron binds `SYSTEM_OWNER`). H adds one job kind on a 1-min tick.
- **Recurrence is still dual (pre-CON-4).** `tasks.recurrence_rule` (Phase E task
  engine) **and** `pattern_types` pattern-level RRULE (mig `0025`) both exist;
  `time_blocks` has **no** `recurrence_rule` yet. CON-4 collapses these to one engine
  and adds `time_blocks.recurrence_rule`. H's recurrence hook (§4b) targets that
  unified path and is therefore **gated on CON-4**.
- **Routine reminder config already stored.** `pattern_types.reminder_config`
  (`text … {mode:'json'}`, *"opaque until Phase H"*) and `pattern_types.notify`
  (per-type toggle) exist on `main`. H is the **first reader** → H defines the
  `reminder_config` JSON shape; the cockpit/Settings UI conforms.
- **tz:** `server/src/lib/tz.ts` → `zonedWallTimeToUTC(date, 'HH:MM', tz)` and
  `utcDayBounds`. All timestamps are **UTC ISO text**; wall-clock reminder times must
  round-trip through this, never `${date}T${time}Z`. The owner's zone is
  `scheduling_prefs.timezone`.
- **Migration ceiling on `main` = `0035`** (#77 merged; `0034` reserved-empty for
  CON-4). With CON-4 landing at `0034`, **H's migration is `0036_notifications`**.

## Design

### 1. The service worker  *(unchanged by consolidation)*
Ship a hand-written SW at the web root so its scope is `/` (a SW only controls paths
at/under its own URL). Emit it as `client/public/sw.js` → built to
`server/public/sw.js`, served by `koa-static` with `Service-Worker-Allowed: /` and
`Cache-Control: no-cache` (the SW file itself must never be stale-cached). Register
**after load**, additively:

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

The cache must be **read-through only** (cache-on-fetch, never a build-time precache
list) so adding the SW does not change install behavior or strand users on stale
bundles — see Risks.

### 2. Web Push / VAPID  *(unchanged by consolidation)*
Add the `web-push` dependency (server) and two env vars `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` (generated once via `web-push generate-vapid-keys`; documented in
README + `.env.example`). A thin `server/src/lib/push.ts` wraps it:

```ts
import webpush from 'web-push';
import { config } from './config.js';
webpush.setVapidDetails('mailto:' + config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);

export async function sendPush(sub: PushSub, payload: object): Promise<'ok' | 'gone' | 'fail'> {
  try { await webpush.sendNotification(sub, JSON.stringify(payload)); return 'ok'; }
  catch (e: any) { return (e.statusCode === 404 || e.statusCode === 410) ? 'gone' : 'fail'; }
}
```

A `410 Gone` / `404` means the subscription is dead → delete the row. The client
fetches the public key from `GET /api/push/vapid-key` and subscribes via
`pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.

### 3. `push_subscriptions` + `reminders` schema  *(UUIDv7)*
New migration **`0036_notifications.ts`**, appended to the `MIGRATIONS` array,
additive + idempotent, both **owner-scoped**. Ids are **TEXT UUIDv7**; FKs reference
the now-`text` PKs:

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,                       -- newId() (minted in TS)
  owner_id   TEXT NOT NULL REFERENCES owners(id),
  endpoint   TEXT NOT NULL UNIQUE,                   -- one row per browser endpoint
  p256dh     TEXT NOT NULL, auth TEXT NOT NULL,
  user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,                        -- newId()
  owner_id   TEXT NOT NULL REFERENCES owners(id),
  task_id    TEXT REFERENCES tasks(id)        ON DELETE CASCADE,
  block_id   TEXT REFERENCES time_blocks(id)  ON DELETE CASCADE,
  fire_at    TEXT NOT NULL,                           -- UTC ISO; tz-correct via lib/tz
  status     TEXT NOT NULL DEFAULT 'pending',         -- pending | fired | snoozed | cancelled
  source     TEXT NOT NULL DEFAULT 'manual',          -- manual | auto (auto = recurrence-minted, §4b)
  fired_at   TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CHECK ((task_id IS NULL) <> (block_id IS NULL))     -- exactly one target
);
CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(status, fire_at);
```

Drizzle definitions mirror these in `schema.ts` (ids `text('id').primaryKey()
.$defaultFn(newId)`; `owner_id`/`task_id`/`block_id` as `text(...).references(...)`).
The migration also **seeds the dispatcher job with an explicit id**:

```ts
import { newId } from '../../lib/ids.js';
db.prepare(`INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron)
            VALUES (?, 'fire_reminders', 'fire_reminders', '* * * * *')`).run(newId());
```

Routes (owner-scoped via `currentOwnerId()`; single-owner injects `SYSTEM_OWNER_ID`,
Phase I adds the real resolver):
- `POST /api/push/subscribe` — upsert by `endpoint`; `DELETE /api/push/subscribe` —
  remove on unsubscribe.
- `GET /api/push/vapid-key` — returns `{ key: VAPID_PUBLIC_KEY }`.
- `POST /api/reminders` `{ taskId | blockId, fireAt }`, `DELETE /api/reminders/:id`
  (→ `cancelled`), `POST /api/reminders/:id/snooze` `{ minutes }`.

**Target-state validation (new).** A reminder only makes sense on something with a
time. The route **rejects** a `blockId` whose `block_type` is `someday` or `saved`
(only `scheduled` blocks have a `fire_at`-able instant); a `taskId` must be
owner-owned and not done/cancelled. The SQLite `CHECK` enforces *exactly one target*;
the cross-table state check is **app-enforced** in the route (CHECK can't see other
tables).

Computing `fire_at`: a UI offset ("15 min before") or wall-clock time resolves
through `zonedWallTimeToUTC(date, 'HH:MM', prefs.timezone)` (or `dueAt − offset`),
stored as UTC ISO — never `${date}T${time}Z`.

### 4a. The cron dispatcher  *(exactly-once core — unchanged logic, string ids)*
The seeded `fire_reminders` row is picked up by the existing `startCronJobs()` loop
(no croner change). Add the case to `execute()` in `jobs/index.ts`:

```ts
case 'fire_reminders': {
  const now = new Date().toISOString();
  // claim-by-update: the UPDATE is the lock → a reminder transitions pending→fired only once
  const due = sqlite.prepare(
    `UPDATE reminders SET status='fired', fired_at=?
       WHERE id IN (SELECT id FROM reminders WHERE status='pending' AND fire_at <= ?)
       RETURNING id, owner_id, task_id, block_id`).all(now, now) as Due[];
  for (const r of due) await deliver(r);      // SSE + push
  return { itemsCreated: 0, itemsUpdated: due.length, log: `Fired ${due.length} reminders` };
}
```

The atomic `UPDATE … RETURNING` (better-sqlite3 is synchronous, single-writer)
guarantees **exactly-once**: only rows still `pending` flip to `fired`, so the next
tick re-selects nothing. `deliver()` emits the in-app event first, then attempts push:

```ts
async function deliver(r: Due) {
  broadcast(r.owner_id, 'reminder:fire', { id: r.id, taskId: r.task_id, blockId: r.block_id });
  for (const s of subsFor(r.owner_id)) {
    const res = await sendPush(s, payloadFor(r));
    if (res === 'gone') deleteSub(s.id);       // dead sub pruned; already delivered in-app
  }
}
```

Because SSE fires unconditionally before push, **push failure (or push denied / no
subscription) falls back to in-app** automatically — no extra branch.

### 4b. Recurrence hook — reminders for recurring Tasks, Time Blocks & Routines  *(gated on CON-4)*
This **absorbs the former "H4 pattern bridge."** H does not expand RRULEs; instead it
**hooks the one place CON-4 materializes an occurrence** (the concurrency-safe lazy
placement on `GET`, plus any nightly generate job). When an occurrence is created, the
hook mints **one `reminders` row** (`source='auto'`) for it iff the source opts in:
- **Recurring Task / Habit** (Habit = Task subtype): if the task carries a remind
  offset, attach the reminder to the materialized **instance's** `task_id`. Habits
  need **no special path** — they are tasks.
- **Recurring bare Time Block** (needs CON-4's `time_blocks.recurrence_rule`): attach
  to the materialized **scheduled** block's `block_id`.
- **Routine**: a Routine recurs by *placing its member tasks*; reminders attach to
  those placed `task_id`s when `pattern_types.notify` is set, using the offset(s) in
  `pattern_types.reminder_config` (H owns this JSON shape — start minimal:
  `{ "offsetMinutes": 15 }`).

**Idempotency is mandatory** — lazy placement runs on every relevant `GET`. Mint with
a null-safe guard so re-materialization never double-inserts:

```sql
INSERT INTO reminders (id, owner_id, task_id, block_id, fire_at, source)
SELECT ?, ?, ?, ?, ?, 'auto'
 WHERE NOT EXISTS (
   SELECT 1 FROM reminders
    WHERE task_id IS ? AND block_id IS ? AND fire_at = ? AND source='auto');
```

(A partial `UNIQUE` index is awkward here because the two target columns are nullable
and SQLite treats `NULL`s as distinct; the `WHERE NOT EXISTS` with `IS` is the clean
guard.) **Pre-CON-4 fallback:** only Task-level recurring reminders (via the existing
Phase E task engine) are possible; bare recurring-Time-Block reminders and the
single-hook cleanliness require CON-4. **H should land after CON-4** to avoid wiring
into the soon-retired `0025` pattern path.

### 5. Snooze  *(unchanged logic, string ids)*
Snooze reschedules the *same* row forward and re-arms it:

```ts
// POST /api/reminders/:id/snooze {minutes}
sqlite.prepare(
  `UPDATE reminders SET fire_at=?, status='pending', fired_at=NULL
     WHERE id=? AND owner_id=?`).run(addMinutes(now, minutes), id, currentOwnerId());
```

Pushing `fire_at` out and resetting `status` to `pending` **cancels the original
firing** (it is already `fired`, so the old instant never re-triggers) and schedules
exactly one new firing. `broadcast(owner, 'reminder:snoozed', { id, fireAt })` updates
open clients.

### 6. Permission flow & facet UI  *(opt-in, non-blocking)*
The app must fully function with push **denied or unsupported**:
1. SW registers on load regardless of notification permission (§1).
2. A **Settings** toggle (not an on-load prompt) calls `Notification.requestPermission()`;
   only on `granted` do we `pushManager.subscribe(...)` and `POST /api/push/subscribe`.
3. If `Notification.permission !== 'granted'` or `'serviceWorker'`/`'PushManager'` are
   absent → hide the toggle, rely on in-app SSE. Install/use is never gated on push.
4. Unsubscribe in Settings → `subscription.unsubscribe()` + `DELETE /api/push/subscribe`.
5. **Facet authoring (no new noun):** "Remind me at…" lives on the **Task** editor and
   the **scheduled Time Block** editor (`BlockEditModal`); per-Routine-type defaults
   live under Routines settings (`pattern_types.notify` + `reminder_config`). Firing
   surfaces a transient toast on the SSE `reminder:fire` channel — **no "Reminders"
   nav/screen.**

## Tests
- **`reminders.test.ts` — fires exactly once:** seed a `pending` reminder with
  `fire_at <= now`; run `fire_reminders` → status `fired`, **one** `reminder:fire`
  broadcast; run the tick **again** → zero rows, **no second fire**. (String ids.)
- **tz-correctness:** a "09:00 local" reminder in `America/Los_Angeles` stores the UTC
  instant from `zonedWallTimeToUTC` (not naive `Z`) and is not due before it; assert
  across a DST boundary.
- **snooze:** snooze a `fired` reminder 10m → `pending`, `fire_at` advanced,
  `fired_at` null; the original instant never re-fires; exactly one fire after.
- **push fallback:** stub `sendPush` → `'fail'` ⇒ in-app `reminder:fire` SSE still
  emitted (owner-scoped); `'gone'` deletes the subscription row.
- **owner isolation:** a reminder for owner A broadcasts only to A's SSE stream and
  A's push subs (reuse the owner-isolation harness; string owner ids).
- **target-state validation (new):** `POST /api/reminders` with a `someday`/`saved`
  `blockId` → 400; a `scheduled` block → 201.
- **recurrence-hook idempotency (new, gated on CON-4):** materializing the same
  occurrence twice (two lazy `GET`s) yields **one** `source='auto'` reminder; a
  recurring habit instance gets a reminder via the Task path with no special-casing.
- **CHECK constraint:** a reminder with both `task_id` and `block_id` (or neither) is
  rejected.
- **SW does not break install (Playwright):** with `/sw.js` served, the PWA still
  installs and loads after a hard reload (no precache-stranded blank screen);
  registration failure (404 stub) does not throw or block mount.
- **Standing suites green** (push **denied** is the default headless case). Baseline to
  hold: the current `main` suite (CON-3 was **server 263 / client 106**; #77 adds
  task-view + tag-level tests on top) — match the then-current counts; CON-4 raises
  them again.

## Acceptance criteria
1. A real SW registers at scope `/`; the manifest install path still works — **app
   installs and loads with push denied**.
2. Web Push delivers when backgrounded; in-app SSE when open; **both** for a
   foregrounded subscriber is fine (notification `tag` de-dupes).
3. A reminder fires **exactly once** at its tz-correct `fire_at` — never twice across
   consecutive ticks.
4. **Snooze** moves the next fire and cancels the original; no double-fire.
5. **Push failure / no subscription falls back to in-app** with no lost reminder; dead
   subscriptions (`404/410`) are pruned.
6. `push_subscriptions` + `reminders` are owner-scoped, **TEXT UUIDv7**, added via mig
   **`0036`** through the runner (ids minted with `newId()` in the seed); full suite
   green.
7. **No new top-level noun** — reminders are a Task/Time-Block facet (GLOSSARY budget
   intact); reminder targets are validated to time-bearing entities (`scheduled`
   blocks, live tasks).
8. **Recurring/Routine reminders** (once CON-4 lands) are minted **idempotently** per
   materialized occurrence; habits reminded via the Task path.

## Risks / notes
- **CON-4 is a hard prerequisite for recurring/Routine reminders.** If H must ship
  before CON-4, restrict scope to one-off + Task-level recurring reminders and defer
  §4b's block/Routine paths — do **not** wire into the `0025` pattern RRULE that CON-4
  retires.
- **Noun budget.** Reminder must stay a facet; adding a "Reminders" noun would require
  retiring one per the GLOSSARY governance rule.
- **Migration id minting.** Seed/insert rows in the migration with explicit `newId()`
  — the bare migrate connection has no `$defaultFn` and no `uuid7()` UDF (CON-3
  lesson).
- **Recurrence re-materialization.** Lazy placement runs often; the `source='auto'`
  null-safe `WHERE NOT EXISTS` guard is what keeps it idempotent. A bug here = repeated
  reminders.
- **SW caching can strand installs.** The #1 PWA footgun is a precache SW serving a
  stale `index.html`/old JS. Use **read-through cache only** (no precache manifest, no
  Workbox `precacheAndRoute`); serve `/sw.js` with `Cache-Control: no-cache` +
  `Service-Worker-Allowed: /`. This is why we hand-write the SW.
- **Dispatcher granularity = 1 min.** A reminder fires on the first tick at/after
  `fire_at` (slightly late, never early, never twice).
- **Missed ticks while down.** `fire_at <= now` means reminders due during downtime all
  fire on the next boot tick — correct but a long outage produces a burst; acceptable
  for v1.
- **VAPID keys are deployment identity.** Rotating them invalidates every subscription.
  Generate once per install; document in README; never commit. Missing keys → push
  disabled, in-app still works.
- **Payload privacy.** Keep payloads minimal (`{title, body, tag, url}`), no sensitive
  detail — fetch full context on click. `userVisibleOnly: true` is mandatory in
  Chromium (no silent push), which matches our "always show a notification" model.

## Effort
**M** — ~3–4 days. The deterministic core (migration + claim-by-`UPDATE` dispatcher +
snooze) is small and well-bounded; most of the time is the SW lifecycle,
VAPID/`web-push` wiring, the permission-flow UI, and the install-not-broken Playwright
check. The recurrence hook (§4b) folds in the old H4 and is small **given CON-4**.

## PR breakdown / fan-out
H fans out to **2 parallel lanes + a join** (full briefs: [H-fanout-briefs.md](H-fanout-briefs.md)).
The lanes touch **disjoint files**, so A ∥ B is true parallel work.
1. **Lane A — server core** (mig `0036`, `lib/push.ts` + `web-push` + VAPID env,
   push/reminder routes with target-state validation, `fire_reminders` dispatcher +
   `deliver()`, `reminders.test.ts`). **Lane A2** (recurrence hook §4b) is a thin
   add-on **gated on CON-4**.
2. **Lane B — service-worker shell** (`client/public/sw.js`, `register.ts` →
   `main.tsx`, the `koa-static` headers in `app.ts`, install-not-broken Playwright
   test). **Untouched by all of CON-1…5** — safe to build anytime.
3. **Lane C — integration join** (Settings toggle + subscribe/unsubscribe,
   `vapid-key` fetch, the `reminder:fire` toast, the snooze control, and the
   "Remind me at…" facet inputs on Task/Time-Block editors). Depends on A + B.

Splitting keeps the deterministic server core (where the exactly-once guarantee lives)
independently testable before any SW/browser surface lands.
