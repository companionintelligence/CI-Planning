# Recap — state of Phases A–S (open issues, deferrals, gaps, invariants)

**Created:** 2026-07-02 · **Verified against live code at migration head `0097`** — an adversarial multi-agent pass (6 fact-checkers, 125 tool calls) confirmed the load-bearing claims below against `server/src` and flagged the stale ones. **Purpose:** a single durable snapshot of what phases **A through S** shipped, deliberately deferred, and the invariants a future reader must not break — so the completed A–S phase specs can be archived without losing their loose ends, and the release-readiness track (**T–Y**) has a clean hand-off. Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), and [HANDOFF-multitenant.md](HANDOFF-multitenant.md) (the multi-tenant kickoff).

> This is a recap, not a plan. **[ROADMAP.md](ROADMAP.md)** stays the plan of record; **[GLOSSARY.md](GLOSSARY.md)** the canonical vocabulary. Phases **Q** and **S** deliberately stay **live** (not archived) — the multi-tenant handoff points the next phase directly at them (see [§9](#9--which-as-docs-are-archived)).

---

## 0 · Ground truth (verified 2026-07-02, migration head `0097`)

- **All of Phases A–S are merged to `main`.** Q (schema hygiene, `0092–0094`, #205) and S (consolidation: **S1-A** `0095` #208 · **S1-B** `0096` #209 · **S2** `0097` #211) are all landed; a docs handoff (#212) is HEAD. **Migration head = `0097`. There are no open A–S PRs.** (Earlier drafts of this recap said "S2 #211 still open / head → 0097 pending" — that is now stale; S is done.)
- **`schema.ts` is intentionally NOT a complete source of truth.** `daily_recap` (0096) is **migration-only** — it has no Drizzle object; `tag_prefs` (0097) does (`schema.ts:325`). The only committed drift guard is `server/test/schema-parity.test.ts`, which checks column parity for **one** table (`tag_prefs`). The repo-wide `check-schema-drift.ts` CI guard + full `schema.ts` reconciliation described in `RELEASE-READINESS-REVIEW.md` were **never committed** (that review is itself an untracked draft). **Treat "schema.ts lists every table" as false** — material for T, which must not assume it.
- **Stale doc string to fix (doc-only):** `ARCHITECTURE.md:52`'s system diagram still labels the migration runner *"0001–0094 on boot"* while the header says `0097`. Fix in a doc pass.
- Single-owner today (`owners.id` = the `SYSTEM_OWNER_ID` UUIDv7 sentinel); local-first SQLite (better-sqlite3 + Drizzle), Koa API + SolidJS client; ids are UUIDv7 TEXT since `0030`.

---

## 1 · Shipped-state snapshot (phase by phase)

| Phase | What it delivered | Status | Key PRs / migrations |
|---|---|---|---|
| **A** Scheduler + today-set | Deterministic scheduler; reframed by G as the flight-plan **Auto** engine; tag-driven autoplan | ✅ shipped | autoplan #121–#129; `0048`/`0052` (`auto_mode`, later superseded by `trust_mode` `0070`) |
| **B0** Migration runner + owner scoping | `schema_migrations`, `pnpm migrate`, `lib/context.ts`, owner-scoped `broadcast` | ✅ shipped | runner + `0001/0002` |
| **C** Rich task semantics | `scheduled_for`≠`due_at`, `defer_until`, `task_dependencies`, NL quick-add (`chrono-node`) | ✅ shipped | `0003`/`0004` |
| **D** Time tracking | `actual_minutes`, `time_entries`, one-running-timer-per-owner | ✅ shipped | `0010`/`0011` |
| **E** Recurring & habits | `rrule.js` recurrence, bounded generation job, streaks | ✅ shipped (E′ superseded — habits stayed **task-level** `subtype`) | archived spec |
| **F** Calendar grid | 2-D grid, drag/resize, all-day, overlays; **F′** shipped under G | ✅ shipped | grid PRs |
| **F2** Calendar improvements | Dynamic day-start, day-type textures, block-container outlines, direction filter | ⛔ **NOT built — all tickets not-started** (F2-5 → Phase O) | none |
| **G** TODAY cockpit, Time-Blocks, Patterns | Cockpit, flight-plan, Auto, PLANNER, textures | ✅ shipped (#60–65, #77) | UX canon = `design-today-cockpit.md` |
| **H** Notifications + Web Push | SW, VAPID, `push_subscriptions`, `reminders`, cron dispatcher | ✅ shipped (#100–102) · **needs VAPID keys to go live** | `00NN_notifications` |
| **I** Identity & auth | **API-key "standalone" path only**; encrypted token store; rate-limit; threat model | ⚠️ **PARTIAL — SSO/JWKS "PR2" never built** → **Phase U** | `0049_api_keys`, `0050_connection_tokens` (#116–120) |
| **J** Two-way calendar sync | Inbound `external_events`; extended by the Google-connector track | ✅ shipped | `0051`; connectors `0058–0061` |
| **K** Auto-defense | Continuous re-plan | ↪ **folded into M** (Workstream B) | archived spec |
| **L** Multi-device sync | Op-log, field-level merge, monotonic completions, SSE catch-up | ✅ shipped · **3 P3 gaps + offline-create deferred** | `0076–0079` (#184) |
| **M** AI scheduler | LLM authors `daily_plan`; deterministic reflow; back stubbed claims | ✅ shipped · **B1 cap / B4 dirty-rerun / A3 judge deferred** | `0062–0067`, `0071` (#146–148) |
| **N** Life-planning | Objectives hierarchy, reflections, morning brief, weekly review, calibration | ✅ shipped · **N2 budget enforcement + N4 R4 deferred** | `0080–0087` (#185, #189, #191/#193) |
| **O** Gamified 5-star day | 5 derived stars, freeze job, calendar heatmap, FOCUS card | ✅ shipped · **O4 streaks not specced** | `0088–0090` (#198) |
| **P** Planner hygiene | Recurrence-horizon pref + Clear Date Range | ✅ shipped | `0091` (#197/#200/#201) |
| **Q** Schema hygiene (pre-MT) | FK enforcement + indexes, owner-identity NOT-NULL rebuilds | ✅ shipped · **multi-tenant bridge intentionally deferred to T** | `0092–0094` (#205) |
| **R** Backups/restore/export | Snapshots, export/import, append-only `audit_log` | ✅ shipped | (#108–110) |
| **S** Schema consolidation | S1-A drop `plan_outcomes`; S1-B `daily_recap`; S2 `tag_prefs` | ✅ **shipped (all three)** | `0095`/`0096`/`0097` (#208/#209/#211) |

---

## 2 · Open items, deferrals & gaps — by phase

### A — Auto-scheduling
- **Deferred:** manual-overlap is a separate user-driven path (G), not the Auto engine.
- **Invariant:** *deterministic core stays deterministic — AI assists ordering/tagging only, every AI path needs a deterministic fallback when Ollama is down.* Fixed direction vocabulary `HOME/WORK/COMMUNITY`.
- Note: `scheduling_prefs.auto_mode` (mig `0052`) was **superseded by `trust_mode`** (`0070`); the column is vestigial. It is **not** an env var.

### B0 — Foundation
- **Deferred to I:** tokens/JWT/JWKS, sessions, API keys, CSRF, login. Owner resolver returns `SYSTEM_OWNER`.
- **Invariants:** SQLite `ALTER` is weak → **forward-only / expand-contract, no reversible migrations**; `better-sqlite3` sync → migration `up()` is sync; explicit ordered migration array (no dynamic import); **FK pragma must be restored after any rebuild** or later inserts silently skip enforcement. CI grep gate forbids owner-id literals in `routes/`/`engine/`.

### C — Task semantics
- **Deferred:** recurrence (E), actuals (D), AI ordering (G); soft-delete of dependency edges, transitive auto-completion; reconciling legacy `status='deferred'` enum vs `defer_until` (punted to G).
- **Invariants:** `chrono-node` needs a fixed `refNow` (tests pin it); `enrichQuick` (LLM) is **strictly additive** — never overrides a chrono-certain field; `scheduled_for` is a **local date string**, not a UTC instant; blocked tasks are neither scheduled nor `unscheduled`.

### D — Time tracking
- **Deferred / unscheduled:** no manual time-entry editor UI; **no cross-task rollups/reports** (the old "Phase G weekly review" that would aggregate them was dropped in the 2026-06-20 reconception; partly picked up by N's weekly review). No idle-detection/auto-pause; no LLM in the hot path.
- **Precision (verified):** the `time_entries.source` **column** can hold `'manual'`, but **no route or UI currently writes a `'manual'` entry** — the timer only emits `'timer'`/`'block'` (`services/timer.ts:114-117`). So "manual entry" is a schema affordance, not a live feature.
- **Invariants:** one running timer **per owner** (partial unique index); estimate suggestion is **per-tag** (per-task too sparse); `actual_minutes` recomputed as SUM; duration must survive a DST boundary.

### E — Recurring & habits
- **Deferred / rejected:** calendar rendering (F), AI habit-ordering (G), two-way sync (J), missed-habit reminders (H); sub-daily recurrence + RRULE set-arithmetic beyond single-rule+`EXDATE` **rejected at validation**.
- **E′ superseded:** habit-as-Pattern-type was **not built** — habits stayed **task-level** (`subtype`/`is_habit`).
- **Invariants:** **rrule.js owns the recurrence pattern only; `lib/tz.ts` owns every wall-clock→UTC conversion — never pass IANA zones into rrule.js.** Horizon cap + `INSERT OR IGNORE` are the **scale-budget contract**. Generator degrades gracefully (skip a malformed rule, never fail the run).

### F / F2 — Calendar
- **F deferred:** no drag-to-create; no cross-day drag in week view; all-day not vertically draggable.
- **F2 is entirely UNBUILT** — F2-1 (dynamic day-start), F2-2 (date-header Day-Type popover), F2-3 (day-type texture columns + batched read routes — note a `/api/day-types/week-map` batch route already exists but serves the shipped week grid, **not** the unbuilt F2-3 `resolve-many`), F2-4 (Time-Block container outlines), F2-6 (direction filter facet) are all **not-started**; F2-5 was **deferred to Phase O**. **Live collision risk if built:** F2-2/F2-4 touch the same `CalendarGrid.tsx` date cells Phase O's Lane C touched.
- **Invariant (the trap):** position math uses **real elapsed ms (`getTime()` deltas)**, never `start_at.slice(11,16)` wall-clock arithmetic; `instantFor`/`minutesIntoDay` are the only sanctioned converters (grep-gated).

### G — Cockpit
- **Deferred (`G-INT`):** pattern **timing intelligence** (relative anchors, proximity/type ranking, learned ordering) and **pattern nesting** (schema declares patterns "tasks-only, no nesting in V1"); reflection/weekly-review screens dropped from G. Still deferred (verified — no timing-intelligence/learned-ordering engine exists).
- `planning_mode` (`auto|ritual`) **retired**. Two overlap behaviors coexist: cockpit PLANNER collision-clamps; standalone Calendar keeps overlap **allowed-but-flagged**.
- **Invariant:** placement ⇄ task in lockstep — moving/resizing a block writes the linked task's `scheduled_for`+time (earliest session owns them; tz-correct in owner zone).

### H — Notifications
- **OPEN OPERATIONAL:** `.env.example` ships **empty** `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` — **push is disabled until keys are generated + set** (in-app SSE reminders still work). VAPID keys are deployment identity; rotating invalidates all subscriptions; never commit them.
- **Deferred:** no RRULE reminders (single `fire_at`), no quiet-hours/digest/per-channel UI, no FCM/APNs.
- **Invariant:** SW is **read-through cache only** or installs strand; dispatcher granularity 1 min (never early, never twice); `userVisibleOnly:true` mandatory.

### I — Identity & auth  ⚠️ the biggest carry-forward (feeds U)
- **SHIPPED (PR1, verified):** API-key "standalone" mode — `apiKey.ts` (`randomBytes(32)` hex, `cpk_`+5-char prefix, **SHA-256 at rest**, `timingSafeEqual`); `requireAuth` guard (401 on every `/api` route + SSE via `?api_key=`, 403 on scope mismatch); rate-limit; **AES-256-GCM connection-token store** (`crypto/index.ts`, `0049`/`0050`; `connection_tokens` = iv/authTag/ciphertext/keyVersion).
- **NOT SHIPPED (PR2) → becomes Phase U (verified):** the **JWKS verify-only SSO Bearer path**. There is **no `auth/jwks.ts`**; `requireAuth.ts:16,64` and `config.ts:16,17,19` still carry `// (PR2)` markers; the `'sso'` mode has **no verify branch** (requireAuth dispatches only `test` + `standalone`). **`owners.external_subject` column does not exist.** The only JWKS code in-repo verifies **Google's** id_token for the calendar connector (`routes/oauth.ts`, `CP_GOOGLE_JWKS_URI`) — unrelated to Hub login.
- **Env (verified in `config.ts`):** active — `AUTH_MODE` (`test|standalone|sso`, default `test`; **hard-fails at boot in production**), `AUTH_RATE_WINDOW_MS`/`AUTH_RATE_MAX`/`AUTH_RATE_ISSUE_MAX` (60000/60/5), `CP_KEK_B64`/`CP_KEK_VERSION`. Reserved-but-dormant (populated into config, no consumer): `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` (`companion-planning`), `AUTH_CONTRACT_VERSION` (`1`), `AUTH_AUTO_PROVISION`.
- **Design stance to preserve:** verify-only, **never mints tokens**; RS256/EdDSA only; **D6** — match CI-Server's connection-token crypto against a *published versioned contract*, confirmed at build time.

### J — Calendar sync
- **Deferred:** no semantic/embedding matching for sync identity (**`external_id`+`etag` only** — grep-gated); no recurrence expansion of remote series.
- **Invariants:** always send `If-Match` on outbound; treat cancelled *and* vanished events as delete-the-mirror; per-event transactions; `external_events.owner_id NOT NULL` from `currentOwnerId()`. **Env `GOOGLE_MODE`** gates fixture-vs-live.

### L — Multi-device sync
- **Shipped since the doc was written (verified — update your mental model):** objectives **are now in the sync allowlist** (`apply.ts` `OBJECTIVE_FIELDS`/`OBJECTIVE_TASK_FIELDS`, mig `0087`), and **`scheduled→open` is monotonic-guarded** (`applyMonotonic` pins `scheduled` against regression to `open`, `apply.ts:88-90`). The N/L handoff's "ship option A" item is **done**.
- **Still deferred (P3, none affect current correctness):** **Gap 1/2** — `baseVersion` staleness fence unused (`applyOp` never reads `op.baseVersion`); **Gap 5** — `time_blocks` has **no `owner_id`**, so `applyOp` has **no owner check for `block` entities** (only `task`/`objective` are owner-guarded; blocks are "scoped implicitly by session auth") — *directly a Phase-T item*; **Gap 6** — client version not tracked in optimistic state (client-side, unverifiable from server). **Offline create** not built (`applyOp` 404s on missing rows; sync is PATCH-only, no temp-id rewrite).
- **Invariant:** completions are **monotonic**; whole-record LWW is **banned**; `clientTs` is only a same-field tiebreak.

### M — AI scheduler
- **Deferred (verified still open):** **B1 displacement cap (`MAX_MOVES_PER_RUN`)** — no such constant exists in the engine; churn bounded structurally. **B4 targeted `scope='dirty'` rerun** — `POST /api/plan/reauthor` does a **full force re-author** (`plan.ts:85-98`); no dirty-set path. **A3/A4 per-block truthfulness judge** — `agents/plan.ts` emits one batch "why now" line with deterministic `sanitizeRationale`; the medium-tier judge scores at the **plan** level (3× median), not per-block.
- **Known issues (not fixed by M):** (1) **no whole-feature eval/ROI** — nothing shows LLM ordering beats the deterministic sort; (2) **in-memory B2 debounce map lost on restart** (B4 nudge made durable via `0067`, B2 not); (3) **four overlapping reschedulers** still need one user-facing explanation.
- **Invariants (load-bearing):** the LLM is **never** invoked during `reflow()` (nudge-first); generator ≠ evaluator; bounded recursion + append-only `audit_log` + escape hatch. **C1 overrun:** compute session span from `ended_at−started_at`, **not** `actualMinutes` (task-wide SUM). **C2 day_theme:** primary sort key (outranks deadline + priority), weekday from server tz — revisit when multi-tz lands. **C3 sqlite-vec:** dev Windows / deploy Mac — assert the fallback path in CI.

### N — Life-planning
- **Deferred:** **N2 budget *enforcement*** (verified — no scheduler biasing exists; read-only "intended X / spent Y" first); **N4 R4 feedback loop** — calibration is **read-only** (`calibrate-estimates.ts` writes only `estimate_calibration`, **never** `tasks.estimated_minutes`); the auto-writing loop is gated on the A/B showing LLM lift. Carry-forward opt-in only.
- **Open for owner:** (1) **Categories noun status** (formal noun vs `tags.kind='category'`); (2) `reflections.done_at` complete-toggle scope.
- **Handoff follow-ups — RESOLVED (verified):** the objectives parent-picker (#191) and full objective sync + monotonic guard (#193/`0087`) both shipped. `HANDOFF-objectives-followups.md` is effectively closed.
- **Invariants:** **`NULL ≠ 0`** for `progress_cache` (the rot signal); **level is DISPLAY-ONLY, server-derived from height**; N jobs write **zero `reminders` rows**; N4 **never auto-writes** `estimated_minutes`; the ordering generator never receives history (keeps placement reproducible).

### O — Gamified stars
- **Deferred:** **O4** (streaks / weekly totals) — verified not built (`stars.ts` has no streak/weekly-total logic; existing "streak" code is Phase-E habit streaks).
- **Done follow-ups:** orphaned `MorningBriefing.tsx` removed (#199); client jsdom + SolidJS test harness added (#202).
- **Open (owner's call, one-line flip):** empty-set rule for star S2/S3.
- **Invariants:** `EightPointStar` = **objective deep-link**; day-score is **5-point gold `#f4d35e`** only; a frozen day never recomputes (see freeze-guard below); S3/S4 count **non-habit, non-routine** tasks only.

### P — Planner hygiene
- **Locked (do not re-litigate):** clamp horizon inside **both** recurrence engines; P1 auto-prune deletes instances but does **NOT `UNTIL`-cap** rules; templates never deleted by P1; horizon prune passes `clearDailyPlan:false`.
- **Footgun:** recurring block **instances are stamped `is_auto=0`** — a delete filter keyed only on `is_auto=1` wrongly spares them; also key on `recurrence_parent_id`/`source_kind='pattern'`.
- **Multi-tenant touchpoint:** **`time_blocks` has NO `owner_id`** (single-owner era; created in the `0001` baseline, still owner-less) — P keeps block queries global.

### Q — Schema hygiene (pre-multi-tenant)  ← stays live (feeds T)
- **Shipped:** `0092` FK indexes; `0093` `flight_plan.owner_id` TEXT NOT NULL; `0094` drop `daily_summaries` bogus `owner_id DEFAULT 1`; shared `openDb()` (`db/open.ts`) sets `foreign_keys=ON`; integrity-check test is a standing CI net.
- **Explicitly deferred / declined:** **`scheduling_prefs` split — DECLINED by owner (2026-07-01)**, don't split in the hygiene phase *or* multi-tenant phase. Tier-2 "design-first, do not implement": recurrence unification, single-source "default minutes" (~7 cols / 5 tables), JSON-in-TEXT validation, table-count reduction.
- **THE MULTI-TENANT BRIDGE — deferred to Phase T** (see [§8](#8--multi-tenant-readiness-ledger-feeds-t); this section of Q is the canonical map the handoff points at).
- **Invariants:** STALE-worktree trap (branch fresh, confirm head); `manual=true` + `rebuildTable` use `PRAGMA foreign_keys=OFF` and it works; **old migrations lie about declared types** (INTEGER cols hold TEXT UUIDs post-`0030`) — trust `schema.ts` for a column's *logical* type, but remember it isn't a complete table list ([§0](#0--ground-truth-verified-2026-07-02-migration-head-0097)); Copilot autofix may push to the PR branch — reconcile, don't force-push.

### R — Backups / restore / export
- **Shipped:** scheduled snapshots, `GET /api/export` / `POST /api/import`, append-only `audit_log`, every mutating route writes an audit row. `EXPORT_VERSION` is now **`'3'`** (bumped across the S consolidation).
- **⚠️ MULTI-TENANT LANDMINE (verified, still live — feeds T):** `backup.ts` **still full-wipes the owner-less tables** on restore — `sqlite.exec('DELETE FROM time_blocks')` (`:186`, comment *"v0.2 single-owner: full wipe (incl. containers)"*), `DELETE FROM tags/tag_patterns/tag_categories/category_direction_optouts` (`:194-198`), and `entity_tags` for all `time_blocks` via `UNION SELECT id FROM time_blocks` (`:181`). Export selects for these are **unfiltered** (`:65`, `:102-105`). The S refactor added an `OWNER_TABLES` list (`:10-23`) + bumped `EXPORT_VERSION` but **did not change the owner-less wipe/export**. The moment T adds `owner_id`, these become **cross-tenant data loss** — convert to `… WHERE owner_id=?` and owner-scope the exports **in the same PR** as the column addition.

### S — Schema consolidation (all merged)
- **As-built:** S1-A dropped `plan_outcomes` + retired its `aggregate_plan_outcomes` cron (`0095`, #208); S1-B merged `daily_summaries`+`day_stars` → **`daily_recap`** (`0096`, #209, one row per `(owner,date)`, `ON DELETE CASCADE`); S2 merged `pattern_prefs`+`category_prefs` → **`tag_prefs`** (`0097`, #211) with `kind` CHECK `IN ('pattern','category')` + `UNIQUE(owner_id, tag_id)`. Net **−3 tables** (`plan_outcomes`, `day_stars`, `category_prefs` gone; `daily_summaries`, `pattern_prefs` merged away). All four HTTP contracts (`/api/summary`, `/api/stars`, `/api/pattern-prefs`, `/api/category-prefs`) unchanged.
- **Resolved migration hazards (verified done):** the **freeze-guard now keys on `frozen_at IS NOT NULL`, not row-existence** (`jobs/freeze-stars.ts:56` early-returns on `existing?.frozen_at != null`; upsert `WHERE daily_recap.frozen_at IS NULL`; `routes/stars.ts:43` reads `AND frozen_at IS NOT NULL`) — so stars still freeze even after a summary pre-creates the row. The **two hidden raw-SQL readers were repointed** to `tag_prefs`: `engine/reminders.ts:135` (`… kind='pattern'`) and `routes/reflections.ts:43,52` (`LEFT JOIN tag_prefs … kind='category'`).
- **Note for W/GraphQL (verified):** S2 kept **both** `pattern-prefs` and `category-prefs` services *and* routes as distinct shapes over the one `tag_prefs` table — nothing collapsed at the API layer. A GraphQL/service reader must design against `tag_prefs` (kind-filtered) but **preserve both contract surfaces**, and remember the service layer is not the only reader.
- **NOT a multi-tenant prerequisite:** all five S/consolidation tables are **already `owner_id`-scoped** post-Q → tenant-clean. **Prioritize the owner-*less*-table work (T) over any further consolidation.**

---

## 3 · Cross-cutting invariants (the rules every phase relied on)

- **Determinism:** deterministic core + AI-assist on top; **every AI feature has a deterministic fallback**; the LLM **authors `daily_plan` once, determinism executes it forever** and is never called inside `reflow()`.
- **Time zones / DST:** never wall-clock-slice UTC strings; use `instantFor`/`minutesIntoDay` (grid), `lib/tz.ts` / `zonedWallTimeToUTC` (server), `localDateInTZ` (owner-tz "today"); `rrule.js` owns the recurrence pattern only; `scheduled_for` is a local date string.
- **Migrations:** forward-only / expand→backfill→contract, **no `down()`** (rollback = snapshot/Litestream restore); append-only immutable history; `up()` sync; `manual=true`+`rebuildTable` for retypes/merges with FK-OFF restored in `finally`; regenerate the `baseline.characterization` snapshot **deliberately** and eyeball the diff.
- **Owner scoping:** `currentOwnerId()` everywhere, `runWithOwner(SYSTEM_OWNER,…)` in crons, `broadcast(ownerId,…)`; CI grep gate forbids owner-id literals in `routes/`/`engine/`.
- **Test harness (repeat offenders):** tests run **sequentially against one shared, pid-keyed SQLite DB**; migrations run **on import**; add every new table to `resetDb()`; reproduce CI-only failures with **`TZ=UTC`**; **pin clocks — no `Date.now()` time-bombs** (a non-UTC time-bomb reddens CI near the day boundary; #210 killed one).
- **Anti-thrash:** never move the in-progress/locked/meeting/completed block; stability window + per-owner debounce.
- **Stacked-PR trap (from S):** a PR based on a *feature branch* (not `main`) merges into that branch, not `main` — prefer `main`-based PRs; `git ls-tree origin/main -- <path>` exits 0 even for a missing path, so verify with a real `grep`.

---

## 4 · The explicitly-deferred backlog (consolidated, verified still-open)

| Item | From | Notes |
|---|---|---|
| **`G-INT`** — pattern timing intelligence, proximity/type ranking, learned ordering, pattern nesting | G | deferred until there's history to learn from |
| **§3b Routine rename** (`pattern*`→`routine*` tables/routes/views) | Phase-0 reconciliation | DEFERRED — `patterns` tables still coexist with the tag-axis `pattern` value |
| **F2** entire phase (dynamic day-start, day-type textures, container outlines, direction filter) | F2 | all tickets not-started |
| **O4** streaks / weekly star totals | O | not specced/built |
| **N2 budget enforcement**; **N4 R4 feedback loop** | N | enforcement risks thrash; R4 gated on LLM-lift A/B (calibration is read-only) |
| **M**: displacement cap (B1), dirty-set rerun (B4), per-block truthfulness judge (A3/A4) | M | churn bounded structurally instead |
| **L P3**: `baseVersion` fence, `time_blocks.owner_id` check (Gap 5), client-version tracking; **offline create** | L | none affect current correctness; Gap 5 is a Phase-T item |
| **H**: VAPID keys not set → push not live; RRULE reminders, quiet-hours/digest UI | H | VAPID is operational; the rest are scope |
| **D**: manual time-entry editor UI; cross-task **rollups/reports** | D | no live `source='manual'` writer either |
| **Q Tier-2**: `scheduling_prefs` split (**declined**), recurrence unification, single-source default-minutes, JSON validation | Q | design-first / declined |

*(Resolved since their docs were written — not deferred: objectives-in-sync + `scheduled→open` monotonic guard (#193/`0087`); parent-picker option-disabling (#191); the S2 raw-SQL readers; the S1-B freeze-guard. All merged.)*

---

## 5 · Auth readiness ledger (feeds **U**)

`requireAuth` already dispatches **API-key (standalone)** ✓. **U** must build the second branch:
- Build `auth/jwks.ts` (`jose` `createRemoteJWKSet`+`jwtVerify`), RS256/EdDSA allow-list, pin `iss`/`aud`, cache with cooldown, fail closed. The `'sso'` mode currently has no verify branch.
- Add `owners.external_subject TEXT UNIQUE` (JWT `sub`→owner) — **one coordinated migration with T's `owners` changes**, not two.
- Resolve `AUTH_ISSUER`/`AUTH_JWKS_URL` against the real Hub OIDC discovery (external input owed). The `AUTH_*` config keys already exist but are dormant; the **rate-limit knobs** (`AUTH_RATE_WINDOW_MS`/`AUTH_RATE_MAX`/`AUTH_RATE_ISSUE_MAX`) are already active on the standalone path.
- Decide **verify-only resource server vs full RP login redirect** (U's open decision). U2 (local username/password), U3 (login screen/route guard), V (reset) are net-new on top; **no email-sending library exists** in the repo (V builds it from scratch).

## 6 · Env / config ledger (feeds **Y**)

- `server/.env.example` has **only 3 active lines** (VAPID×3); `OLLAMA_*`, `PORT`, `DB_PATH` are commented examples.
- `config.ts` reads **~26 app-config vars with no `.env.example` entry**: `SNAPSHOT_RETAIN`; `AUTH_MODE`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_CONTRACT_VERSION`, `AUTH_AUTO_PROVISION`, `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_MAX`, `AUTH_RATE_ISSUE_MAX`; `CP_KEK_B64`, `CP_KEK_VERSION`; `CP_GOOGLE_CLIENT_ID/CLIENT_SECRET/AUTH_URI/TOKEN_URI/REVOKE_URI`, `CP_OAUTH_REDIRECT_URI`, `CP_GOOGLE_ENABLE_GMAIL`, `CP_MCP_COMMAND/TIMEOUT_MS/RETRIES`; `CP_SYNC_WRITEBACK`, `CP_SYNC_DISABLED`; `GOOGLE_MODE`; `PUBLIC_BASE_URL`.
- **Env vars read OUTSIDE `config.ts`** (also undocumented — Y must include them): `CP_FIXTURES_DIR`, `CP_GOOGLE_ACCOUNT` (`mcp/google.ts`); `CP_MCP_BREAKER_THRESHOLD`, `CP_MCP_BREAKER_COOLDOWN_MS` (`mcp/client.ts`); `CP_GOOGLE_JWKS_URI` (`routes/oauth.ts`); `LOG_LEVEL` (`lib/logger.ts`); `GOOGLE_ACCESS_TOKEN` (`scripts/mcp-google-server.ts`). `CP_KEK_B64` is also read directly in `lib/crypto/index.ts` (not only via config).

## 7 · GraphQL / MCP notes (feed **W** / **X**)
- **W:** ~29 REST routers; resolvers must **call the same `services/*.ts` the REST routes call** — S proved the danger of raw-SQL readers bypassing services. Design types against the **post-S shapes** (`daily_recap`, `tag_prefs`) and **post-T owner scoping**; note the `/api/pattern-prefs` **and** `/api/category-prefs` contracts both persist over the single `tag_prefs` table.
- **X:** ~36 MCP tools; alignment blocked on CI-Server's vocabulary spec (external input).

---

## 8 · Multi-tenant readiness ledger (feeds **T**)

The single most important carry-forward. **The consolidation/hygiene tables are all already owner-scoped and buy nothing for tenancy** — the real blockers are the **owner-*less* tables** (verified @ `0097`):

| Owner-less table(s) | Why it leaks across tenants |
|---|---|
| **`time_blocks`** | **Blocker #1** — no `owner_id` (created in the `0001` baseline). Reachable via `task_id → tasks.owner_id` **only for task-backed blocks**; **container/synced-meeting blocks have `task_id` NULL → reachable by no owner path at all** (`backup.ts:62-65` exports the whole table unfiltered for exactly this reason). |
| `tags`, `tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags` | the whole tag axis is tenant-global today. (`tag_prefs` from S2 **is** owner-scoped, but its `tag_id` FK points at the tenant-global `tags`.) |
| `scheduled_jobs` (+ `job_runs`) | global cron registry — needs per-owner rows or an account-level runner |
| `sync_events.owner_id` | a **value, not a FK** (`schema.ts:538`, no `.references()`) — unenforced |
| `possible_tasks.proposed_owner_id` | a **real FK** but uniquely named — reconcile the naming |

**Also lacking `owner_id` but scoped through a parent FK (like `entity_tags`) — T must scope them via the parent, not add a column:** `task_dependencies` (→`tasks`), `pattern_tasks` (→`patterns`), `possible_task_tags` (→`possible_tasks`). `backup.ts` already deletes/exports all three by parent-id membership.

**Hard gates T must honor in the *same* PR that adds `owner_id`:**
1. **`backup.ts` cross-tenant wipe** — convert the owner-less `DELETE FROM …` (lines 181/186/194-198) to `… WHERE owner_id=?` and owner-scope the export selects (lines 65/102-105), or restoring one owner deletes another's calendar/tags (see [§2 R](#r--backups--restore--export)).
2. Backfill every existing row to the single current owner (**trivial now, impossible once a 2nd owner exists** — the strongest reason to do T before any real second user).
3. `PRAGMA foreign_key_check`/`integrity_check` clean; a zero-NULL-`owner_id` test per newly-scoped table; `pnpm snapshot` first (no `down()`).
4. `owners` gains auth-identity columns (`external_subject`, plus U's `username`/`password_hash`) — **one coordinated migration with U**.

**⚠️ `schema.ts` completeness caveat (verified):** it is *intentionally incomplete* — `daily_recap` is migration-only, and the only drift guard is `schema-parity.test.ts` (guards `tag_prefs` only). Don't assume `schema.ts` enumerates every owned table when planning T's scoping; enumerate from the migrations.

---

## 9 · Which A–S docs are archived

**Archived** to `docs/archive/` (2026-07-02; indexed in [archive/README.md](archive/README.md); loose ends captured above). Lettered phase specs: `B0`, `C`, `D`, `F`, `H`, `I`, `J`, `L`, `M`, `N`, `O`, `P`, `R`. Phase A: `auto-scheduling-plan.md`, `auto-scheduling-prompt.md`. Phase-G UX: `design-today-cockpit.md`. Completed non-lettered plans: `ingestion-plan.md`, `time-block-categories-plan.md`, the historical build prompts `cockpit-auto-simplification-prompt.md` / `corrections-prompt.md`, and the resolved `HANDOFF-objectives-followups.md`. Already archived earlier: `E`, `G`, `K`, `phase-0-reconciliation-plan.md`, the `con-*` set.

**Kept live in `docs/` because they carry open / unbuilt work (archived ≠ done):**
- **`F2-calendar-improvements.md`** — the whole phase is unbuilt (all tickets not-started).
- **`tasks-planner-ui-overhaul.md`** — Wave 0/1 shipped, but **Wave 2 is open**: `T-DOCS-1` (README/GLOSSARY/screenshots) and `T-QA-1` (e2e coverage + **enable client tests in CI**).
- **`plan-import.md`** — design doc; its dedup/merge tickets (e.g. `PI-4` `possible:updated` SSE + merge/flag UI) are net-new / unbuilt.
- **`ftue-plan.md`** — no clear status line; review before treating FTUE as complete.

**Also kept live** (canon / active references): **`Q-schema-hygiene.md`** and **`S-schema-consolidation.md`** — [HANDOFF-multitenant.md](HANDOFF-multitenant.md) points the multi-tenant phase directly at Q's "Multi-tenant bridge" section and S's implemented record; plus `ROADMAP.md`, `GLOSSARY.md`, `HANDOFF-multitenant.md`, this recap, and `CLAUDE_COWORK.md` / `color-styling-rules.md` / `google-cloud-setup.md`. (`ROADMAP.md` + `Q` inbound links were repointed to `archive/`.)

---

## 10 · How this feeds T–Y

| Phase | Inherits from A–S | Key recap section |
|---|---|---|
| **T** multi-tenant | Q's owner-less-table list; R's `backup.ts` wipe; L Gap 5; the junction tables; `proposed_owner_id`; `sync_events` FK; the `schema.ts`-incompleteness caveat | [§8](#8--multi-tenant-readiness-ledger-feeds-t) |
| **U** OIDC + local auth | I's unbuilt PR2 (JWKS/SSO), `external_subject`, `AUTH_*` env | [§5](#5--auth-readiness-ledger-feeds-u) |
| **V** password reset | depends on U; **no email infra exists** in the repo (net-new) | §5 |
| **W** GraphQL | service-layer discipline; post-S/post-T shapes; both prefs contracts persist over `tag_prefs` | [§7](#7--graphql--mcp-notes-feed-w--x) |
| **X** MCP vocabulary | ~36 tools; external CI-Server spec owed | §7 |
| **Y** env config | ~26 undocumented `config.ts` vars + the out-of-config readers | [§6](#6--env--config-ledger-feeds-y) |

> **Reconciliation the T–Y set still needs:** `T`, `U`, `V`, `W`, `X`, `Y`, `RELEASE-READINESS.md`, `RELEASE-READINESS-REVIEW.md` and the `companion_db_*` files are **untracked drafts** (they live only in the local `main` working tree, never committed — not on `origin/main`). They were written against the stale `0091` snapshot ("Q hasn't landed") — Q **and all of S** have since merged (head `0097`). Before they become real: (1) update their "live head" / "Q hasn't landed" premises; (2) correct `RELEASE-READINESS-REVIEW`'s claim that `schema.ts` was fully reconciled + a `check-schema-drift.ts` guard added — neither landed (the committed guard is the narrow `schema-parity.test.ts`); (3) fix their links to any A–S doc that moved to `archive/` (they reference `I-identity-auth.md` ×11, `S` ×4, `Q` ×3, etc.).
