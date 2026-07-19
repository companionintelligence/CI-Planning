> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/onboarding-connect-sync`
> **Commit style:** `feat(onboarding): connect source + first sync`
> **Design:** this ticket is the spec (see also `docs/ftue-plan.md` §5 steps 3 & 5, and the empty-state fallback)
> **Dependencies:** T11 (the onboarding wizard shell). T12 fills T11's Step 3 (Connect a source) and Step 5 (Run first sync) slots and relies on this contract from T11:
> - A wizard component that renders while onboarding is incomplete, **regardless of route** (so an OAuth round-trip that lands on `/settings` still shows the wizard on top).
> - A per-step render slot for Step 3 and Step 5, and a way to advance the current step.
> - A store-level open helper `openOnboardingAt(step: number)` (used by the empty-state CTA to jump back to the connect step). If T11 has not landed this exact helper, T12 adds a minimal `[onboardingStep, setOnboardingStep]` signal in `client/src/stores/index.ts` and wires the wizard to it — do NOT create a second competing open-signal.

> ### 🚧 LIVE — issue #348, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.

## Goal

Complete the FTUE wizard's data-in half: (Step 3) let the user **connect a Google account** by embedding the already-shipped OAuth connect flow, plus a **"Try with sample data"** fixture path so the app is never empty; (Step 5) **run the first sync immediately** — trigger the ingest jobs now instead of waiting for the 06:30 cron — so the payoff (Inbox filled, meetings mirrored, day blocked) lands in the same session; and add a **systematic empty-state CTA** ("Connect a source to fill this automatically") to the empty Focus / Today / Tasks views that links back to the connect step.

## Non-goals (fence off adjacent work)

- Do **not** write any new OAuth implementation. Reuse the shipped Google connect end to end: `GET /api/oauth/google/start` → browser navigates to Google → `GET /api/oauth/google/callback` stores the token and 302s to `/settings?google=connected` (both in `server/src/routes/oauth.ts`, callback is already in `PUBLIC_PREFIXES`). Do **not** change the callback's redirect target, the token store, scopes, or PKCE.
- Do **not** change any ingest / extraction / placement logic. T12 only *triggers* existing jobs (`runJob(kind)`), it does not touch `agents/ingest.ts`, `engine/autoplan.ts`, or the `execute()` switch bodies.
- Do **not** build the multi-account connect loop (that is a later Wave-5/6 item — `docs/ftue-plan.md` gap 8). Connect exactly one account via the existing single-account flow.
- Do **not** build the trust-dial (Step 4) here — that is a separate ticket. T12 sits on either side of it (Step 3 and Step 5).
- Do **not** add a DB migration. This ticket needs no schema (see Schema required).

## Pinned conventions

- **Manual-run route — verified.** The only existing manual trigger is `POST /api/jobs/:id/run` in `server/src/routes/jobs.ts`, which is **admin-gated** (`requireAdmin`, line 19-24), takes a **system `scheduled_jobs` id**, and fires **one** job (`runJob(res.job.kind).catch(...)`, fire-and-forget). There is **no** `run-now` route today (`grep -rn "run-now" server client` → empty). It is the wrong shape for FTUE (admin-only, single id, no await). T12 adds a **new** owner-scoped `POST /api/jobs/run-now` — see below.
- **Owner scoping / auth.** Every `/api/*` route sits behind `requireAuth()` (`server/src/lib/auth/requireAuth.ts`), which turns the credential into an owner via `runWithOwner` and enforces `planning:read` on GET / `planning:write` on mutations (`hasScope`, `server/src/lib/auth/scopes.ts`). `run-now` runs the **current owner's own** ingest, so it is gated by ordinary **write scope (POST), NOT admin** — this matches the existing comment in `server/src/jobs/index.ts:405-406` ("a user 'run now' is for their own account", does not fan out). `currentOwnerId()` is already bound by the time the handler runs.
- **runJob is the reuse seam.** `server/src/jobs/index.ts` → `execute(kind)` (switch, line 69) + `runJob(kind)` (line 327; records a `job_runs` row and broadcasts `job:started`/`job:run` over SSE). In test/fixture mode ingest reads `server/test/fixtures/{emails,calendar}.json` via `createFixtureGoogleClient` (`server/src/mcp/google.ts`, the `else` branch at lines 91-93 / 117-119). Do not reimplement any of this.
- **google mode is a global config singleton.** `config.google.mode` is `'live' | 'fixture' | 'off'`, env-pinned when `GOOGLE_MODE` is set (`config.ts:185-186`). The in-app setup (`server/src/services/google-config.ts`, persisted in the `app_config` table from mig 0124) is the ONLY runtime way to change it, and it currently only flips **live**/off. T12 extends it minimally to also flip **fixture** (the `GoogleConfigState.mode` type already includes `'fixture'`). It stays **admin-gated** (`server/src/routes/google-config.ts`) — the FTUE bootstrap owner is an operator (admin) per Phase AG, so the first-run user can use it; a non-admin member sees the sample-data action disabled.
- **integrations() is the client's connection truth.** `client/src/stores/index.ts:297` exposes `integrations` (from `GET /api/integrations`, shape `Integrations` in `client/src/lib/api.ts:915-919`): `google.mode`, `google.liveEnabled` (`=== 'live'`), `google.connections: ConnectionHealth[]` (each `status: 'connected' | 'expired' | 'inactive'`). Fail-closed while loading (mirror `aiAvailable` at `stores/index.ts:302`).
- **Existing connect UI to mirror, not duplicate.** `client/src/views/Settings.tsx` `connectGoogle()` (lines 418-430) fetches `/api/oauth/google/start` and `window.location.href = data.url`; `onMount` (lines 400-414) reads `?google=connected|error`, toasts, and strips the param. T12 lifts the start/disconnect calls into typed `api.oauth.*` client methods and reuses that param-handling in the wizard's connect step.
- **Server tests** live in `server/test/**/*.test.ts` (vitest `include: ['test/**/*.test.ts']`); the suite pins `GOOGLE_MODE=fixture` and shares one sequential DB — so a test exercising the in-app fixture toggle must first set `config.google.envPinned = false` / `config.google.mode = 'off'` and restore after (exactly the pattern in `server/test/google-config.test.ts:41-66`). Non-admin credential in a test = header `{ 'x-test-scopes': 'planning:read,planning:write' }`; read-only = `{ 'x-test-scopes': 'planning:read' }`. **Client** pure-logic tests are `client/src/**/*.test.ts` (node); component tests are `*.test.tsx` (jsdom).

