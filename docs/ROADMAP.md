# Companion Planning — Best-in-Class Roadmap (v2, resequenced)

> ## Current status (2026-11-01, `main` @ `3cfbbdf2`)
>
> **Read this box first.** It was checked against the code and git history; where it disagrees
> with the older boxes and "Update:" paragraphs below, this box wins.
>
> - **Release:** package version `4.2.0`, git tags through `v4.2.2`. [CHANGELOG.md](../CHANGELOG.md)
>   has `[4.2.0] — 2026-10-29` and an `[Unreleased]` section above it. The license has been
>   PolyForm Noncommercial 1.0.0 since 4.2.0 (it was CI-Commercial-1.0).
> - **Migration head: `0172_signup_codes`** — 168 migrations in
>   `server/src/db/migrations/index.ts`; the numbers 0009, 0119, 0159 and 0160 are unused.
>   Since the 2026-08-13 box below (head `0138`): 0139–0144 Triality (flag, log, weights,
>   weekly `calibrate_triality` job, confidence) and the per-task `motivation` axis (0141) ·
>   0145 `connection_prefs` · 0146 Gmail ingest every 15 min · 0147 ingest windows · 0148 synced
>   calendar blocks locked · 0149/0150 classification learning + `calibrate_classification` ·
>   0151–0154 people on work · 0155 per-owner LLM thinking opt-in · 0156
>   `capacity_hours_per_week` (replaces the unread `workday_start`/`workday_end`) · 0157/0158
>   dismissal evidence + `calibrate_dismissals` · 0161 `completion_score` (the close ritual's
>   1–5 rating; replaces `completion_mood`) · 0162/0163 plan-loop evidence + `calibrate_plan_loop`
>   · 0164/0165 balance bias pref + `balance_week_log` · 0166/0167 placement evidence +
>   `calibrate_placement` · 0168/0169 indexes · 0170 per-direction `show_open_time` · 0171
>   `planning_mode` split from the trust dial · 0172 `signup_codes`. When this goes stale,
>   `migrations/index.ts` wins.
> - **Phases A–AG: shipped**, and so is everything the box below lists. Also shipped since,
>   with no phase letter:
>   - **AH — Focus × Time Blocks** ([AH-focus-timeblocks.md](AH-focus-timeblocks.md); wrap-up in
>     [HANDOFF-2026-08-14-focus-timeblocks-phases-1-7.md](HANDOFF-2026-08-14-focus-timeblocks-phases-1-7.md)):
>     all nine phases are merged (PRs #543–#561) — the lock model, Time Blocks as Focus sections,
>     add-into-block, calendar containment, auto-nest, the reflow mobility ladder, the confirmed
>     day-type reflow, classification learning, and an honest Open Time.
>   - **Learning loops** — the scheduler and parser learn from the owner's own behaviour, each as
>     an append-only evidence log plus a weekly `calibrate_*` batch job: classification
>     corrections, dismissed suggestions, plan-loop revisions, placement choices, and Triality
>     outcomes (the factory tickets are in `docs/factory/`).
>   - **People on work** — Responsible & Beneficiaries on tasks and time blocks (PR #574,
>     [people-on-work.md](people-on-work.md)).
>   - **Close ritual** (0137, 0161), **Balance targets reaching the scheduler** (#590), the
>     **trust dial as an ordering policy** (#605), **cancel a scheduled task** (#606), and
>     the **Open Time range**, Planner-in-the-middle Today layout and Flight Plan drawer tab
>     (#601, #604).
>   - **Sign-in and onboarding for 4.2.0** (#619): sign-in against the real Companion Portal, a
>     new-user path with invite-code local sign-up (`AUTH_SIGNUP`, 0172), curated sample data, a
>     Content-Security-Policy and other security headers, and an explicit CORS origin allowlist.
>     GitHub Actions are manual-dispatch only (#618): the merge gate is
>     `pnpm typecheck && pnpm build && pnpm test`, and `tests/container/run-local.sh` is the
>     container smoke gate.
>   - **Mobile shells** — Capacitor iOS and Android apps in `mobile/` that connect to a server
>     you run, plus `GET /api/sync/changes`, the polling twin of the SSE stream (#629–#631;
>     `[Unreleased]` in the CHANGELOG). Not store-ready.
> - **Still open / deferred:** naming-Z **W1** (`patterns`→`routines` table rename; the DB still
>   has `patterns`) · multi-user shared events M1–M5 (no tables or routes for them exist; only
>   the ticket drafts in `docs/factory/drafts/`) · G-INT timing intelligence · the Postgres
>   schema port (`server/db/postgres/migrations/` stops at a 2026-08-02 baseline; compose no
>   longer needs Postgres) · live-mode smoke of the CI-Server memory link against a real
>   CI-Server (carried over from the older notes below; not re-tested).
> - **Issues:** GitHub was not queried for this check, so the issue states below (#337–#363,
>   #517/#518) are as of the 2026-08-13 audit.

> ## Earlier status (2026-08-13 GitHub issue audit) — kept for history
>
> **Read this box, not the archaeology below (the migration head and the open-work list are
> superseded by the box above).** Live `gh issue list --state open` on
> 2026-08-13 shows **7 open issues total**, down from the 14-ticket FTUE track +
> deferred M1–M5 this doc previously tracked:
> - **FTUE track T1–T14 (#337–#350): all 14 CLOSED.** The 2026-07-29 box below still
>   said "T13 is the next live ticket" — stale; T13 and T14 shipped and closed too.
>   The whole FTUE / weekly-planning-assistant track (row in the Phase map) is now
>   **✅ done**, not ⏳ open.
> - **ENTITY-5 spike #361: CLOSED** (decided — matches this doc's own "Spike #361 is
>   DECIDED" note below, but the Phase map row still said "⏳ open (#361)"; fixed).
> - **Multi-user shared events M1–M5 (#351–#355): still OPEN, still deferred.** These
>   are the only roadmap-tracked work left open — stub tickets, not started.
> - **Two new issues, unrelated to this roadmap's phases — video/product-marketing
>   pipeline, filed 2026-08-12:**
>   - **[#517](https://github.com/companionintelligence/CI-Planning/issues/517)** —
>     the Today header shows two different day totals (15h 5m vs 10h 15m) for the same
>     fixture day at desktop vs mobile viewport in the acquisition-video capture. Filed
>     as possibly a **real product bug** in `Today.tsx`'s capacity calc (not just a
>     video defect) — candidate #1 is a genuine responsive-layout data bug, candidate #2
>     is capture-harness state drift between the two viewport passes. Not
>     resolved by the 2026-08-13 video rewrite (#519/941bad6), which only changed
>     captions/narration/audio — the underlying plates and `Today.tsx` are untouched.
>   - **[#518](https://github.com/companionintelligence/CI-Planning/issues/518)** —
>     two mobile capture plates (`add-element-parsed.mobile.png`,
>     `plan-my-week.mobile.png`) can't show what their scene captions promise; needs
>     new capture recipes (scroll-into-view / different bottom-sheet presentation),
>     not a crop. Also untouched by the 2026-08-13 rewrite.
>
> The status paragraph that follows is a
> stack of dated "Update:" parentheticals and **contradicts itself on the migration head
> (it says 0126, 0117 and 0112 in three places) and on naming-Z W4 (both "planned/unbuilt"
> and "shipped")**. It is kept for history. Where they disagree, this box wins.
>
> - **Migration head at the time: `0138_calibration_history`** (0133–0138: item colors, the
>   Categories⇄Balance re-seed + capture, the enrich-tasks job, the close ritual,
>   calibration history; 0119 stays an intentional gap). The authoritative ordered list is
>   `server/src/db/migrations/index.ts` — whenever this box next goes stale, that file wins.
>   Every "head = 0112/0117/0126/0130" claim below is stale.
> - **Phases A–AG: shipped.** Naming-Z **W4 is shipped** (mig 0123); **W1** (`patterns`→`routines`)
>   remains the only unbuilt naming item.
> - **Post-AG, no phase letter** (see ARCHITECTURE §1.1):
>   - **Life priorities** (migs 0127/0128, #356) — `/priorities` wizard + `/balance` dashboard,
>     `life_priorities` per (owner, category), `sleep_hours_per_week` reserved from the weekly pool.
>   - **ENTITY track** (#357–#363 → PRs #362–#368) — wizard gating, confirm-before-delete,
>     promote-task-to-objective (Planner + task-card picker), and **objectives archive + 48h purge**
>     (migs 0129/0130). Follow-ups #369–#372 closed the archive's read/write/sync leaks.
>   - **FTUE track T1–T12: MERGED** (PRs #377–#385, 2026-07-19) — planning-session log, Plan-my-week
>     assistant (Fill/Schedule/Review branches + LLM hybrid steps), Settings Logs tab + consolidate,
>     and the 5-step OnboardingWizard with connect-source + first-sync. **T13 (#349) is the next
>     live ticket; T14 (#350) + M1–M5 (#351–#355) stay deferred.**
> - **Spike #361 is DECIDED** — decision record `docs/objectives-in-planner.md` (option (c):
>   non-geometric objective accent + opt-in single-objective rail; the derived spanning band is
>   rejected on measurement). Follow-up recipe drafted at
>   `docs/factory/drafts/spike361_followup_objective_accent.md`, not yet promoted to an issue *(since shipped as #386, re-merged in #401: the accent and the shared objectives store; the opt-in focused rail is not built)*.
> - **2026-07-19 full-codebase audit** (33 verified findings: stubs, dead wiring, data-flow gaps).
>   The 8 clear correctness bugs are fixed on branch `fix/audit-findings-2026-07-19` (orphaned
>   blocks on task-cancel, mode-blind calendar sync, backup dropping `life_priorities`/
>   `planning_sessions`, DST day-bounds, MEMORY_MODE fixture guard, mobile Jobs leak, Jobs-page
>   counters, objectives return-type lie). The remaining findings are build-vs-delete product
>   decisions (reminders manager, calibration pins, evening reflection, pattern types, §A4
>   free-text entry point / PromptStep, dead API surface) — issues to be filed after owner input.
> - **Locked decision D1 is superseded** — see the note in that table.
> - **Known doc gaps:** `docs/ftue-plan.md` §1 "honest current state" is **materially false** as of
>   this head (see its own status box).

**Status (2026-07-12, migration head 0126) — HISTORICAL, superseded by the box above:** **A–Y all shipped & merged, plus AA–AG.** *(Update 2026-07-12: since the 2026-07-07 / head-0117 snapshot below, Phases **AF** (task management + Inbox retirement, migs 0118/0120/0121), **AF-11** (tag unification), and **AG** (multi-tenant RBAC — `owners.role` + operator-gated `/api/accounts`, mig 0125) have shipped, along with ship-readiness/hardening work: seed-identity scrub (0122), `auto_mode` drop → `trust_mode` (0123), in-app Google setup + auto-provisioned Web Push VAPID keys via `app_config` (0124), and base **category** tags Personal/Professional/Social (0126). The license was **CI-Commercial-1.0**, not MIT (it has been PolyForm Noncommercial 1.0.0 since 4.2.0). **Migration head is now 0126.** The head-0117 numbers in the paragraph below are the prior snapshot.)* Since the previous status (2026-07-01, head 0086), the following have landed to main: **O** (gamified five-star day, migs 0087–0090, #191/#192/#193/#198), **P** (planner hygiene — recurrence horizon + Clear Date Range, #188/#190), **Q** (schema hygiene, migs 0092–0094, #205), **S** (schema consolidation — `daily_recap`, `tag_prefs`, migs 0095–0097, #207–#211), **T** (multi-tenant owner-scoping, migs 0098–0100), **U** (CI-Portal OIDC + local auth, migs 0101–0102, #230), **V** (password reset, migs 0103–0104, #232), **X** (MCP intent vocabulary, #234/#237), and **Y** (env-config, #217). **Phase Z — Time-Sense** (Focus Ritual + calibration loop) has landed behind the `time_sense_enabled` master flag (flag-off = behavior-neutral; migs 0106–0109, PRs #246/#251/#257), alongside the **calendar / UI feedback waves** (QuickAdd-in-Today, Planner de-scroll, Flight-Plan tabs + saved-blocks + search, three-axis tag filter, click-to-add, day-type picker, collapsed night hours — #240–#256). **Phase W** (a **GraphQL CRUD layer alongside** the untouched REST API, at `POST /api/graphql`) is **✅ done** — every type W1–W13 + W-sandbox + W-close is merged (the full tag/task/block/flight-plan/pattern/day-type/life-planning/inbox/notification/prefs/admin/engine-ops surface; #235/#238/#243–#285 and the W-close perf-index migration 0112); the board is [W-graphql-crud.md](W-graphql-crud.md). The separate **naming-consolidation "Z"**: **W2** (tag-axis revert `pattern`→`direction`, mig 0105, #239) shipped; **W1** (`patterns`→`routines` table rename) and **W4** (drop vestigial `auto_mode`) remain **planned/unbuilt**. Since then, **Phases AA–AE** (migs 0113–0117) have shipped: **AA** (CI-Portal `companion-memory` pull-first integration behind `memory_pull_enabled` — connector, `memory_suggest` inbox agent, memory Daily Brief, memory-aware autoplan ordering + estimate, and one-way `push_memory` sync behind `memory_sync_enabled`), **AB** (natural scheduling — `scheduled_for`/`task_time` = START intent), **AC** (Today + Tasks UI overhaul — header-row popovers + FAB, Routine grouping + midnight `reset_routines`), **AD** (calendar reliability — `task_time` honored everywhere, container→task direction inheritance, Alt-drag), and **AE** (reflow correctness — snapshot-based reflow so a task edit can't wipe other placed blocks, plus status parity / not-before-now clamp / locked-block guards). **Migration head is now 0117** (`0117_push_memory_job`; runner applies 0001 → 0117 on boot). The §3b `patterns`→`routines` rename stays **deferred** (the as-built `patterns` naming stands; see GLOSSARY and naming-Z W1). *Superseded planning docs now live in [archive/](archive/); see [archive/README.md](archive/README.md).*

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
| D1 | Auth model | Single-owner now; owner-scoped data model | unchanged. ⚠️ **Superseded by Phase T/AG (2026-07-12):** the "single-owner until a real driver exists" posture is retired — the flip happened. Every table/route is owner-scoped (T), and **AG** shipped real multi-tenant RBAC: `owners.role` (mig 0125) drives scopes at one choke point (`lib/auth/scopes.ts` `roleToScopes`, unknown role → read-only), with `operator`/`member`/`viewer`, an operator-gated `/api/accounts`, and OIDC auto-provision defaulting to `member`. The Principles bullet "Single-owner until a real multi-user driver exists" is likewise historical. |
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
| | **H** Notifications + service worker / Web Push | B0 (G for pattern-reminder content) | M | ✅ done (#100–#102) — live; the server generates a VAPID keypair on first boot unless the env pins one (`services/vapid-config.ts`) |
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
| | **W** GraphQL CRUD layer *alongside* REST (`POST /api/graphql`, Apollo 5 + Koa 3) | T, U | L | ✅ **done** — full W1–W13 + W-sandbox + W-close surface merged (perf-index mig 0112); board [W-graphql-crud.md](W-graphql-crud.md) |
| | **Z** *(naming consolidation — separate phase)* tag-axis revert `pattern`→`direction`; `patterns`→`routines`; drop `auto_mode` | — | S | ◐ **partial** — W2 done (mig 0105, #239); W4 done (mig 0123); W1 planned/unbuilt |
| | **AF** Task management + Inbox retirement · **AF-11** tag unification | — | M | ✅ done (migs 0118/0120/0121) |
| | **AG** Multi-tenant RBAC (`owners.role` → `roleToScopes`; operator-gated `/api/accounts`) | T, U | M | ✅ done (mig 0125) — supersedes **D1** |
| Post-AG *(no phase letter)* | **Life priorities** — `/priorities` wizard + `/balance` dashboard; sleep reserved from the weekly pool | AG | M | ✅ done (migs 0127/0128, #356) |
| | **ENTITY** — wizard gating · confirm-before-delete · promote-task-to-objective (Planner + picker) · **objectives archive + 48h purge** | N, AF | M | ✅ done (#357–#360, #363 → PRs #362–#368; migs 0129/0130). Archive leak follow-ups #369–#372 |
| | **ENTITY-5** Spike — objectives as Planner block groupings | ENTITY | S | ✅ **closed (#361)** — decided (option c, non-geometric accent); see [objectives-in-planner.md](objectives-in-planner.md). Step 1 (the accent) shipped as #386 |
| | **FTUE / weekly-planning assistant** — T1–T14 (session logs · "Plan my week" · deterministic branches · LLM hybrid follow-ups · onboarding wizard) | AG | L | ✅ **done** — 14/14 tickets closed (#337–#350) as of 2026-08-13; doc `ftue-plan.md` §1 is stale |
| | **Multi-user shared events** — M1–M5 (outbound share · share chip · cross-owner comments · comment UI · structured apply) | FTUE | L | ⏸ **deferred** — 5 tickets (#351–#355); nothing built (no share or comment tables or routes) |
| Post-FTUE *(no phase letter)* | **AH** Focus × Time Blocks — lock model · Focus sections · auto-nest · mobility ladder · day-type reflow · classification learning · honest Open Time | AG | L | ✅ done — all 9 phases merged (PRs #543–#561; migs 0148–0150); [AH-focus-timeblocks.md](AH-focus-timeblocks.md) |
| | **Learning loops** — classification · dismissals · plan-loop revisions · placement · Triality weights, each an evidence log + a weekly `calibrate_*` job | AH | L | ✅ done (migs 0139–0144, 0149/0150, 0157/0158, 0162/0163, 0166/0167); ticket waves in `docs/factory/` |
| | **People on work** — Responsible & Beneficiaries on tasks and time blocks | AG | M | ✅ done (#574, migs 0151–0154) — [people-on-work.md](people-on-work.md) |
| | **Balance targets → scheduler** · close ritual (1–5 rating) · trust dial as an ordering policy | N, AG | M | ✅ done (#590, migs 0164/0165 · 0137/0161 · #605, mig 0171) |
| | **Release readiness for 4.2.0** — real Portal sign-in, invite-code sign-up, security headers, local release gate, PolyForm license | U, V | M | ✅ done (#619, #622, #625; mig 0172) |
| | **Mobile shells** — Capacitor iOS and Android apps for a server you run, polling sync | L | M | ◐ built, **not store-ready** (#629–#631; CHANGELOG `[Unreleased]`) |

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
- **Z — Naming consolidation** ◐ *separate phase.* W2 (tag-axis revert `pattern`→`direction`: `tags.kind='direction'`, `tag_directions`, GraphQL `TagKind=DIRECTION`) **shipped** (mig 0105, #239). W4 (drop vestigial `auto_mode`) **shipped** (mig 0123; the top-bar trust dial (Cautious · Balanced · Hands-off, `TrustModal`) drives `trust_mode`, and since mig 0171 `planning_mode` is read independently of it). W1 (`patterns`→`routines` table rename) remains **unbuilt/planned**.

**UI / calendar feedback waves** ✅ (owner feedback, landed): QuickAdd mounted in Today (#241), Planner de-scroll (#240), Flight-Plan tabs + saved-blocks + search (#242), calendar three-axis tag filter (#247), calendar container-outlines + click-to-add + no-task-drag (#248), select-date → day-type picker (#253), collapsed night hours (12am–7am / 9pm–midnight, #256).

**W — GraphQL CRUD layer** ✅ *done.* Adds a GraphQL surface **alongside** the REST API (REST is untouched/authoritative), mounted at `POST /api/graphql` — Apollo Server 5 + `@as-integrations/koa` on Koa 3, schema-first hand-authored SDL, introspection on, a custom complexity-limiter plugin (not `graphql-query-complexity`), `graphql` pinned to 16.x. Under `requireAuth`; the resolver context reads `currentOwnerId()` from the same `AsyncLocalStorage` the REST routes use. **Decision 3:** every resolver calls the existing `services/*.ts` functions and never re-derives owner-scoping — so a shared service layer (`services/tasks.ts`, `services/blocks.ts`, alongside the pre-existing `services/tags.ts`) was extracted so REST + GraphQL share one owner-scoped implementation. Files live in `server/src/graphql/`. **Live board: [W-graphql-crud.md](W-graphql-crud.md).**
  - **Shipped (merged):** step-1 bootstrap #235 · TagType #238 · Z-W2 `TagKind` flip #239 · `services/tasks.ts` extract + owner-scope hardening #243/#244/#245/#249 · `services/blocks.ts` extract #254 · TaskType #255 · TimeBlockType #259 · Taggable forward tags (Task/TimeBlock implement `Taggable`, `EntityTagType.tags`) + `entity_tags.created_at` (mig 0110, table rebuilt to NOT NULL DEFAULT CURRENT_TIMESTAMP) #262.
  - **Types live:** TagType (+ direction/intention/category hierarchy connections, `TagType.entities` reverse edge), TaskType, TimeBlockType, EntityTagType (forward `Taggable.tags` on Task + TimeBlock), FlightPlanEntryType, Pattern/PatternBlock/PatternPref family, DayType + TagPref, Objective/Reflection/DayStars/DailyRecap (+ `TaskType.objective`), PossibleTask/BlockTemplate, Reminder/PushSubscription, SchedulingPrefs, ScheduledJob/JobRun (admin scope), plus mutation-only engine ops. Node/Connection/Edge/PageInfo/DateTime/JSON conventions match CI-Server.
  - **All tickets shipped (merged):** W4b (TagType.entities reverse edge, cross-table Node union) · W5 FlightPlanEntryType · W6 routine/pattern family (Pattern/PatternKind/PatternBlock/PatternPref) · W7 DayType + TagPref · W8 life-planning (Objective/Reflection/DayStars/DailyRecap; TaskType.objective wired) · W9 inbox (PossibleTask/BlockTemplate) · W10 notifications (Reminder/PushSubscription) · W11 SchedulingPrefs · W12 admin (ScheduledJob/JobRun, behind the admin scope) · W13 mutation-only engine ops (autoplan/find-slot/instruct) · W-sandbox (in-browser GraphiQL IDE — self-hosted vendored GraphiQL, no CDN; `GET /api/graphql/sandbox`, flag-gated `GRAPHQL_SANDBOX`, prod-off) · **W-close** (perf-index migration 0112 + docs sync + cross-type adversarial sweep).

**AA–AE — memory, natural scheduling, UI, reliability** (2026-07, migs 0113–0117):

- **AA — Memory-aware agentic layer** ✅ *flag-gated (`memory_pull_enabled` / `memory_sync_enabled`, both default 0).* Pull-first, read-only CI-Server `companion-memory` integration. **AA0** connector (`connectors/memory.ts`, fixture/live, per-owner creds in `connection_tokens` provider `ci_memory`) + **AA0b** CI-Portal OAuth (PKCE + `offline_access`, self-refresh); **AA1** `memory_suggest` job (0113, every 6h) stages next-48h events as Inbox items; **AA2** memory-informed Daily Brief; **AA3a** memory-aware autoplan ordering (`memoryCmp` band after theme, before deadlines) + **AA3b** history-based default estimate for memory-drafted tasks; **AA4** one-way `push_memory` job (0117, daily 02:00). Flag-off = byte-identical. Migs 0113 (flag + job), 0114 (possible_tasks owner-scoped dedup + `proposed_estimated_minutes`), 0115 (`proposed_scheduled_for`/`proposed_task_time`), 0117 (push job). #290/#298/#299/#301/#302. Docs: docs/AA-memory-agentic.md, docs/AA3-smarter-autoplan.md.
- **AB — Natural scheduling** ✅ `scheduled_for` + `task_time` are START intent that drives placement (`placeStartAnchoredTask`); `due_at` is a deadline only. AB1 engine + AB2 memory-event mirroring shipped; AB3 (client click-to-create: `lib/create-click.ts`, Planner and Calendar) and AB4 (the pinned Due card on Today: `lib/task-buckets.ts`, `Today.tsx`) shipped later. Doc: docs/AB-natural-scheduling.md.
- **AC — Today + Tasks UI overhaul** ✅ Today single header row (Brief · Focus · Note popovers) + FAB + collapsible DUE; Tasks task-chip redesign (merged direction-icon/done toggle), Routine grouping + end-of-day archive + midnight `reset_routines` job (0116). #292/#295.
- **AD — Calendar reliability** ✅ `task_time` honored across quick-add + flight-plan (was: 2pm task landed at 10am); container→task direction inheritance; Alt-drag free placement; New-Task 2-col layout (Due defaults to Start). Doc: docs/AD-calendar-reliability.md.
- **AE — Reflow correctness** ✅ Snapshot-based reactive reflow (clear set == re-place set, so a task edit can't wipe other auto-placed blocks); placement status parity (`open`↔`scheduled`, `task_time` stays user-only); not-before-now clamp; locked-block guards across reschedule/review/sweep; replan trigger narrowed to scheduling-relevant edits; legacy `runScheduler` removed. #296 (PR 1) / #297 (PR 2). Doc: docs/AE-reflow-correctness.md.

**Migration head — new tables/columns since 0105** (what 0105-era docs miss): 0106 `scheduling_prefs.time_sense_enabled` · 0107 `estimate_calibration` scope columns · 0108 per-cue focus prefs on `scheduling_prefs` (`focus_ritual_enabled` / `haptic_cues_enabled` / `ambient_color_enabled` / `calibration_loop_enabled` / `z_experiment_arm`) · 0109 `copy_history` (Time-Sense voice-loop anti-repetition; not in owner export) · 0110 `entity_tags.created_at` (NOT NULL DEFAULT CURRENT_TIMESTAMP) · 0111 `scheduling_prefs.view_prefs` (cross-device calendar view-state JSON blob) · 0112 GraphQL perf indexes (`idx_tags_owner_kind_name_id` + composite `(parent, child)` on `tag_directions` / `tag_categories`; drops the now-redundant single-col prefixes). **Migration head was 0112 at this point.** From T/U/V: 0098 `sync_events` owner FK · 0099 `time_blocks.owner_id` NOT NULL · 0100 `tags.owner_id` · 0101 owners auth columns (`external_subject` / `username` / `password_hash`) · 0102 `auth_states` · 0103 owners reset columns (`backup_email` / `session_epoch`) · 0104 `password_reset_tokens`. From AA–AE: 0113 `scheduling_prefs.memory_pull_enabled` + `memory_suggest` job · 0114 `possible_tasks` owner-scoped dedup key + `proposed_estimated_minutes` · 0115 `possible_tasks.proposed_scheduled_for`/`proposed_task_time` · 0116 `reset_routines` job · 0117 `push_memory` job. **Migration head was 0117 at this point** (0118–0138: see the 2026-08-13 box; 0139–0172: see the box at the top).

**Known-deferred / not-blocking:** G-INT timing intelligence · L three P3 sync gaps · S optional D1/D2/D3 · Google live mode needs real creds (the in-app Google setup stores them, 0124) · naming-Z W1 · AA live-smoke against a real CI-Server (fixture-mode verified; no reachable CI-Server graph API yet). *(Web Push no longer needs hand-set VAPID keys, and W4, AB3 and AB4 have shipped.)*

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

> ✅ **Shipped** (see the Phase map) — migrations 0076–0079, field-level merge, `POST /api/sync`, SSE catch-up (`Last-Event-ID` replay + overflow `id:` cursor advance), client op-log (IndexedDB), optimistic mutations + 404-rollback, persistent conflict banner, SW push-wake flush, `sync_events` daily prune job, `field_ts` seeding from `updated_at`. All P1 + P2 gaps closed. Full implementation spec: [L-multi-device-sync.md](archive/L-multi-device-sync.md).
**Goal:** PWA offline write path; converge across a single owner's devices.
- **Infra:** client offline op-log (IndexedDB); server apply with a **monotonic per-record version** and **field-level merge** (not whole-record LWW); **completions are monotonic** — a concurrent edit can't silently un-complete a task. SSE pushes authoritative state; genuine conflicts surface a persistent banner (not a toast).
- **Tests:** 25 server-side (22 apply + 3 SSE catch-up) + 18 client-side (10 oplog + 8 conflict-store); 96 server test files green.
- **Acceptance:** offline edits appear after reconnect with no data loss; concurrent edits converge predictably; **no lost completions** (now actually achievable, vs v1's LWW which contradicted this).
- **Deferred (P3 only):** `baseVersion` staleness fence (gap 1/2), `time_blocks` owner check (gap 5), client version in optimistic state (gap 6). None affect current correctness. See [known gaps](archive/L-multi-device-sync.md#known-gaps-prioritized-backlog).

---

### M — AI scheduler (real LLM planning + reactive reflow + stub-backing) *(new — absorbs K)*

> ✅ **Shipped** (migs 0062–0067, #146–#148, per the Phase map). Full implementation spec: [M-ai-scheduler.md](archive/M-ai-scheduler.md). Renamed from the draft `L-ai-scheduler-plan.md` (L is Multi-device sync). It builds on the autoplan engine (#121–#129).

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
  *(As of 2026-11-01 the GitHub Actions workflows are manual-dispatch only (#618); the merge gate is run locally: `pnpm typecheck && pnpm build && pnpm test`, plus `tests/container/run-local.sh` for the container smoke.)*

**Security.** A written **threat model + security review is a scheduled deliverable of Phase I**, not an afterthought — it gates the entire cloud track.

**Scale budget (new).** The scheduler sorts the whole open set each run, and recurrence (E) materializes instances — both grow unbounded by default. Set explicit budgets: cap the recurrence horizon, index `owner+status+due`, and add a perf assertion (schedule a 1k-task day under N ms) once E lands.

## Effort shape (sequencing only)
B0 **S** · C M · D S–M · E M · F **L** · G M · H M · R S–M · I **L** · J **L** · K M · L **L**.

> **Net change from v1:** a paying customer gets recurrence, a real calendar, time tracking, rituals, notifications, **and** backups before a line of auth is written — and the auth, when it comes, is verify-only and roughly half the surface.
