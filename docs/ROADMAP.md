# Companion Planning — Best-in-Class Roadmap

Status: design-approved, **not started**. Phase A (scheduler correctness) is in flight; B–K are sequenced below.

## Principles (apply to every phase)
- **Server-authoritative, offline-tolerant.** SQLite stays the source of truth; clients reconcile.
- **Degrade gracefully.** Every AI/integration feature has a deterministic fallback (matches the existing Ollama/Google pattern).
- **Deterministic core, AI-assist on top.** Placement stays reproducible; the LLM informs selection/ordering only.
- **Additive, reversible migrations.** Requires a real migration runner (we have none — today it's `CREATE TABLE IF NOT EXISTS` only).
- **Test-gated.** No phase merges without its regression suite green.

## Locked decisions
| # | Decision | Choice |
|---|---|---|
| D1 | Auth model | **Single-owner now, owner-scoped data model** so multi-tenant is a later flip |
| D2 | Two-way sync | **Native OAuth connectors in a `connectors/` module + encrypted token store**; agent-bridge stays as fallback |
| D3 | Multi-device sync | **Op-log + last-writer-wins (LWW)**; CRDT rejected, revisit only on real multi-writer conflicts |
| D4 | Auth deployment mode | **SSO-first resource server + standalone mirror** (build both) |

## "ci-server standard" auth — what we are matching
The canonical CI server (`~/devel/ci/CI-Server`, `@ci/ci-server`, NestJS + TypeORM + Apollo) defines the auth standard. Companion Planning is **Koa + Drizzle + better-sqlite3**, so we match the **contract and security semantics, not the framework**.

Two deployment modes:
- **Hub / SSO mode (primary):** Planning is an **SSO resource server** — shares the same HS256 `AUTH_JWT_SECRET`, validates CI-Server-issued Bearer tokens, and delegates OAuth to CI-Server's `connections`/`CloudOAuthProxyService`. One identity + one token store on the appliance.
- **Standalone mode (public Docker image):** Planning runs a faithful local mirror of the contract (own `authenticate` endpoints, sessions, API keys, signup codes, connectors).

**Decided (D4): build both, SSO-first + standalone mirror.** SSO is the primary path on a Hub/Core Server; the standalone mirror covers the public Docker image.

### Best practices verified in CI-Server (adopt as-is)
Source files under `CI-Server/backend/apps/api/src`:
- **Two JWT secrets.** Short-lived **access** token (`auth.jwt.authTokenSecret`/`authTokenExpiration`) + long-lived **refresh/session** token signed with a *separate* `auth.jwt.refreshTokenSecret` (`AuthService`).
- **Access token:** HS256 `Authorization: Bearer`, payload `{ sub: userId }`, zod-validated, `ignoreExpiration:false` (`JwtStrategy`).
- **Session tokens hashed at rest.** Stored as HMAC-SHA256 with a server-side **`session.fieldPepper`** — never plaintext (`AuthService.digest`, `SessionEntity`).
- **Session bound to hashed IP + User-Agent**; mismatches don't match (theft mitigation).
- **Refresh rotation with grace window.** `previous_token` + `rotated_at` + `session.refreshGracePeriod` handles N concurrent refreshes without logging the user out (`AuthService.rotateSessionToken`).
- **UUIDv7** for session/key IDs (time-sortable).
- **API keys:** `randomBytes(32).toString('hex')` (64 hex chars), **5-char prefix** persisted for display, **SHA-256 hash at rest**, `scopes[]`, `expires_at`, `last_used_at` updated on use; raw key shown **once** (`ApiKeyService`). Header `x-api-key`.
- **Passwords:** bcrypt with `auth.local.saltRounds` (standalone mode only) (`UserService`).
- **CSRF:** signed **double-submit cookie** — `randomBytes(32)` + HMAC-SHA256(`auth.csrf.secret`), validated with `timingSafeEqual` on both equality and signature; header `x-csrf-token` (`CsrfService`).
- **Cookie flags:** `httpOnly:true, secure:req.secure, sameSite:'lax', path:'/', maxAge` (`SessionController`).
- **All secret comparisons** use `crypto.timingSafeEqual`.
- **Request-scoped identity** via an `AsyncLocalStorage` context (`ContextService.set({userId})`) + a `SYSTEM_USER` sentinel — identity flows from context, never threaded as a param.
- **DTO validation** via zod (`ValidationPipe`); config namespaced under `config.auth.{jwt,session,cookies,csrf,local}`.
- **Endpoints:** `@Controller('authenticate')` → `GET /authenticate/csrf`, `POST /authenticate` (login), `POST /authenticate/refresh`, `POST /authenticate/logout`.
- **Combined guard** `JwtOrApiKeyAuthGuard` (JWT **or** API key) is the default for protected routes.

### Gaps / additions beyond CI-Server (explicit recommendations)
- **Rate-limit auth endpoints.** CI-Server has **no** app-level throttling; add a Koa rate-limit on `/authenticate*` and api-key validation to blunt brute force.
- **Connection-token encryption (Phase G).** CI-Server encrypts OAuth tokens at rest (`scripts/encrypt-connection-tokens.ts`); the algorithm lives in a shared crypto util — **confirm CI-Server's exact algorithm at build time** and match it (target AES-256-GCM with a KEK from env/Hub keystore).
- **Automation token.** Mirror CI-Server's stable-access-token pattern (`scripts/generate-stable-access-token.ts`) as a scoped `x-api-key` for the agent-bridge fallback (replaces today's open ingest endpoint).

