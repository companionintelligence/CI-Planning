# Companion Planning — Best-in-Class Roadmap (v2, resequenced)

**Status (2026-07-01, migration head 0086):** **A · B0 · C · D · E · F · G · H · R · I · J · L · M · N shipped & merged**, plus a standalone **Google-connector track** (OAuth 2.1 + MCP + live Calendar/Gmail — #130–#139) and a **tag-driven autoplan engine** (#121–#129). **Phase L** (multi-device sync & offline writes, migs 0076–0079, #184) is complete — field-level merge, SSE catch-up, IndexedDB op-log, 3 P3 gaps remain deferred. **Phase M** (AI scheduler — real LLM planning, reactive reflow, `daily_plan`, calibration, migs 0062–0067, #146–#148) is merged. **Phase N** (life-planning layer — objectives hierarchy, reflections/goals, morning briefing, weekly review, estimate calibration & plan outcomes, migs 0080–0084, #185) is merged. **Task-list + strategic-layer upgrade** (placement lifecycle open↔scheduled, task→objective auto-promotion with height-based leveling, block-template application, migs 0085–0086, #189) is in review. The §3b `patterns`→`routines` rename stays **deferred** (the as-built `patterns` naming stands; see GLOSSARY). *Superseded planning docs now live in [archive/](archive/); see [archive/README.md](archive/README.md).*

> **v2 supersedes the original A–K plan.** See [§ What changed](#what-changed-from-v1). Each phase has its own `docs/<id>-*.md` spec; the new G UX is canonical in [design-today-cockpit.md](design-today-cockpit.md).

> **Phase G reconception (2026-06-20).** The old "Rituals & reflection / wire `planning_mode` / AI-ordering" G is **replaced**. Planning is now **manual-or-Auto, flight-plan-centric**: you drag, or **Auto** schedules *only staged flight-plan items* per **Time-Block** (tag) or **Pattern** rules. The `planning_mode` (`auto | ritual`) toggle is **retired** — "ritual" becomes a **Pattern type** (Routine ▢ / Habit ◯ / Ritual △, user-extensible). A's deterministic scheduler is **reframed** as that Auto engine (no longer auto-packs the whole backlog), and **overlap becomes allowed-but-flagged**. The "before work" relative-timing / proximity / learned-ordering intelligence is **deferred** (`G-INT`). Full spec: [G-rituals-reflection.md](archive/G-rituals-reflection.md).

## What changed from v1
- **Value-first sequencing.** The features that make it "best-in-class" (task semantics, time tracking, recurrence, calendar grid, rituals, notifications) no longer wait on auth. They need a data-model foundation, not identity.
- **Old Phase B split in two.** `B0` = migration runner + owner-scoped data model (single-owner, **no auth**, ~days). The auth/SSO/standalone work moves to a later **Multi-User & Cloud** track, gated on a real driver.
- **Auth decisions revised** (verify-only, asymmetric, versioned contract, minimal standalone) — see Locked Decisions.
- **Added** what v1 was missing: **backups & recoverability**, **audit log / observability**, **export/import**, a scheduled **threat model**, and a **scale budget**.
- **Library calls** to stop hand-rolling solved problems: `chrono-node` (NL parse), `rrule.js` (recurrence); sync identity keyed on `etag`/`external_id` (not embeddings); field-level merge with monotonic completions (not whole-record LWW).

## Principles (carried; two refined)
- **Server-authoritative, offline-tolerant.** SQLite is the source of truth; clients reconcile.
- **Degrade gracefully.** Every AI/integration feature has a deterministic fallback (the existing Ollama/Google pattern).
- **Deterministic core, AI-assist on top.** Placement/merge stay reproducible; the LLM informs selection/ordering only.
- **Forward-only, expand/contract migrations.** *(Revised from "reversible" — SQLite's `ALTER` can't honestly promise reversibility; use expand → backfill → contract.)*
- **Single-owner until a real multi-user driver exists** — but the data model is **owner-scoped from B0**, so multi-tenant is a later flip, not a rewrite.
- **Test-gated.** No phase merges without its regression suite green; the scheduler additionally carries property tests.

## Locked decisions (revised)
| # | Decision | Choice (v2) | Change vs v1 |
|---|---|---|---|
| D1 | Auth model | Single-owner now; owner-scoped data model | unchanged |
| D2 | Two-way sync | Native OAuth connectors + encrypted token store; agent-bridge (scoped API key) fallback | **moved to the cloud track** |
| D3 | Multi-device merge | Op-log + **field-level** merge; completions are **monotonic** (never un-done by a concurrent edit) | **revised** — whole-record LWW silently dropped completions |
| D4 | Auth deployment | SSO-first **verify-only** resource server **+ minimal standalone** (single scoped API key) | **revised** — no full standalone mirror |
| D5 *(new)* | Token crypto | **Asymmetric (RS256/EdDSA + JWKS)**; Planning **verifies only**, never holds a minting secret | replaces HS256 shared-secret |
| D6 *(new)* | Contract coupling | Depend on a **published, versioned** CI auth contract (JWKS + documented claims), not reverse-engineered internals | new guardrail |

## Phase map (resequenced)
| Track | Phase | Depends on | Effort | Status |
|---|---|---|---|---|
| — | **A** Scheduler correctness + today-set + cached briefing | — | — | ✅ done *(reframed by G as the flight-plan Auto engine)* |
| 0 Foundation | **B0** Migrations + owner scoping (no auth) | A | S | ✅ done |
| 1 Features | **C** Rich task semantics | B0 | M | ✅ done |
| | **D** Time tracking & timers | B0 | S–M | ✅ done |
| | **E** Recurring & habits | B0, C | M | ✅ done · habit kept **task-level** (`subtype`); §5a cleanup **done** (booleans dropped — `0048`, #113/#114) — see [archive/phase-0-reconciliation-plan.md](archive/phase-0-reconciliation-plan.md) |
| | **F** Calendar grid (2-D, drag/resize, overlays) | B0 | L | ✅ done · **F′** (→PLANNER / overlap-flag / drag-reorder) **shipped under G** |
| | *Settings* — Ollama model picker + Companion Memory sync | E | S | ✅ done |
| | *Responsive* — mobile shell (bottom nav, sheets, touch) | F | S | ✅ done |
| | **G** **Time-Blocking, Patterns & the TODAY cockpit** | B0, C, E, F | **L** | ✅ done (#60–#65, #77) — cockpit, PLANNER, flight-plan, textures all landed; drawer superseded by ElementWizard |
| | **H** Notifications + service worker / Web Push | B0 (G for pattern-reminder content) | M | ✅ done (#100–#102) — live once VAPID keys are set |
| 2 Resilience | **R** Backups, restore, export/import | B0 | S–M | ✅ done (#108–#110) — every mutating route writes an audit row |
| 3 Multi-user & cloud *(gated on a real driver)* | **I** Identity, auth & connector infra | B0, R | L | ✅ done (#116–#120) — JWKS verify-only · API-key store · encrypted tokens (`0049`/`0050`) · rate-limit · threat model |
| | **J** Two-way calendar sync | I, F | L | ✅ done (#128, `external_events` `0051`) — inbound; extended by the Connectors track below |
| | **Connectors** Google OAuth 2.1 + MCP + live Calendar/Gmail | I, J | L | ✅ done (#130–#139, migrations `0058`–`0061`) |
| | **K** Auto-defense (continuous re-plan) | A, F, J | M | ↪ **folded into M** — see [M-ai-scheduler.md](M-ai-scheduler.md) |
| | **L** Multi-device sync & offline writes | B0, I, H | L | ✅ done (migs 0076–0079, #184); P1+P2 gaps closed; 3 P3 items deferred — see [L-multi-device-sync.md](L-multi-device-sync.md) |
| | **M** AI scheduler — real LLM planning · reactive reflow (absorbs K) · back stubbed claims | A, F, G, J | L | ✅ done (migs 0062–0067, #146–#148) — [M-ai-scheduler.md](M-ai-scheduler.md) |
| | **N** Life-planning layer — objectives, reflections, morning briefing, weekly review, learning loops | M, G | L | ✅ done (migs 0080–0084, #185) — [N-life-planning.md](N-life-planning.md) |

**G ticket order (✅ shipped):** G1 patterns → G3 time-blocks → G4/A′ flight-plan+Auto → G6/F′ PLANNER → G5 cockpit → G8 textures all landed (G2's "habit→pattern" was superseded: habits stayed **task-level** via `subtype`). **G7** custom Routine-type management UI is **shipped** (#115, W1-C); **G-INT** (timing intelligence) remains deferred. The detailed spec [archive/G-rituals-reflection.md](archive/G-rituals-reflection.md) is **HISTORICAL** (old `pattern_types`-as-routine model) — archived for history only.

---

## Track 0 — Foundation

### B0 — Migration runner + owner-scoped data model (no auth)
**Goal:** a real migration runner and an owner-scoped schema, so all later schema work is safe and multi-tenant is a cheap flip — **without** building auth. Full implementation spec: [B0-migration-runner.md](B0-migration-runner.md).

**Components**
- **Migration runner** + `schema_migrations` table. Ordered, idempotent, forward-only (expand/contract); `pnpm migrate`. Supersedes the ad-hoc `migrateColumns()` `addCol` helper and the cross-branch `CREATE TABLE IF NOT EXISTS` drift (folded into migration `0001`).
- **Owner-scoped queries.** Replace the **7 literal `ownerId = 1` sites** (`scheduler.ts`, `routes/prefs.ts`, `routes/tasks.ts`, `routes/possibles.ts`) with a resolved owner from `lib/context.ts` (`AsyncLocalStorage`, `RequestContext { ownerId }`, `SYSTEM_OWNER`). Single-owner mode injects owner 1 — **no token required yet**.
- **Owner-scoped SSE.** `broadcast()` is a global `Set` today (`routes/sse.ts`) — every event reaches every stream. Make it `broadcast(ownerId, …)` and tag each connection. A real isolation fix, not cosmetic.
- **Owner columns** present + indexed on all owned tables.

**Regression tests**
- Runner on a copy of a 0.2 DB preserves all rows; re-run idempotent; version advances exactly once.
- Existing Vitest + container suites pass unchanged (single-owner context injects owner 1; **no auth headers**).
- SSE isolation: a second owner's stream never receives owner 1's events.

**Acceptance**
1. `pnpm migrate` version-tracked + idempotent; fresh install and upgrade-from-0.2 both boot.
2. No hardcoded owner id in `routes/`/`engine/` (grep gate, excluding seeds/migrations/sentinel).
3. `broadcast` owner-scoped + tested.
4. Existing suite green with zero auth surface added.

**Effort: S** — the ~1-day-plus need v1 buried inside a multi-week auth epic.

---

## Track 1 — Best-in-class features (all need only B0)

### C — Rich task semantics
**Goal:** dependencies, `start`/`defer`, deadline≠scheduled-date, NL quick-add.
- **Schema (migration):** `scheduled_for` (date) distinct from `due_at` (deadline); `defer_until`; `task_dependencies(task_id, depends_on_id)`.
- **Engine/API:** scheduler honors deps, `defer_until`, and `due_at` as a hard deadline (extends the Phase-A today-set); `POST /api/tasks/quick` parses NL via **`chrono-node`** (don't hand-roll dates), LLM as optional enrichment, deterministic fallback.
- **Client:** quick-add bar; dependency + defer fields in `TaskForm.tsx`.
- **Tests:** Phase-A scheduler tests stay green; blocked task never scheduled before its blocker; deferred task absent until its date; cyclic dependency rejected; NL parse table (≥20 phrases) incl. parser-down fallback.
- **Acceptance:** deadline and scheduled-date independently set/queried; cycles rejected; quick-add extracts title/date/time/tag/estimate; unparseable input still creates a task.

### D — Time tracking & timers
**Goal:** actual vs estimate; integrated start/stop.
- **Schema:** `actual_minutes`; `time_entries(task_id, started_at, ended_at, source)`; running-timer state (owner-scoped).
- **API:** `POST /api/tasks/:id/timer/start|stop`; **one active timer per owner**; SSE `timer:started/stopped`.
- **Client:** start/stop on TaskCard + block; live elapsed; estimate-vs-actual badge; deterministic estimate suggestion after ≥5 samples.
- **Tests:** starting a 2nd timer stops the 1st; stop computes correct duration across a DST boundary (reuse `lib/tz.ts`); actuals aggregate across entries.
- **Acceptance:** exactly one running timer per owner; actuals survive reload + restart; calibration at ≥5 samples.

### E — Recurring tasks & habits
**Goal:** real recurrence; wire the decorative `habit` block kind.
- **Schema:** `recurrence_rule`, `recurrence_parent_id`, `habit` flag.
- **Engine/job:** use **`rrule.js`** (don't hand-roll RRULE — DST/`UNTIL`/`COUNT`/`EXDATE` are exactly the traps Phase A already paid for). A croner job materializes upcoming instances on a *bounded* rolling horizon; per-instance complete/skip; missed habits surface.
- **Client:** recurrence editor; habit streak display.
- **Tests:** weekly-by-MWF expands correctly incl. a DST week; series-edit vs single-instance-edit distinct; generator re-run idempotent (no duplicates).
- **Acceptance:** recurring task generates + regenerates next N; series vs single edit correct; generator idempotent and bounded (see scale budget).

### F — Calendar grid (2-D, drag/resize, week/month, overlays)
**Goal:** replace the day-list `Calendar.tsx` with a real grid. *(Highest user impact; needs zero auth.)*
- **API:** week/month block-range fetch (owner-scoped, tz-correct via `dayRangeUTC`); move/resize via existing `PATCH /api/blocks`.
- **Client:** day/week/month grid; drag-to-move, edge-resize; **all-day events**; "now" line; conflict highlighting; overlays filterable by **tag and priority**.
- **Tests:** drag emits one tz-correct PATCH; resize below min clamps; locked/meeting blocks reject drag; overlays accurate + combinable; **no tz drift** between grid position and stored UTC.
- **Acceptance:** day/week/month consistent; drag/resize persists across reload; no tz drift; locked/meeting blocks immovable.

### G — Time-Blocking, Patterns & the TODAY cockpit *(reconceived 2026-06-20)*
**Goal:** the TODAY planner cockpit on three primitives — **Time-Blocks** (tagged
outline containers), **Patterns** (typed task collections: Routine ▢ / Habit ◯ /
Ritual △), and the **Flight-plan** (staging area) — with **manual-or-Auto,
flight-plan-centric** scheduling. Auto only places *staged* items, per a
Time-Block's tag filter or a Pattern's rules.
- **Model:** `planning_mode` retired (ritual → a Pattern *type*); A's scheduler
  reframed as the flight-plan Auto engine; **overlap allowed-but-flagged**; patterns
  are **collections only** (repetition stays E's task-level RRULE).
- **Scope:** structure + tag-filtered/manual scheduling in V1; relative-timing /
  proximity / learned ordering deferred (`G-INT`).
- **Pulls in revisions:** `E′` (habit→pattern migration, streaks intact) and `F′`
  (calendar grid → PLANNER: 8h/expand-24, next-up pin, drag-reorder, overlap-flag,
  block outlines, pattern textures).
- **Tickets, acceptance, tests, and per-ticket state:**
  [G-rituals-reflection.md](archive/G-rituals-reflection.md) · UX:
  [design-today-cockpit.md](design-today-cockpit.md).
- **Acceptance (phase):** cockpit renders (Day Overview · Summary+NewTask · PLANNER ·
  Flight-plan · never-closing drawer); Time-Blocks + Patterns exist end-to-end;
  scheduling is flight-plan-only with the two-step Auto; PLANNER shows the 8h/pin/
  reorder/overlap-flag behaviour; former habits are patterns with recurrence/streaks
  intact; standing suites green.

### H — Notifications + service worker / Web Push
**Goal:** the missing service worker + Web Push and reminder scheduling. *(Owner scoping from B0 suffices — single-owner is fine.)*
- **Infra:** service worker (today: manifest only); Web Push (VAPID); `push_subscriptions` (owner-scoped); `reminders(task_id|block_id, fire_at, status)`.
- **Engine:** cron dispatcher fires due reminders (in-app SSE + push); snooze reschedules `fire_at`.
- **Tests:** reminder fires once at a tz-correct `fire_at`, not twice; snooze moves next fire + cancels original; push failure falls back to in-app; SW registration doesn't break the read-cache PWA.
- **Acceptance:** delivers via push when backgrounded, in-app when open; snooze never double-fires; app still installs if push denied.

---

## Track 2 — Resilience (before the cloud track)

### R — Backups, restore, export/import *(new — was missing)*
**Goal:** recoverability for hardware you *sell*, and portability for "UnCloud Your Life."
- **Infra:** scheduled SQLite snapshots and/or **Litestream** continuous replication; one-command restore; the rule "replicate the `.db`, never sync `.db` over Syncthing." Full spec: [R-backups-restore.md](R-backups-restore.md).
- **API/Client:** `GET /api/export` (full JSON), `POST /api/import` (validated, owner-scoped); a Settings "Back up / restore / export" panel.
- **Audit log (foundation):** append-only `audit_log(owner_id, actor, action, entity, at)` — lightweight now, essential before auth/multi-device.
- **Tests:** snapshot→wipe→restore yields byte-identical state; export→import round-trips with stable ids; import rejects malformed/foreign-owner data.
- **Acceptance:** restored DB indistinguishable from original; export/import lossless; every mutating route writes an audit row.

---

## Track 3 — Multi-user & cloud *(gated on a real driver: a multi-seat deployment or the public image shipping)*

### I — Identity, auth & connector infrastructure (ci-server-aligned, **revised**)

> ✅ **Shipped** (#116–#120; migrations `0049_api_keys`, `0050_connection_tokens`). Standalone API-key auth + `requireAuth`, SSO verify-only JWKS path, rate-limited credential validation, AES-256-GCM connection-token store; threat model + security-review sign-off in #120 (W2-I5).
**Goal:** real identity + the encrypted token store, matching CI's **security semantics and a versioned contract** — not its framework or internals.

**Deployment modes**
- **SSO mode (primary, Hub/Core Server):** Planning is a **verify-only** resource server, validating CI-Server tokens against a **JWKS endpoint (asymmetric, D5)** — it never holds a signing secret and cannot mint tokens. OAuth delegated to CI-Server's connections / `CloudOAuthProxyService` (one identity + token store on the appliance).
- **Standalone mode (public image, minimal — D4):** **not a faithful mirror.** A single scoped **API key** (`x-api-key`, `randomBytes(32)` hex, 5-char prefix, **SHA-256 at rest**, `scopes[]`, `expires_at`, `last_used_at`) plus optional local login. Covers the public Docker image without reproducing CI-Server's full session/CSRF/refresh machinery in a second codebase.

**Adopt from CI-Server (security-relevant, as-is)**
- `requireAuth` = `JwtOrApiKeyAuthGuard` analog (Koa middleware): JWKS-verified Bearer **or** `x-api-key`; sets `ownerId` via `lib/context.ts` (built in B0); 401 otherwise.
- API-key contract above; **all secret compares via `crypto.timingSafeEqual`**; UUIDv7 ids; zod DTO validation.
- **Rate-limit `/authenticate*` and api-key validation** *(CI-Server has none — explicit addition)*.
- **Connection-token encryption** for connectors: AES-256-GCM with a KEK from env/Hub keystore. **Confirm CI-Server's exact algorithm at build time and match it** in a single `lib/crypto` shim (the one place coupling is unavoidable).

**Explicitly dropped from v1** (security review): HS256 shared minting secret → JWKS verify-only (D5); full standalone session/CSRF/refresh mirror → minimal API key (D4); bcrypt → **argon2id** if local passwords are kept at all (and for single-user standalone, password auth may be skipped entirely).

**Tests:** existing suite passes with `requireAuth` injecting a test owner **and** an explicit "no token → 401" matrix across every route + the SSE stream; a CI-Server fixture token (verified via test JWKS) authenticates in SSO mode; API key hashed at rest, expired/over-scope rejected, `last_used_at` updates; rate-limit trips; **owner-isolation across REST and SSE**. The container Playwright smoke and `capture-listing.mjs` get a test API key (bypass strategy decided explicitly).

**Acceptance:** Planning verifies but cannot mint tokens; one guard accepts Bearer-JWT or `x-api-key`; secrets never stored plaintext; auth endpoints rate-limited; owner isolation proven on REST **and** SSE; **threat model reviewed** (below). **Effort: L.**

### J — Two-way calendar sync (Google/Outlook/iCloud)

> ✅ **Shipped** (#128; `external_events` `0051`, sync-calendar job `0056`, outbound queue `0057`). Extended by the standalone **Google-connector track** (#130–#139, migrations `0058`–`0061`): live OAuth 2.1, MCP transport, calendar connector + inbound unification, incremental sync, Gmail scope flag.
**Goal:** push planned blocks out, pull external events in.
- **Infra:** `connectors/` (`BaseOAuth2Client` pattern); encrypted token store (from I); `external_events(provider, account, external_id, block_id, etag)`.
- **Engine:** outbound (task-blocks→events), inbound (events→read-only meeting blocks). **Conflict identity is `external_id` + `etag` only — never embeddings** (a sync layer must be exact and deterministic; embeddings stay confined to the ingest→task heuristic).
- **Tests:** fixture mode unchanged/offline; create→update→delete round-trips without duplicates; local delete removes the remote mirror; etag conflict resolves deterministically; no dupes/orphans after 3 cycles.
- **Acceptance:** a planned block reaches the real calendar within one cycle; new external meetings appear as locked blocks; deterministic conflict resolution; fixture mode still works offline.

### K — Auto-defense (continuous re-plan)

> ↪ **Folded into Phase M.** The reactive reflow is now specified, code-accurately, as **Workstream B** of [M-ai-scheduler.md](M-ai-scheduler.md) — it wraps the live `placeFlightPlan` engine (the "auto_schedule cron calls `runScheduler`" line below is stale; the cron calls `fillFlightPlanCandidates`). This section is retained for the anti-thrash rules M reuses.
**Goal:** re-plan when meetings appear or blocks are missed — **without thrashing**.
- **Engine:** triggers — inbound sync (J), missed-block detection, task changes. Reflow only auto/unlocked blocks. **Anti-thrash is the feature, not a footnote:** never move the block the user is currently in, never move locked/meeting/completed, cap displacement per run, require a minimum stability window before re-moving the same block. Debounce on top.
- **Tests:** a new meeting reflows overlapping auto-blocks, never moves locked/meeting/in-progress; missed block re-queues its task; identical input is a no-op; in-progress block never displaced; reflow idempotent.
- **Acceptance:** conflicting meeting triggers a bounded reflow; nothing locked/active/completed moves; missed work rescheduled not lost; no reflow storms.

### L — Multi-device sync & offline writes (D3, **revised**)

> 🚧 **Core built** — migrations 0076–0079, field-level merge, `POST /api/sync`, SSE catch-up (`Last-Event-ID` replay + overflow `id:` cursor advance), client op-log (IndexedDB), optimistic mutations + 404-rollback, persistent conflict banner, SW push-wake flush, `sync_events` daily prune job, `field_ts` seeding from `updated_at`. All P1 + P2 gaps closed. Full implementation spec: [L-multi-device-sync.md](L-multi-device-sync.md).
**Goal:** PWA offline write path; converge across a single owner's devices.
- **Infra:** client offline op-log (IndexedDB); server apply with a **monotonic per-record version** and **field-level merge** (not whole-record LWW); **completions are monotonic** — a concurrent edit can't silently un-complete a task. SSE pushes authoritative state; genuine conflicts surface a persistent banner (not a toast).
- **Tests:** 25 server-side (22 apply + 3 SSE catch-up) + 18 client-side (10 oplog + 8 conflict-store); 96 server test files green.
- **Acceptance:** offline edits appear after reconnect with no data loss; concurrent edits converge predictably; **no lost completions** (now actually achievable, vs v1's LWW which contradicted this).
- **Deferred (P3 only):** `baseVersion` staleness fence (gap 1/2), `time_blocks` owner check (gap 5), client version in optimistic state (gap 6). None affect current correctness. See [known gaps](L-multi-device-sync.md#known-gaps-prioritized-backlog).

---

### M — AI scheduler (real LLM planning + reactive reflow + stub-backing) *(new — absorbs K)*

> 📋 **Spec'd — next build.** Full implementation spec: [M-ai-scheduler.md](M-ai-scheduler.md). Renamed from the draft `L-ai-scheduler-plan.md` (L is Multi-device sync). Dependencies A/F/G/J are all shipped, so it is buildable now; it builds on the autoplan engine (#121–#129).

**Goal:** close the gap between the marketed "local-LLM auto-block" and the code. The LLM **authors** a durable day order once per day (into a `daily_plan` table); placement and reflow **execute it deterministically**; a Phase-K reactive reflow defends the day without thrash. Also backs three stubbed claims (`overrun`, `day_theme`, `sqlite-vec`).
- **Workstream A — real LLM planning** behind the §A0 generate→evaluate→iterate harness (generator ≠ judge, deterministic-gated rubric, bounded recursion, append-only `audit_log`, escape hatch on stall).
- **Workstream B — Phase-K reactive reflow** over the frozen `daily_plan`: deterministic, anti-thrash, with a **nudge-first** LLM re-author escalation (B4) behind explicit user accept.
- **Workstream C — back the stubs:** set `overrun` status, apply `day_theme` placement bias, `sqlite-vec` KNN dedupe (cosine fallback).
- **Migrations** `0062`–`0064` (renumbered from the doc's original 0058–0060, which the Connectors track took). **Effort: L** (~3–3.5 weeks across ~10 PRs).

---

## Cross-cutting

**Test strategy (carried, strengthened)**
- Standing suites green every phase: server `pnpm test` (Vitest) + container Playwright smoke. Each phase extends them.
- New harnesses: client component tests (`@solidjs/testing-library`); **scheduler property tests** (random task/gap sets → invariants: no overlaps, no lost minutes, deterministic); visual-regression via `capture-listing.mjs`.
- CI gates: typecheck + both suites + grep gates (owner-id in business logic, hardcoded `Z` wall-clock) + **idempotent-migration check on a fixture DB** + a **restore-equivalence check** (Track 2).

**Security.** A written **threat model + security review is a scheduled deliverable of Phase I**, not an afterthought — it gates the entire cloud track.

**Scale budget (new).** The scheduler sorts the whole open set each run, and recurrence (E) materializes instances — both grow unbounded by default. Set explicit budgets: cap the recurrence horizon, index `owner+status+due`, and add a perf assertion (schedule a 1k-task day under N ms) once E lands.

## Effort shape (sequencing only)
B0 **S** · C M · D S–M · E M · F **L** · G M · H M · R S–M · I **L** · J **L** · K M · L **L**.

> **Net change from v1:** a paying customer gets recurrence, a real calendar, time tracking, rituals, notifications, **and** backups before a line of auth is written — and the auth, when it comes, is verify-only and roughly half the surface.
