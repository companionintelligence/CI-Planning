# H — Fan-out briefs (Lane A / B / C)

Handoff briefs for building **Phase H** ([H-notifications-webpush.md](H-notifications-webpush.md))
as parallel lanes. Each brief is self-contained — an agent can pick one up cold.

## Base & sequencing
- **Branch off `main`** (HEAD `7fb071e`; #77 + CON-1/2/3/5 merged) once **CON-4**
  (recurrence unify, reserved mig `0034`, *currently unbuilt — no branch*) lands. H's
  migration is **`0036_notifications`**.
- **Identity is UUIDv7** (CON-1): ids are **opaque TEXT strings** — never `Number(id)`.
  Use `newId()` from `server/src/lib/ids.ts` for TS-side / migration minting (the
  bare migrate connection has no `$defaultFn` and no `uuid7()` UDF — CON-3 lesson).
- **Reminder is a facet, not a noun** (GLOSSARY budget = 8). No "Reminders"
  screen/nav; author on Task / scheduled Time Block; surface a toast on fire.
- **Verification ritual (every PR):**
  `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT` →
  server `pnpm test` + client tests + `pnpm typecheck` + `migrate.test.ts` green.
  Baseline to hold: the current `main` suite green (CON-3 was server 263 / client 106;
  #77 adds more — match the then-current counts; CON-4 raises them again).

## Frozen contracts (freeze these first; all three lanes import them)
These are the only seams between lanes — agree them up front and A ∥ B can't diverge.
1. **Push payload:** `{ title: string, body: string, tag: string, url: string }`
   — produced by Lane A `payloadFor()`, consumed by Lane B `sw.js` `push` handler.
2. **SW URL & scope:** file at `/sw.js`, scope `/`, served `Service-Worker-Allowed: /`
   + `Cache-Control: no-cache`. (Lane B owns both the file and the headers.)
3. **SSE events:** `reminder:fire` `{ id, taskId, blockId }` and `reminder:snoozed`
   `{ id, fireAt }` — emitted by Lane A, consumed by Lane C. (Owner-scoped `broadcast`.)
4. **REST surface** (Lane A implements, Lane C calls), owner-scoped via
   `currentOwnerId()`:
   - `GET /api/push/vapid-key` → `{ key }`
   - `POST | DELETE /api/push/subscribe` `{ endpoint, p256dh, auth, userAgent? }`
   - `POST /api/reminders` `{ taskId | blockId, fireAt }` (validates target state)
   - `DELETE /api/reminders/:id` (→ `cancelled`)
   - `POST /api/reminders/:id/snooze` `{ minutes }`

---

## Lane A — server core  *(the deterministic core; no client surface)*
**Goal.** The exactly-once reminder engine + Web Push plumbing, fully testable headless.

**Files (all server-side; disjoint from B & C):**
- `server/src/db/migrations/0036_notifications.ts` (+ register in `migrations/index.ts`)
- `server/src/db/schema.ts` — add `pushSubscriptions` + `reminders` Drizzle tables
- `server/src/lib/push.ts` (new) — `sendPush()` wrapper around `web-push`
- `server/src/lib/config.ts` — add `vapidPublicKey` / `vapidPrivateKey` / `vapidSubject`
- `server/src/routes/push.ts` + `server/src/routes/reminders.ts` (new) →
  mount in `server/src/routes/index.ts`
- `server/src/jobs/index.ts` — add the `fire_reminders` case to `execute()` + `deliver()`
- `package.json` — `web-push` dep; `.env.example` + README — VAPID keys
- `server/test/reminders.test.ts` (new)

**Build.** Per [H spec §2–§5](H-notifications-webpush.md): TEXT UUIDv7 tables (mint
ids with `newId()`); seed the `fire_reminders` `scheduled_jobs` row with an explicit
`newId()` id and cron `'* * * * *'`; claim-by-`UPDATE … RETURNING` dispatcher
(exactly-once); `deliver()` = SSE first, then push, prune `410/404`; snooze re-arms the
row. **Target-state validation:** reject a `blockId` that isn't `scheduled`; require a
live owner-owned `taskId`.

**Dependencies.** None within H (this is the root); branch off current `main`. CON-4
gates only Lane A2.

**Acceptance / tests.** `reminders.test.ts`: exactly-once (run tick twice), tz across
DST, snooze (no double-fire), push-fail→in-app fallback + `gone` prunes sub, owner
isolation, target-state 400/201, CHECK rejects 0/2 targets. Suite green.

### Lane A2 — recurrence hook  *(thin add-on; GATED on CON-4)*
**Goal.** Mint one `source='auto'` reminder per materialized occurrence (recurring
Task/Habit, recurring scheduled Time Block, Routine-placed member tasks), **idempotently**.
**Files.** The CON-4 placement path (`server/src/engine/recurrence-*.ts` /
`autoplan.ts` lazy-placement) + `pattern_types.reminder_config` reader.
**Build.** [H spec §4b](H-notifications-webpush.md): null-safe `WHERE NOT EXISTS`
guard; read `pattern_types.notify` + `reminder_config` (H owns the JSON shape — start
`{ "offsetMinutes": 15 }`). Habits need no special path (Task subtype).
**Acceptance.** Materialize twice → one reminder; habit instance reminded via Task path.
**Do not start before CON-4** (else you wire into the `0025` path CON-4 retires).

---

## Lane B — service-worker shell  *(parallel to A; untouched by CON-1…5)*
**Goal.** A real SW that receives push + routes clicks, registered additively, without
breaking the read-cache install path.

**Files (disjoint from A & C):**
- `client/public/sw.js` (new) — `push` + `notificationclick` only; read-through cache,
  **no precache manifest**
- `client/src/sw/register.ts` (new) — `registerSW()`, never throws
- `client/src/main.tsx` — call `registerSW()` after mount
- `server/src/app.ts` — serve `/sw.js` with `Service-Worker-Allowed: /` +
  `Cache-Control: no-cache` (ahead of the SPA fallback)
- `tests/container/sw-install.spec.ts` (new) — Playwright install-not-broken

**Build.** Per [H spec §1](H-notifications-webpush.md). The `push` handler consumes the
**frozen payload** `{ title, body, tag, url }`. The cache must be read-through only.

**Dependencies.** None — does not touch ids, vocabulary, recurrence, or Lane A's
routes. **Safe to start anytime** (only CON-4 is still pending, and B doesn't need it).

**Acceptance / tests.** PWA still installs + loads after a hard reload with `/sw.js`
served; a 404-stubbed registration does not throw or block mount; SW controls scope `/`.

---

## Lane C — integration join  *(needs A + B)*
**Goal.** The opt-in permission flow + the reminder facet UI + live fire toast.

**Files:**
- `client/src/views/Settings.tsx` — push permission toggle; subscribe/unsubscribe
- `client/src/lib/push-client.ts` (new) — `vapid-key` fetch, `pushManager.subscribe`,
  POST/DELETE subscribe
- `client/src/lib/api.ts` — reminder + push client methods (string ids)
- Task editor + `BlockEditModal` — **"Remind me at…"** facet inputs (scheduled blocks
  only); per-Routine-type defaults under Routines settings
- SSE consumer — `reminder:fire` → transient toast; `reminder:snoozed` → update
- client component tests

**Build.** Per [H spec §6](H-notifications-webpush.md). Strictly opt-in, non-blocking:
the app fully functions with push **denied or unsupported** (hide the toggle, rely on
in-app SSE). **No "Reminders" nav/screen** — facet only.

**Dependencies.** Lane A (routes + SSE events) **and** Lane B (a registered SW to
`pushManager.subscribe` against).

**Acceptance / tests.** Toggle subscribes only on `granted`; unsubscribe removes the
sub; a fired reminder shows a toast over SSE; reminder inputs reject non-`scheduled`
blocks in the UI; suite green with push denied.

---

## Recommended launch order
1. **Freeze the 4 contracts** above (a 30-min stub PR landing the `PushPayload` type +
   event-name constants + route signatures de-risks the whole fan-out).
2. **Lane B now** (CON-independent) ∥ **Lane A** off current `main`.
3. **Lane C** when A + B land. **Lane A2** when CON-4 lands.