## Before implementation

Read these to match reality:

- `server/src/routes/oauth.ts` — the connect flow being embedded (start returns `{ url }`; callback redirects to `/settings?google=connected`).
- `server/src/routes/jobs.ts` (admin `/:id/run`) and `server/src/jobs/index.ts` (`execute`, `runJob`, `OWNER_SCOPED_KINDS`, the per-owner comment at 397-406) — the trigger seam.
- `server/src/services/google-config.ts` (`saveGoogleConfig`, `hydrateGoogleConfig`, `readAppGoogleConfig`, `GoogleConfigState`) and `server/src/routes/google-config.ts` — the fixture toggle host.
- `server/src/routes/llm.ts` (`GET /api/integrations`) + `server/src/lib/connections.ts` (`ConnectionHealth`) — the connection-status contract.
- `client/src/views/Settings.tsx` (connect/disconnect + `?google=` handling + the admin `gcfg` probe pattern at ~line 298), `client/src/lib/api.ts` (`jobs`, `googleConfig`, `Integrations`, `ConnectionHealth`), `client/src/stores/index.ts:289-302` (`integrations`, `aiAvailable`).
- `client/src/views/Focus.tsx:334-338`, `client/src/views/Today.tsx:249` & `:455`, `client/src/views/AllTasks.tsx:344` — the empty states to augment.
- `server/test/google-config.test.ts` — the config-override test pattern to copy.
- The T11 wizard component (assumed `client/src/views/Onboarding.tsx` — **confirm the exact path/exports against the merged T11 at implementation time**).

## Files impacted