### SQLite/Koa adaptations (since we're not NestJS/Postgres)
- No `timestamptz` → ISO-8601 UTC text (existing convention).
- TypeORM entities → Drizzle tables; repositories → Drizzle queries.
- Guards → Koa middleware (`requireAuth` = the `JwtOrApiKeyAuthGuard` analog).
- `ContextService` → Node `AsyncLocalStorage` in `lib/context.ts`.
- Add a `uuid` (v7) dependency; bcrypt native build is fine under Node 26 (we already build better-sqlite3 natively).

## Phase order & dependencies
| # | Phase | Area | Depends on |
|---|---|---|---|
| A | Scheduler correctness (tz, backfill, split, today-set, AI-assist + briefing cache) | (in progress) | — |
| B | Identity, auth & migration framework | Multi-device/auth (foundation) | A |
| C | Rich task semantics | Task semantics | B |
| D | Time tracking & timers | Time tracking | B |
| E | Recurring tasks & habits | Recurring | B, C |
| F | Calendar grid (2-D, drag/resize, week/month, overlays) | Calendar | B (nicer w/ C, E) |
| G | Two-way calendar sync | Two-way sync | B, F |
| H | Auto-defense (continuous re-plan) | Auto-defense | A, F, G |
| I | Notifications + service worker / Web Push | Notifications | B, C, D |
| J | Rituals & reflection | Rituals/reflection | C, D, E |
| K | Multi-device sync & offline writes | Multi-device/auth (sync) | B, I |

Parallelizable once B lands: **D**, **F**, and **I-infra** alongside C/E.

---

## Phase A — Scheduler correctness (in progress)
**Goal:** fix the five scheduler bugs.
- Timezone: workday hours converted from local wall-clock to UTC via a `lib/tz.ts` (Intl-based); fix `summarize.ts` day bounds and the client `todayRange()` too.
- Backfilling packer: scan all gaps (best-fit), gaps hold multiple blocks.
- Today-set + rolling horizon: capacity-bounded selection; remainder rolls forward.
- Task splitting: multi-session placement, no silently dropped minutes.
- AI-assisted planning + briefing cache (per-day, inputs-hashed) + actionable focus items.

