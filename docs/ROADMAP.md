# Companion Planning — Best-in-Class Roadmap (v2, resequenced)

**Status (2026-07-06, migration head 0112):** **A–Y all shipped & merged.** Since the previous status (2026-07-01, head 0086), the following have landed to main: **O** (gamified five-star day, migs 0087–0090, #191/#192/#193/#198), **P** (planner hygiene — recurrence horizon + Clear Date Range, #188/#190), **Q** (schema hygiene, migs 0092–0094, #205), **S** (schema consolidation — `daily_recap`, `tag_prefs`, migs 0095–0097, #207–#211), **T** (multi-tenant owner-scoping, migs 0098–0100), **U** (CI-Portal OIDC + local auth, migs 0101–0102, #230), **V** (password reset, migs 0103–0104, #232), **X** (MCP intent vocabulary, #234/#237), and **Y** (env-config, #217). **Phase Z — Time-Sense** (Focus Ritual + calibration loop) has landed behind the `time_sense_enabled` master flag (flag-off = behavior-neutral; migs 0106–0109, PRs #246/#251/#257), alongside the **calendar / UI feedback waves** (QuickAdd-in-Today, Planner de-scroll, Flight-Plan tabs + saved-blocks + search, three-axis tag filter, click-to-add, day-type picker, collapsed night hours — #240–#256). **Phase W** (a **GraphQL CRUD layer alongside** the untouched REST API, at `POST /api/graphql`) is **✅ done** — every type W1–W13 + W-sandbox + W-close is merged (the full tag/task/block/flight-plan/pattern/day-type/life-planning/inbox/notification/prefs/admin/engine-ops surface; #235/#238/#243–#285 and the W-close perf-index migration 0112); the board is [W-graphql-crud.md](W-graphql-crud.md). The separate **naming-consolidation "Z"**: **W2** (tag-axis revert `pattern`→`direction`, mig 0105, #239) shipped; **W1** (`patterns`→`routines` table rename) and **W4** (drop vestigial `auto_mode`) remain **planned/unbuilt**. **Migration head is now 0112** (`0112_graphql_perf_indexes`; runner applies 0001 → 0112 on boot). The §3b `patterns`→`routines` rename stays **deferred** (the as-built `patterns` naming stands; see GLOSSARY and naming-Z W1). *Superseded planning docs now live in [archive/](archive/); see [archive/README.md](archive/README.md).*

> **v2 supersedes the original A–K plan.** See [§ What changed](#what-changed-from-v1). Each phase has its own `docs/<id>-*.md` spec; the new G UX is canonical in [design-today-cockpit.md](archive/design-today-cockpit.md).

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
| D4 | Auth deployment | SSO-first **verify-only** resource server **+ minimal standalone** (single scoped API key) | **revised** — no full standalone mirror. ⚠️ **Superseded by Phase U/V:** SSO is now a CI-Portal **OIDC (OAuth 2.1 + PKCE) login** that mints a signed, httpOnly session cookie (+ optional local username/password via `DISABLE_OIDC`, argon2id, and password reset), not a Bearer verify-only resource server. |
| D5 *(new)* | Token crypto | **Asymmetric (RS256/EdDSA + JWKS)**; Planning **verifies only**, never holds a minting secret | replaces HS256 shared-secret. ⚠️ **Refined in Phase U:** the CI-Portal id_token is still JWKS-verified (once, at the OIDC callback) and Planning still mints no *identity/Bearer tokens* — but it now signs its own **session cookie** with `SESSION_SECRET`. |
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
| 3 Multi-user & cloud *(gated on a real driver)* | **I** Identity, auth & connector infra | B0, R | L | ⚠️ **partial** (#116–#120) — API-key standalone store + `requireAuth` + encrypted tokens shipped; the JWKS verify-only SSO Bearer path (PR2) **superseded by Phase U** (OIDC session cookie) |
| | **J** Two-way calendar sync | I, F | L | ✅ done (#128, `external_events` `0051`) — inbound; extended by the Connectors track below |
| | **Connectors** Google OAuth 2.1 + MCP + live Calendar/Gmail | I, J | L | ✅ done (#130–#139, migrations `0058`–`0061`) |
| | **K** Auto-defense (continuous re-plan) | A, F, J | M | ↪ **folded into M** — see [M-ai-scheduler.md](archive/M-ai-scheduler.md) |
| | **L** Multi-device sync & offline writes | B0, I, H | L | ✅ done (migs 0076–0079, #184); P1+P2 gaps closed; 3 P3 items deferred — see [L-multi-device-sync.md](archive/L-multi-device-sync.md) |
| | **M** AI scheduler — real LLM planning · reactive reflow (absorbs K) · back stubbed claims | A, F, G, J | L | ✅ done (migs 0062–0067, #146–#148) — [M-ai-scheduler.md](archive/M-ai-scheduler.md) |
| | **N** Life-planning layer — objectives, reflections, morning briefing, weekly review, learning loops | M, G | L | ✅ done (migs 0080–0084, #185) — [N-life-planning.md](archive/N-life-planning.md) |
| Post-N | **O** Gamified five-star day (derived stars, nightly freeze, FOCUS card, heatmap) | N, O | M | ✅ done (migs 0087–0090, #191/#192/#193/#198) |
| | **P** Planner hygiene (recurrence horizon + Clear Date Range tool) | E, F | S–M | ✅ done (#188/#190, docs/P-planner-hygiene.md) |
| | **Q** Schema hygiene (FK indexes, NOT NULL tightening, integrity test) | B0 | S | ✅ done (migs 0092–0094, #205) |
| | **S** Schema consolidation (`daily_recap`, `tag_prefs`; drop dead `plan_outcomes`) | N, O | M | ✅ done (migs 0095–0097, #207–#211) |
| | **T** Multi-tenant owner-scoping (tags/time_blocks/sync_events owner FKs) | B0 | M | ✅ done (migs 0098–0100) |
| | **U** CI-Portal OIDC + local auth (session cookie, argon2id, `x-api-key`) | I, T | L | ✅ done (migs 0101–0102, #230) |
| | **V** Password reset (single-use token, `session_epoch` revocation) | U | S | ✅ done (migs 0103–0104, #232) |
| | **X** MCP intent vocabulary (Google-client tool surface, install cleanup) | Connectors | S | ✅ done (#234/#237) |
| | **Y** Env-config (`server/.env.example` documents every env var) | U, V | S | ✅ done (#217) |
| | **Z** Time-Sense (Focus Ritual + calibration loop) — *flag-gated* | N, M | L | ✅ done, behind `time_sense_enabled` (flag-off = behavior-neutral; migs 0106–0109, #246/#251/#257) |
| | **W** GraphQL CRUD layer *alongside* REST (`POST /api/graphql`, Apollo 5 + Koa 3) | T, U | L | 🚧 **in progress** — TagType/TaskType/TimeBlockType + Taggable live (#235/#238/#243–#245/#249/#254/#255/#259/#262); board [W-graphql-crud.md](W-graphql-crud.md) |
| | **Z** *(naming consolidation — separate phase)* tag-axis revert `pattern`→`direction`; `patterns`→`routines`; drop `auto_mode` | — | S | ◐ **partial** — W2 done (mig 0105, #239); W1 + W4 planned/unbuilt |

**G ticket order (✅ shipped):** G1 patterns → G3 time-blocks → G4/A′ flight-plan+Auto → G6/F′ PLANNER → G5 cockpit → G8 textures all landed (G2's "habit→pattern" was superseded: habits stayed **task-level** via `subtype`). **G7** custom Routine-type management UI is **shipped** (#115, W1-C); **G-INT** (timing intelligence) remains deferred. The detailed spec [archive/G-rituals-reflection.md](archive/G-rituals-reflection.md) is **HISTORICAL** (old `pattern_types`-as-routine model) — archived for history only.

## Post-N phases (O–Z + W) — status

Everything after N (the phase map above stopped at N in the old status). One line each; migration/PR refs are from the current state as of 2026-07-04.

- **O — Gamified five-star day** ✅ Five derived stars (intention · habits · tasks · bonus · note) on the calendar + header, frozen nightly, with a `day_stars` heatmap and a "Goals → FOCUS" toggle. Migs 0087–0090; #191/#192/#193/#198.
- **P — Planner hygiene** ✅ Shared clear-range engine → a recurrence-duration/horizon pref → a Settings "Clear Date Range" tool (open-ended ranges cap generators with `UNTIL`; bounded ranges write exdates). #188/#190, docs/P-planner-hygiene.md.
- **Q — Schema hygiene** ✅ FK indexes (0092), `flight_plan.owner_id` NOT NULL (0093), `daily_summaries` DEFAULT drop (0094), plus an integrity test and an FK-on `openDb` helper. #205.
- **S — Schema consolidation** ✅ Retired dead `plan_outcomes`/cron (S1-A, 0095); co-located `daily_recap` (S1-B, 0096); folded `category_prefs`/`pattern_prefs` into `tag_prefs` with a kind CHECK (S2, 0097). #207–#211 (note: the stacked-merge recovery landed both S1-B and S2 via #211).
- **T — Multi-tenant owner-scoping** ✅ Owner FKs/NOT NULL across the last un-scoped owned tables — `sync_events` (0098), `time_blocks.owner_id` (0099), `tags.owner_id` (0100). Multi-tenant is now a flip, not a rewrite.
- **U — CI-Portal OIDC + local auth** ✅ Session-cookie login: CI-Portal OIDC (OAuth 2.1 + PKCE relying-party) verifies the id_token once at callback and mints a signed httpOnly `cp_session` cookie; optional local username/password (`DISABLE_OIDC`, argon2id); standalone hashed `x-api-key`; test mode injects the system owner. `AUTH_MODE = test | standalone | sso`. Owner auth cols (0101), `auth_states` PKCE state (0102). #230.
- **V — Password reset** ✅ Single-use local-owner password reset; `owners.session_epoch` (bumped on reset) invalidates all stateless session cookies. Reset cols (0103), `password_reset_tokens` (0104). #232.
- **X — MCP intent vocabulary** ✅ Real MCP surface = the Google-client tools; archived the dead 36-tool server doc, cleaned `install.sh`/plist start refs (runs via `tsx`, never built). #234/#237.
- **Y — Env-config** ✅ `server/.env.example` documents every env var (incl. the U/V surface: `SESSION_SECRET`, `DISABLE_OIDC`, `CIPORTAL_*`, `SMTP_*`, `FIXTURE_*`); annotated dead `AUTH_*` vars and wired `CP_SYNC_DISABLED`. #217.

**Two phases were both named "Z"** (confusingly):

- **Z — Time-Sense** ✅ *flag-gated.* A Focus Ritual + estimate-calibration loop, entirely behind the `time_sense_enabled` master flag (flag-off = byte-identical to Phase N behavior). Z0 scoped estimate calibration, Z1 EOD alignment, Z2 daily-brief fold-in, Z3 "Keep working" `extendBlock` + "Schedule again", Z3b Focus Ritual client screen, Z4 focus-cue background reminders + vibrate, Z5 per-cue prefs, Z6 suggest-only estimate chip, Z7 voice loop. Migs 0106 (`time_sense_flag`) / 0107 (`calibration_scope`) / 0108 (`focus_prefs`) / 0109 (`copy_history`, not in owner export). PRs #246/#251/#257. Spec: docs/Z-focus-ritual.md.
- **Z — Naming consolidation** ◐ *separate phase.* W2 (tag-axis revert `pattern`→`direction`: `tags.kind='direction'`, `tag_directions`, GraphQL `TagKind=DIRECTION`) **shipped** (mig 0105, #239). W1 (`patterns`→`routines` table rename) and W4 (drop vestigial `auto_mode`) remain **unbuilt/planned**.

**UI / calendar feedback waves** ✅ (owner feedback, landed): QuickAdd mounted in Today (#241), Planner de-scroll (#240), Flight-Plan tabs + saved-blocks + search (#242), calendar three-axis tag filter (#247), calendar container-outlines + click-to-add + no-task-drag (#248), select-date → day-type picker (#253), collapsed night hours (12am–7am / 9pm–midnight, #256).

**W — GraphQL CRUD layer** ✅ *done.* Adds a GraphQL surface **alongside** the REST API (REST is untouched/authoritative), mounted at `POST /api/graphql` — Apollo Server 5 + `@as-integrations/koa` on Koa 3, schema-first hand-authored SDL, introspection on, a custom complexity-limiter plugin (not `graphql-query-complexity`), `graphql` pinned to 16.x. Under `requireAuth`; the resolver context reads `currentOwnerId()` from the same `AsyncLocalStorage` the REST routes use. **Decision 3:** every resolver calls the existing `services/*.ts` functions and never re-derives owner-scoping — so a shared service layer (`services/tasks.ts`, `services/blocks.ts`, alongside the pre-existing `services/tags.ts`) was extracted so REST + GraphQL share one owner-scoped implementation. Files live in `server/src/graphql/`. **Live board: [W-graphql-crud.md](W-graphql-crud.md).**
  - **Shipped (merged):** step-1 bootstrap #235 · TagType #238 · Z-W2 `TagKind` flip #239 · `services/tasks.ts` extract + owner-scope hardening #243/#244/#245/#249 · `services/blocks.ts` extract #254 · TaskType #255 · TimeBlockType #259 · Taggable forward tags (Task/TimeBlock implement `Taggable`, `EntityTagType.tags`) + `entity_tags.created_at` (mig 0110, table rebuilt to NOT NULL DEFAULT CURRENT_TIMESTAMP) #262.
  - **Types live:** TagType (+ direction/intention/category hierarchy connections, `TagType.entities` reverse edge), TaskType, TimeBlockType, EntityTagType (forward `Taggable.tags` on Task + TimeBlock), FlightPlanEntryType, Pattern/PatternBlock/PatternPref family, DayType + TagPref, Objective/Reflection/DayStars/DailyRecap (+ `TaskType.objective`), PossibleTask/BlockTemplate, Reminder/PushSubscription, SchedulingPrefs, ScheduledJob/JobRun (admin scope), plus mutation-only engine ops. Node/Connection/Edge/PageInfo/DateTime/JSON conventions match CI-Server.
  - **All tickets shipped (merged):** W4b (TagType.entities reverse edge, cross-table Node union) · W5 FlightPlanEntryType · W6 routine/pattern family (Pattern/PatternKind/PatternBlock/PatternPref) · W7 DayType + TagPref · W8 life-planning (Objective/Reflection/DayStars/DailyRecap; TaskType.objective wired) · W9 inbox (PossibleTask/BlockTemplate) · W10 notifications (Reminder/PushSubscription) · W11 SchedulingPrefs · W12 admin (ScheduledJob/JobRun, behind the admin scope) · W13 mutation-only engine ops (autoplan/find-slot/instruct) · W-sandbox (in-browser GraphiQL IDE — self-hosted vendored GraphiQL, no CDN; `GET /api/graphql/sandbox`, flag-gated `GRAPHQL_SANDBOX`, prod-off) · **W-close** (perf-index migration 0112 + docs sync + cross-type adversarial sweep).

**Migration head — new tables/columns since 0105** (what 0105-era docs miss): 0106 `scheduling_prefs.time_sense_enabled` · 0107 `estimate_calibration` scope columns · 0108 per-cue focus prefs on `scheduling_prefs` (`focus_ritual_enabled` / `haptic_cues_enabled` / `ambient_color_enabled` / `calibration_loop_enabled` / `z_experiment_arm`) · 0109 `copy_history` (Time-Sense voice-loop anti-repetition; not in owner export) · 0110 `entity_tags.created_at` (NOT NULL DEFAULT CURRENT_TIMESTAMP) · 0111 `scheduling_prefs.view_prefs` (cross-device calendar view-state JSON blob) · 0112 GraphQL perf indexes (`idx_tags_owner_kind_name_id` + composite `(parent, child)` on `tag_directions` / `tag_categories`; drops the now-redundant single-col prefixes). **Migration head = 0112.** From T/U/V: 0098 `sync_events` owner FK · 0099 `time_blocks.owner_id` NOT NULL · 0100 `tags.owner_id` · 0101 owners auth columns (`external_subject` / `username` / `password_hash`) · 0102 `auth_states` · 0103 owners reset columns (`backup_email` / `session_epoch`) · 0104 `password_reset_tokens`.

**Known-deferred / not-blocking:** G-INT timing intelligence · L three P3 sync gaps · S optional D1/D2/D3 · Google live mode needs real creds · H Web Push needs VAPID keys · naming-Z W1/W4.

---

## Track 0 — Foundation

### B0 — Migration runner + owner-scoped data model (no auth)
**Goal:** a real migration runner and an owner-scoped schema, so all later schema work is safe and multi-tenant is a cheap flip — **without** building auth. Full implementation spec: [B0-migration-runner.md](archive/B0-migration-runner.md).

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
  [design-today-cockpit.md](archive/design-today-cockpit.md).
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
- **Infra:** scheduled SQLite snapshots and/or **Litestream** continuous replication; one-command restore; the rule "replicate the `.db`, never sync `.db` over Syncthing." Full spec: [R-backups-restore.md](archive/R-backups-restore.md).
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
- **SSO mode (primary, Hub/Core Server):** Planning is a **verify-only** resource server, validating CI-Server tokens against a **JWKS endpoint (asymmetric, D5)** — it never holds a signing secret and cannot mint tokens. OAuth delegated to CI-Server's connections / `CloudOAuthProxyService` (one identity + token store on the appliance). *(Phase I design; **superseded by Phase U** — SSO became a CI-Portal OIDC (OAuth 2.1 + PKCE) login that mints a signed session cookie, with an optional local username/password fallback. See D4 and ARCHITECTURE §9.)*
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

> ↪ **Folded into Phase M.** The reactive reflow is now specified, code-accurately, as **Workstream B** of [M-ai-scheduler.md](archive/M-ai-scheduler.md) — it wraps the live `placeFlightPlan` engine (the "auto_schedule cron calls `runScheduler`" line below is stale; the cron calls `fillFlightPlanCandidates`). This section is retained for the anti-thrash rules M reuses.
**Goal:** re-plan when meetings appear or blocks are missed — **without thrashing**.
- **Engine:** triggers — inbound sync (J), missed-block detection, task changes. Reflow only auto/unlocked blocks. **Anti-thrash is the feature, not a footnote:** never move the block the user is currently in, never move locked/meeting/completed, cap displacement per run, require a minimum stability window before re-moving the same block. Debounce on top.
- **Tests:** a new meeting reflows overlapping auto-blocks, never moves locked/meeting/in-progress; missed block re-queues its task; identical input is a no-op; in-progress block never displaced; reflow idempotent.
- **Acceptance:** conflicting meeting triggers a bounded reflow; nothing locked/active/completed moves; missed work rescheduled not lost; no reflow storms.

### L — Multi-device sync & offline writes (D3, **revised**)

> 🚧 **Core built** — migrations 0076–0079, field-level merge, `POST /api/sync`, SSE catch-up (`Last-Event-ID` replay + overflow `id:` cursor advance), client op-log (IndexedDB), optimistic mutations + 404-rollback, persistent conflict banner, SW push-wake flush, `sync_events` daily prune job, `field_ts` seeding from `updated_at`. All P1 + P2 gaps closed. Full implementation spec: [L-multi-device-sync.md](archive/L-multi-device-sync.md).
**Goal:** PWA offline write path; converge across a single owner's devices.
- **Infra:** client offline op-log (IndexedDB); server apply with a **monotonic per-record version** and **field-level merge** (not whole-record LWW); **completions are monotonic** — a concurrent edit can't silently un-complete a task. SSE pushes authoritative state; genuine conflicts surface a persistent banner (not a toast).
- **Tests:** 25 server-side (22 apply + 3 SSE catch-up) + 18 client-side (10 oplog + 8 conflict-store); 96 server test files green.
- **Acceptance:** offline edits appear after reconnect with no data loss; concurrent edits converge predictably; **no lost completions** (now actually achievable, vs v1's LWW which contradicted this).
- **Deferred (P3 only):** `baseVersion` staleness fence (gap 1/2), `time_blocks` owner check (gap 5), client version in optimistic state (gap 6). None affect current correctness. See [known gaps](archive/L-multi-device-sync.md#known-gaps-prioritized-backlog).

---

### M — AI scheduler (real LLM planning + reactive reflow + stub-backing) *(new — absorbs K)*

> 📋 **Spec'd — next build.** Full implementation spec: [M-ai-scheduler.md](archive/M-ai-scheduler.md). Renamed from the draft `L-ai-scheduler-plan.md` (L is Multi-device sync). Dependencies A/F/G/J are all shipped, so it is buildable now; it builds on the autoplan engine (#121–#129).

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