**New:**
- `client/src/components/onboarding/ConnectSourceStep.tsx` — Step 3 body: Connect Google + Try-with-sample-data + connection status.
- `client/src/components/onboarding/RunFirstSyncStep.tsx` — Step 5 body: "Run my first sync now" → `api.jobs.runNow()` + result summary.
- `client/src/components/EmptyStateConnectCTA.tsx` — the reusable "Connect a source to fill this automatically" prompt + button.
- `client/src/lib/onboarding.ts` — pure, node-testable helpers: `FTUE_RESUME_KEY`, `shouldShowConnectCTA(integrations)`, `hasConnectedSource(integrations)`.
- `server/test/run-now.test.ts` — `POST /api/jobs/run-now` behavior + scope gate.
- `client/src/lib/onboarding.test.ts` — helper truth table.

**Changed:**
- `server/src/jobs/index.ts` — export `RUN_NOW_KINDS` + `runIngestNow()`; make `runJob` **return** the outcome it already computes (currently `void`) so `runIngestNow` can collect per-kind results (all existing callers ignore the return — safe).
- `server/src/routes/jobs.ts` — add owner-scoped, write-gated `POST /api/jobs/run-now` (registered **before** `/:id/run`) that awaits `runIngestNow()`.
- `server/src/services/google-config.ts` — add fixture-mode support (`KEY_MODE` marker + `mode?` param + hydrate branch).
- `server/src/routes/google-config.ts` — accept/validate optional `mode: 'live' | 'fixture'` on PUT, thread to `saveGoogleConfig`.
- `client/src/lib/api.ts` — add `oauth.googleStart` / `oauth.googleDisconnect`; add `jobs.runNow`; extend `googleConfig.save` body with `mode?: 'live' | 'fixture'`; add `RunNowOutcome` interface.
- `client/src/stores/index.ts` — add `hasConnectedSource()` getter (delegates to the pure helper); add the minimal `[onboardingStep, setOnboardingStep]` signal only if T11 has not already exported an open helper (see Dependencies).
- `client/src/views/Settings.tsx` — refactor `connectGoogle` / `disconnectGoogle` to call the new `api.oauth.*` methods (dedupe; also fixes the standalone-mode raw-`fetch` credential gap). No behavior change.
- The T11 wizard component (assumed `client/src/views/Onboarding.tsx`) — render `<ConnectSourceStep/>` in Step 3 and `<RunFirstSyncStep/>` in Step 5; add OAuth-return resume handling (read `FTUE_RESUME_KEY` + `?google=` param, toast, advance, strip param + clear marker).
- `client/src/views/Focus.tsx`, `client/src/views/Today.tsx`, `client/src/views/AllTasks.tsx` — render `<EmptyStateConnectCTA/>` in the empty branches when `shouldShowConnectCTA(integrations())`.

## Schema required

**None.** No migration. The fixture toggle persists under a new **key** (`'google_mode'`) in the existing `app_config` table (added by mig 0124), using the same `INSERT ... ON CONFLICT` upsert `saveGoogleConfig` already uses — no DDL, no new column, no new table. (For reference, the next free migration slot on main is **0127**; T12 does not consume it.)

## Definition of Done