**Regression tests:** PST/UTC/Tokyo place 09:00 *local* blocks; no overlaps; no lost minutes; deterministic output.
**Acceptance:** scheduler is tz-correct, backfills, splits, scopes to a day, and degrades without Ollama.

## Phase B — Identity, auth & migration framework (ci-server-aligned)
**Goal:** replace `ownerId = 1` with a request-scoped owner from a ci-server-compatible token; add a migration runner.

**Components**
- **Migration runner** + `schema_version` table (prereq for all later schema work); idempotent, version-tracked (`pnpm migrate`).
- **`lib/context.ts`** — `AsyncLocalStorage` `RequestContext { ownerId }` + `SYSTEM_OWNER` sentinel.
- **`requireAuth` middleware** (= `JwtOrApiKeyAuthGuard`): accepts `Authorization: Bearer` HS256 JWT `{sub}` **or** `x-api-key`; sets `ownerId`; 401 otherwise. CSRF guard on cookie/session routes.
- **Drizzle tables:** extend `owners`; `sessions` (hashed token + previous_token + rotated_at + hashed ip/ua + expires_at, UUIDv7), `api_keys` (prefix + sha256 hashed_key + scopes + expires_at + last_used_at), `signup_codes`.
- **`authenticate` router (standalone mode):** `GET /authenticate/csrf`, `POST /authenticate`, `POST /authenticate/refresh` (rotation + grace), `POST /authenticate/logout`. **SSO mode:** disabled; validate shared-secret tokens.
- **Two JWT secrets** (access + refresh); session tokens are refresh-secret JWTs hashed (HMAC + `fieldPepper`) at rest.
- **Owner-scoping:** replace hardcoded `1` in `routes/tasks.ts`, `routes/prefs.ts`, `routes/possibles.ts`; authenticate the SSE stream.
- **Config:** `AUTH_MODE=sso|standalone`, `AUTH_JWT_SECRET`, `AUTH_REFRESH_SECRET`, `AUTH_TOKEN_EXPIRY`, `REFRESH_TOKEN_EXPIRY`, `SESSION_FIELD_PEPPER`, `CSRF_SECRET`, cookie names — mirroring `config.auth.*`.
- **Add-ons:** rate-limit `/authenticate*`; bcrypt passwords (standalone); `timingSafeEqual` for all secret compares; zod DTO validation.

**Regression tests**
- Existing Vitest suite passes with `requireAuth` injecting a test owner; every current endpoint 200 with a valid Bearer/api-key, **401 without**.
- A CI-Server-issued JWT (shared secret) authenticates in SSO mode (fixture token).
- Session token is **hashed at rest** (DB never holds the raw token); IP/UA-binding rejects a token replayed from a different UA.
- Refresh rotation issues a new token, invalidates the old outside the grace window, and tolerates concurrent refresh inside it.
- API key: `randomBytes` hex + 5-char prefix + sha256 at rest; expired/over-scope rejected; `last_used_at` updates.
- CSRF: missing/extra header rejected; `timingSafeEqual` path covered.
- Migration runner on a copy of a 0.2 DB preserves all rows; re-run idempotent.
- Owner-isolation: owner B's data never returned to owner A.

**Acceptance criteria**
1. No literal owner id remains in `server/src` (CI grep gate).
2. Token contract byte-compatible with CI-Server (SSO token accepted; standalone token carries `{sub}` and validates identically).
3. One guard accepts both `Bearer` JWT and `x-api-key`; CSRF enforced on cookie routes.
4. Session + api-key secrets are never stored in plaintext.
5. `pnpm migrate` is version-tracked + idempotent; fresh-install and upgrade-from-0.2 both boot.
6. Owner-scoping proven by the isolation test.