- [ ] `POST /api/jobs/run-now` exists in `server/src/routes/jobs.ts`, is gated by ordinary write scope (NOT `requireAdmin`), runs under `currentOwnerId()`, awaits `runIngestNow()`, and returns `{ ok: true, ran: RunNowOutcome[] }`. It is registered before `POST /api/jobs/:id/run` so the paths don't collide.
- [ ] `runIngestNow()` in `server/src/jobs/index.ts` awaits `runJob(kind)` for each of `RUN_NOW_KINDS = ['sync_calendar', 'ingest_gcal', 'ingest_gmail', 'nightly_grooming']` (that order) and returns one `{ kind, status, itemsCreated, itemsUpdated, log }` per kind. `runJob` now returns that object; all existing call sites still compile.
- [ ] `saveGoogleConfig({ enabled: true, mode: 'fixture' })` sets `config.google.mode = 'fixture'` **without** requiring a `clientId` or a KEK, persists the `'google_mode' = 'fixture'` marker, and survives a `hydrateGoogleConfig()` (boot) round-trip. `saveGoogleConfig({ enabled: false })` (or `mode: 'live'`) clears the marker and returns to `off`/`live` as before. `mode` defaults to `'live'` so existing callers are unchanged.
- [ ] `PUT /api/google-config` accepts an optional `mode: 'live' | 'fixture'`, validates it (400 on any other value), and stays admin-gated + env-pinned-aware (409 when `GOOGLE_MODE` is env-set).
- [ ] `api.oauth.googleStart()`, `api.oauth.googleDisconnect(account)`, and `api.jobs.runNow()` exist in `client/src/lib/api.ts` and go through the credentialed `request(...)` helper (so they carry `x-api-key`/session, unlike the old raw `fetch`). `Settings.tsx` uses them.
- [ ] Wizard Step 3 (`ConnectSourceStep`): a primary **"Connect Google"** action (enabled only when `integrations().google.liveEnabled`) that sets `localStorage[FTUE_RESUME_KEY]` then navigates to the URL from `api.oauth.googleStart()`; a secondary **"Try with sample data"** action (admin only — probe `api.googleConfig.get()`, a 403 → null → hide/disable) that saves fixture mode, refetches integrations, and runs a first sync; and a live list of connected accounts with `status`.
- [ ] Wizard Step 5 (`RunFirstSyncStep`): a **"Run my first sync now"** button that calls `api.jobs.runNow()`, shows a busy state, then refetches `tasks`/`blocks`/`flightPlan`/`integrations` and renders a one-line summary (e.g. "Pulled N items into your day"). If there is no connected source and mode isn't fixture, it explains the sync will be a no-op and links back to Step 3.
- [ ] OAuth-return resume: because T11's wizard shows on any route while onboarding is incomplete, after the callback lands on `/settings?google=connected|error`, the wizard (with `FTUE_RESUME_KEY` set) toasts the outcome, advances past Step 3, strips the `google`/`reason` params, and clears the marker — the user never actually interacts with the Settings page.
- [ ] Empty-state CTA: `Focus.tsx` (empty branch at 334-338), `Today.tsx` (the "Nothing scheduled yet." fallback at 249 and "Nothing due this day." at 455), and `AllTasks.tsx` ("No tasks found." at 344) render `<EmptyStateConnectCTA/>` **only when** `shouldShowConnectCTA(integrations())` is true (i.e. no `connected` account and mode ≠ `fixture`); otherwise the existing "all done"/"nothing" copy is unchanged. The CTA button calls `openOnboardingAt(3)` (or the T11-provided open helper).
- [ ] `shouldShowConnectCTA` / `hasConnectedSource` are pure functions in `client/src/lib/onboarding.ts` and fail-closed on `undefined` integrations (CTA hidden while loading).
- [ ] `pnpm --filter server typecheck`, `pnpm --filter server test`, `pnpm --filter client typecheck`, `pnpm --filter client test`, and `pnpm --filter client build` all pass.

## Tests