## Phase C — Rich task semantics
**Goal:** dependencies, `start`/`defer`, deadline≠scheduled-date, NL quick-add.
- **Schema:** `scheduled_for` (date) distinct from `due_at` (deadline); `start_at_date`/`defer_until`; `task_dependencies(task_id, depends_on_id)`.
- **Engine/API:** scheduler honors deps, `defer_until`, and `due_at` as a hard deadline; `POST /api/tasks/quick` NL parser (deterministic + optional Ollama assist, deterministic fallback).
- **Client:** quick-add bar; dependency + defer fields in `TaskForm.tsx`.
- **Regression tests:** Phase-A scheduler tests stay green; blocked task never scheduled before blocker; deferred task absent until date; NL parser table (≥20 phrases) incl. Ollama-down fallback; cyclic-dependency rejected.
- **Acceptance:** deadline and scheduled-date independently settable/queryable; cycles rejected with a clear error; quick-add parses title/date/time/tag/estimate, unparseable input still creates a titled task.

## Phase D — Time tracking & timers
**Goal:** actual vs estimate; integrated start/stop timers.
- **Schema:** `actual_minutes`; `time_entries(task_id, started_at, ended_at, source)`; running-timer state.
- **API:** `POST /api/tasks/:id/timer/start|stop`; one active timer per owner; SSE `timer:started/stopped`.
- **Client:** start/stop on TaskCard + block; live elapsed; estimate-vs-actual badge; deterministic estimate suggestion from history.
- **Regression tests:** starting a 2nd timer stops the 1st; stop computes correct duration across a tz/DST boundary; `actual_minutes` aggregates multiple entries.
- **Acceptance:** exactly one running timer per owner; actuals persist across reload + restart; estimate-vs-actual shown; calibration after ≥5 samples.

## Phase E — Recurring tasks & habits
**Goal:** real recurrence; wire the decorative `habit` block kind.
- **Schema:** `recurrence_rule` (RRULE subset: daily/weekly/by-weekday/interval), `recurrence_parent_id`, `habit` flag.
- **Engine/job:** generation job (extend croner) materializes upcoming instances on a rolling horizon; per-instance complete/skip; missed habits surface.
- **Client:** recurrence editor; habit streak display.
- **Regression tests:** weekly-by-MWF expands correctly incl. a DST week; series-edit vs single-instance-edit distinct; re-running the generator is idempotent (no duplicates).
- **Acceptance:** recurring task generates + regenerates next N instances; series vs single edit correct; generator idempotent.

## Phase F — Calendar grid (2-D, drag/resize, week/month, overlays)
**Goal:** replace the day-list `Calendar.tsx` with a real grid.
- **API:** week/month block-range fetch; block move/resize via existing `PATCH /api/blocks`; drag respects locked/meeting blocks.
- **Client:** day/week/month 2-D time grid; drag-to-move, edge-resize-to-reschedule; overlays filterable by **tag and priority**; "now" line; conflict highlighting.
- **Regression tests:** drag emits one tz-correct PATCH; resize below min clamps; filter overlays accurate + combinable; locked/meeting blocks reject drag.
- **Acceptance:** day/week/month render consistently; drag/resize persists across reload; tag/priority overlays accurate; no tz drift between grid position and stored time.

## Phase G — Two-way calendar sync (Google/Outlook/iCloud) — D2
**Goal:** push planned blocks out, pull external events in.
- **Infra:** `connectors/` modeled on CI-Server `domains/connections/` (`BaseOAuth2Client` pattern); **encrypted token store** (match CI-Server's algorithm); `external_events(provider, account, external_id, block_id, etag)`.
- **Hub mode:** delegate OAuth to CI-Server's connections / `CloudOAuthProxyService` (one credential store). **Standalone:** Planning's own connector store. Agent-bridge documented fallback (scoped `x-api-key`).
- **Engine:** outbound (task-blocks → events), inbound (events → read-only meeting blocks), etag + embedding-dedupe for conflicts.
- **Regression tests:** fixture mode unchanged; create→update→delete round-trips without duplicates; local delete removes remote mirror; etag conflict resolves deterministically.
- **Acceptance:** a planned block hits the real calendar within one sync cycle; new external meeting appears as a locked block; no dupes/orphans after 3 cycles; fixture mode still works offline.

## Phase H — Auto-defense (continuous re-plan)
**Goal:** re-plan when meetings appear or blocks are missed (reuses the Phase-A scheduler).
- **Engine:** triggers — sync inbound (G), missed-block detection, task changes; reflow only auto/unlocked blocks around fixed events; debounce; emit `schedule:done`.
- **Client:** "re-planned" toast + diff of what moved; prefs toggle.
- **Regression tests:** a new meeting reflows overlapping auto-blocks, never moves locked/meeting blocks; a missed block re-queues its task; debounce prevents reflow storms; deterministic for identical input.
- **Acceptance:** conflicting meeting triggers reflow within the debounce window; locked/meeting/completed never moved; missed work rescheduled not lost; reflow idempotent.

## Phase I — Notifications + service worker / Web Push
**Goal:** the missing service worker + Web Push, plus reminder scheduling.
- **Infra:** service worker (today: manifest only); Web Push (VAPID); `push_subscriptions` per owner; `reminders(task_id|block_id, fire_at, status)`.
- **Engine:** cron dispatcher fires due reminders (in-app SSE + push); snooze reschedules `fire_at`.
- **Client:** reminder config; snooze UI; permission flow.
- **Regression tests:** reminder fires once at `fire_at` (tz-correct), not twice; snooze moves next fire + cancels original; push failure falls back to in-app; SW registration doesn't break the read-cache PWA.
- **Acceptance:** reminder delivers via push when backgrounded and in-app when open; snooze never double-fires; app still installs/loads if push denied.

## Phase J — Rituals & reflection (wire the dead `planning_mode`)
**Goal:** make `planning_mode` real; daily-plan, shutdown, weekly-review.
- **Engine/API:** `ritual` mode prompts guided daily plan + evening shutdown; weekly review aggregates planned-vs-done, estimate-vs-actual (D), habit streaks (E); `auto` mode = silent auto-schedule.
- **Client:** daily-plan + shutdown flows; weekly-review screen; honor `planning_mode` everywhere it's currently ignored.
- **Regression tests:** `planning_mode` now changes behavior (auto vs ritual diverge); weekly-review numbers reconcile with raw entries/completions; ritual flow resumable.
- **Acceptance:** toggling planning mode is observably different (no longer dead); weekly-review metrics match source data exactly; daily-plan carries unfinished items per Phase-A rollover.

## Phase K — Multi-device sync & offline writes — D3
**Goal:** PWA offline write path; reconcile across devices (op-log + LWW).
- **Infra:** client offline op-log (IndexedDB) queued while offline; server apply with LWW + monotonic per-record version, **scoped by `ownerId`**; SSE pushes authoritative state; conflicts surfaced.
- **Client:** optimistic writes; replay on reconnect; conflict banner.
- **Regression tests:** offline create/edit/complete replays on reconnect; two devices editing one task converge to LWW deterministically; no lost completions; SSE catch-up after disconnect.
- **Acceptance:** offline edits appear after reconnect with no data loss; concurrent edits converge predictably with a visible conflict notice; second device reflects changes within one SSE cycle.

---

## Cross-cutting test strategy
- **Standing suites (must stay green every phase):** server `pnpm test` (Vitest), container `tests/container` Playwright smoke. Each phase extends these — that *is* the regression net.
- **New harnesses:** client component tests (`@solidjs/testing-library`); scheduler property tests (random task/gap sets → invariants: no overlaps, no lost minutes, deterministic); visual-regression via `capture-listing.mjs` (diff key views per PR).
- **CI gates:** typecheck + both suites + grep gates (`ownerId = 1`, hardcoded `Z` wall-clock) + idempotent-migration check on a fixture DB.

## Effort shape (sequencing only)
B small-med · C med · D small-med · E med · F large · G large · H med · I med · J med · K large.