- [ ] `server/test/run-now.test.ts` — `POST /api/jobs/run-now` with the default (write-bearing) test credential returns `{ ok: true, ran: [...] }` whose `kind`s are exactly `RUN_NOW_KINDS`, and inserts `job_runs` rows for them.
- [ ] `server/test/run-now.test.ts` — the same POST with `{ 'x-test-scopes': 'planning:read' }` returns **403** (write gate), and does NOT require admin (a `planning:read,planning:write` credential succeeds).
- [ ] `server/test/run-now.test.ts` — under the pinned `GOOGLE_MODE=fixture`, the run produces possibles (assert the `ingest_gmail`/`ingest_gcal` entries' `log` reports processed items, or that the `possibles` row count increased for the owner).
- [ ] `server/test/google-config.test.ts` (extend) — with `envPinned=false`, `saveGoogleConfig({ enabled: true, mode: 'fixture' })` returns `ok` with `state.mode === 'fixture'`, sets `config.google.mode === 'fixture'`, needs no `clientId`/KEK, and `hydrateGoogleConfig()` re-derives `'fixture'` from `app_config`; then `saveGoogleConfig({ enabled: false })` returns to `mode === 'off'`.
- [ ] `server/test/google-config.test.ts` (extend) — `PUT /api/google-config` `{ enabled: true, mode: 'fixture' }` as admin returns `state.mode === 'fixture'`; as a non-admin credential returns 403; an invalid `mode` returns 400.
- [ ] `client/src/lib/onboarding.test.ts` — `shouldShowConnectCTA(undefined) === false`; a `connections: []` + `mode: 'off'` integrations → `true`; one `status: 'connected'` connection → `false`; `mode: 'fixture'` (no connections) → `false`. `hasConnectedSource` matches.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] **Given** a fresh install with a Google OAuth client configured (live-enabled) and onboarding open, **when** the user clicks "Connect Google" in Step 3, **then** the browser navigates to Google's consent screen and, on return, the wizard shows the account as connected and advances — the user never lands on a bare Settings page.
- [ ] **Given** the user clicks "Try with sample data" as an admin, **when** the action completes, **then** `config.google.mode` is `fixture`, a first sync has run, and the following views show fixture-derived content instead of empty states.
- [ ] **Given** Step 5, **when** the user clicks "Run my first sync now", **then** the ingest jobs run immediately (not on cron), the Inbox/Today/Focus populate after the automatic refetch, and a summary line reports what was pulled.
- [ ] **Given** no connected source and `mode !== 'fixture'`, **when** the user opens an empty Focus, Today, or Tasks view, **then** each shows "Connect a source to fill this automatically" with a button that reopens the wizard at Step 3.
- [ ] **Given** a connected account (or fixture mode), **when** a view is empty, **then** the CTA is **not** shown — the existing "all done / nothing scheduled" copy renders instead.
- [ ] **Given** a non-admin member session, **when** they reach Step 3, **then** "Try with sample data" is hidden/disabled with an explanatory hint, and "Connect Google" reflects whether an operator has configured the client.
- [ ] No migration is added; `git diff --stat` shows no new file under `server/src/db/migrations/`.

## Subtasks

1. [ ] `server/src/jobs/index.ts`: change `runJob(kind)` to return `{ kind, status, itemsCreated, itemsUpdated, log }`; add `export const RUN_NOW_KINDS` and `export async function runIngestNow()` that awaits `runJob` per kind and collects results.
2. [ ] `server/src/routes/jobs.ts`: add `POST /api/jobs/run-now` (write-gated, owner-scoped, awaits `runIngestNow()`), registered before `/:id/run`.
3. [ ] `server/src/services/google-config.ts`: add `KEY_MODE` (`'google_mode'`), a `mode?: 'live' | 'fixture'` param on `saveGoogleConfig` (default `'live'`; fixture skips clientId/KEK), and a fixture branch in `hydrateGoogleConfig` (env-pinned → live → fixture-marker → off).
4. [ ] `server/src/routes/google-config.ts`: validate + thread the optional `mode`.
5. [ ] `client/src/lib/api.ts`: add `oauth.googleStart`/`oauth.googleDisconnect`, `jobs.runNow`, `RunNowOutcome`; extend `googleConfig.save` body with `mode?`.
6. [ ] `client/src/lib/onboarding.ts` (+ `onboarding.test.ts`): `FTUE_RESUME_KEY`, `shouldShowConnectCTA`, `hasConnectedSource`.
7. [ ] `client/src/stores/index.ts`: add `hasConnectedSource()`; add the `[onboardingStep, setOnboardingStep]` signal only if T11 didn't provide an open helper.
8. [ ] `client/src/components/onboarding/ConnectSourceStep.tsx`: Connect Google (resume-marker + navigate), Try-with-sample-data (admin-probed; save fixture + refetch + runNow), connection-status list.
9. [ ] `client/src/components/onboarding/RunFirstSyncStep.tsx`: run-now button + busy state + refetch + summary + no-source hint.
10. [ ] `client/src/components/EmptyStateConnectCTA.tsx`: the prompt + button → `openOnboardingAt(3)`.
11. [ ] Wire `ConnectSourceStep`/`RunFirstSyncStep` into the T11 wizard steps; add OAuth-return resume handling.
12. [ ] Add `<EmptyStateConnectCTA/>` (guarded by `shouldShowConnectCTA`) to `Focus.tsx`, `Today.tsx` (both fallbacks), and `AllTasks.tsx`.
13. [ ] Refactor `Settings.tsx` `connectGoogle`/`disconnectGoogle` to the new `api.oauth.*` methods.
14. [ ] Run the five verification commands; fix until green.
