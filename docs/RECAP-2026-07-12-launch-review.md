# Launch review & gap recap — 2026-07-12

A whole-system pass done by launching the app locally (server + client), exercising the
API, and running four parallel code audits (docs-vs-code, backend, schema, client) plus a
live-app runtime pass. **Code is source of truth.** This is the punch-list of stubs, unused
features, gaps, and misused schema — ranked so the highest-value fixes are obvious.

## Health at a glance (as launched)

| Check | Result |
|---|---|
| Server boot (`pnpm --filter server start`) | ✅ clean; 126 migrations apply 0001→0126; VAPID keypair auto-generated; 17 crons registered |
| Client (`vite`) + API proxy | ✅ renders Today cockpit; every `/api/*` on load returns 200 |
| Server typecheck (`tsc --noEmit`) | ✅ 0 errors |
| Server test suite (`TZ=UTC pnpm test`) | ✅ **1918 passed, 3 skipped, 0 failed** (176 files, ~255s) |
| NL quick-add smoke (`pay invoice fri 3pm #finance ~20m`) | ✅ parsed title/date/time/tag/estimate correctly |
| Migration head | `0126_default_categories` (gaps 0009 & 0119 intentional + documented) |

The codebase is **unusually clean**: zero `TODO`/`FIXME`/`HACK`/`XXX` markers in non-test
server *or* client code, all 13 agents invoked, all 34 routers mounted, all 17 crons backed
by real handlers, no orphaned exports of note. The findings below are refinements, not rot.

---

## P1 — real defects (user-visible)

1. **Jobs view is near-invisible in light theme.** `client/src/views/Jobs.tsx` hardcodes
   `text-slate-100/200/400`, `bg-surface-700` instead of theme tokens (`text-foreground`,
   `text-muted-foreground`). The app fully supports light theme (`theme.ts`: `:root`=light).
   A light-theme user sees the heading + job names as near-white on white. *(Fixed in this
   review — see "Fixes applied".)*

2. **`scheduled_jobs.next_run_at` is never written — perpetually null through the API.**
   Column read by `services/jobs.ts:23` and surfaced as GraphQL `Job.nextRunAt`
   (`graphql/job-resolvers.ts:63`), but scheduling is in-memory `croner` and `runJob` only
   writes `last_run_at` (`jobs/index.ts`). Any "next run at…" UI is permanently blank.
   Fix: compute the next fire time from the cron expression on write, or drop the column.

3. **Redundant fetch storm on Today load.** Observed live: `/api/jobs` fired ~8×,
   `/api/stars` ~6×, `/api/auth/config` 3×, `/api/reflections` / `/api/day-types/resolve`
   / `/api/flight-plan` 2× each — on a single render. Consolidate per-view fetches / add a
   request cache. Correctness is fine; it's wasted round-trips and re-renders.

4. **SolidJS disposal leak warnings.** The console logs
   `computations created outside a createRoot or render will never be disposed` repeatedly.
   This is the known module-scope eager-`createMemo` ordering trap (declare resources before
   memos that read them). Harmless today but it's an accumulating-listener smell.

## P2 — misused schema (the "capture misused schema" ask)

5. **`time_blocks.tag` string-joins to `pattern_types.name` — a real FK is ignored.**
   Container/plan association resolves by matching free text (`autoplan.ts:164-165,672-673`:
   `WHERE pt.name = tb.tag`). Renaming a pattern type silently orphans every block; the join
   is case/whitespace-fragile and sits in the hot scheduling path.

6. **Block↔tag membership is modeled four ways at once.** `time_blocks` carries `tag` (TEXT),
   `category_id` (FK→tags), `color_token` (a *frozen copy* of the category color) **and**
   `entity_tags` rows. Four stores kept in sync per write; `color_token` is stale-by-design,
   so a category recolor silently desyncs existing blocks (`schema.ts:128-150`).

7. **FKs declared without `ON DELETE CASCADE`; owner teardown is hand-rolled.** `purgeOwnerData`
   is a 48-line manually-ordered delete list (`lib/owners.ts:202-249`). Add a new owner-scoped
   table and forget a line → permanent orphans on delete/restore — the exact class the
   multi-tenant audits keep re-finding. `owners.ts:244-246` only sweeps some junction FKs
   (`category_direction_optouts` by `category_tag_id`; `tag_categories`/`tag_directions` by
   `intention_tag_id`), leaving the other FK column unswept.

8. **`objective_tasks` uses `linked=0` tombstones, not deletion.** Every read must remember
   `AND ot.linked = 1` (~9× in `services/objectives.ts`). A read path that forgets it counts
   tombstoned links → phantom objectives / potential cross-owner leak. Author flags it as a
   footgun in-code (`objectives.ts:189,210`).

9. **`entity_tags.entity_id` is polymorphic with NO foreign key.** Spans tasks/blocks/patterns
   (`schema.ts:472-487`); integrity is app-enforced only. Any insert path bypassing
   `services/tags.ts` (import, sync, future features) creates undetectable orphan tag rows.

10. **`external_events` UNIQUE omits `owner_id`** (`UNIQUE(provider, account, external_id)`,
    mig 0051). If two owners ever share a provider account/calendar, the second's mirror
    insert collides with the first's row → cross-tenant sync record. Isolation rests entirely
    on accounts never being shared.

11. **`possibleTaskTags` composite PK exists in the DB but not the Drizzle model**
    (`schema.ts:489-492` declares neither PK nor unique; DB has `PRIMARY KEY(possible_task_id,
    tag_id)`). `INSERT OR IGNORE` in `agents/ingest.ts:150` relies on a constraint the ORM
    can't see — ORM-driven codegen would permit duplicates the app assumes impossible.

12. **`daily_recap` co-locates two unrelated concerns as all-nullable columns** (mig 0096 merged
    `daily_summaries`+`day_stars`). One wide sparse row; correctness depends on every writer
    using the correct partial-upsert `WHERE`. Works, but fragile.

13. **Naming cruft from reverted renames.** `pattern_blocks` stores *directions*, not patterns
    (0038/0043 → reverted by 0105, FK back to `direction_tag_id`, table name kept). `tasks`
    has both `description` ("legacy") and `notes` ("rich"). `oauth_states.nonce` is nullable
    while sibling `auth_states.nonce` is NOT NULL.

## P3 — unused / dormant features (stored + sometimes API-surfaced, never actuated)

14. **Dead scheduling knobs — persisted, shown in GraphQL prefs, ignored by every engine:**
    `deep_work_windows`, `plan_allday_always`, `plan_daylong_for_promoted`, `plan_autofill_gaps`,
    `concept_autosurface`, `concept_horizon_days` (migs 0001/0018/0021). Leftovers from the
    abandoned Phase-G "Plan/Concept block" line (same cluster: `block_type='concept'`,
    `goal_start_date`, `duration_minutes`). Users can toggle Settings that do nothing.

15. **`estimate_calibration` computes bias but never applies it.** Nightly job writes
    `bias_ratio`/`p25`/`p50`/`p75`; the code comment says it touches "never
    tasks.estimated_minutes, never tag defaults." Consumers are display-only (briefing prose +
    a GET endpoint). An entire learning-loop table + cron produce numbers that change no
    schedule.

16. **Phase-Z Time-Sense schema is dark (flag `time_sense_enabled` default off).** `copy_history`,
    `calibration_combo_pins`, and the four per-cue boolean prefs (`focus_ritual_enabled`,
    `haptic_cues_enabled`, `ambient_color_enabled`, `calibration_loop_enabled`) have no
    server-side behavioral consumer. Intentional (unshipped feature) but easy to mistake for live.

17. **~12 tables have no Drizzle model** (raw-SQL only): `daily_recap`, `daily_plan`, `objectives`,
    `objective_tasks`, `reflections`, `estimate_calibration`, `calibration_combo_pins`,
    `replan_suggestions`, `plan_hints`, `pattern_day_optouts`, `copy_history`, `app_config`. The
    schema-parity guarantee `schema.ts` implies is silently incomplete for a third of the DB.

18. **`pattern_types.reminder_config` is a round-tripped JSON blob with no reader** (documented
    "opaque until Phase H"; H shipped). `services/patterns.ts` only parses+re-serializes it.
    `texture` is display-only pass-through. Candidate dead columns.

19. **GraphQL surface is intentionally partial vs REST.** `block-template` (`instantiate`,
    `apply-to-block`) and `pattern` (`fast-tasks`, `promote-from-*`, `place-today`) mutations
    are "REST-only for now" (in-SDL comments). Fine unless GraphQL is marketed as REST-parity.

## P4 — dead code (safe to delete)

20. **Dead client components:** `EightPointStar.tsx`, `TaskStatusIcon.tsx` — never imported/rendered.

21. **~13 unused `api.ts` client methods** (no caller): `tasks.reschedule`, `tasks.recall`,
    `patterns.get`, `patterns.promoteFromPlan`, `flightPlan.addPattern`, `plan.instruct`
    (PlanInstruct was deleted in AC), `patternTypes.create/update/delete`,
    `reminders.create/remove` (manual reminder creation is unreachable from the UI),
    `memory.suggest`, `llm.status`, `dayTypes.assignments`, `reflections.delete`,
    `objectives.recompute`.

22. **One un-annotated dead config field** (now fixed): `config.auth.kekB64` was parsed from
    `CP_KEK_B64` but never read — the KEK consumer reads `process.env` directly. The sibling
    `AUTH_JWKS_URL`/`AUTH_ISSUER`/`AUTH_AUDIENCE`/`AUTH_CONTRACT_VERSION` fields are all
    correctly annotated dead already.

## P5 — robustness / consistency

23. **Unknown job kind logs as SUCCESS.** `jobs/index.ts:321-323` default branch returns
    `itemsCreated:0` with no throw, so `runJob` records `status='done'`. A stale/typo'd
    `scheduled_jobs.kind` runs every tick as a green zero-work no-op that never surfaces as an
    error. Make the default branch throw / set `status='error'`.

24. **Native `prompt()` for routine naming.** `TaskCard.tsx:320` uses the blocking browser
    `prompt('New routine name')` — no styled modal/validation, inconsistent with the app's own
    input UI. `Settings.tsx:417,431` also hand-roll two Google-OAuth `fetch`es that bypass the
    typed `api.ts` client (the only two UI calls that do).

25. **Server-memory-only replan state.** `ReplanBanner` hydrates from `plan.suggestion`, but an
    outstanding replan nudge lives in server memory (`ReplanBanner.tsx:11-12`) — a server
    restart silently drops it.

## Not-bugs (verified clean — stated so they aren't re-flagged)

- `/api/auth/reset-request` always-200 and `possible_tasks` reset messages are intentional
  anti-enumeration / honesty, not faked capabilities.
- Every `catch` in server + client is a deliberate degrade-to-default **with logging** — no
  silent swallows, no 200-on-failure.
- All `disabled={…}` client controls have a real enable path; no no-op `onClick`s, no leftover
  `alert()`/`console.log` debug, no commented-out JSX.
- The dead `AUTH_*` env vars are honestly annotated in README, ARCHITECTURE, and `config.ts`.

---

## Documentation drift fixed in this review

Docs had fallen behind the code (code = truth). Corrected:

- **Migration head** `0117`/`0123`/`0124` → **`0126`** across ROADMAP, ARCHITECTURE, README.
- **Phantom routes** removed: ARCHITECTURE §8 and README listed `/inbox`, `/routines`,
  `/objectives` as live views — they are **redirects/tabs** (Inbox retired in AF; Objectives &
  Routines are tabs inside `/tasks`). Corrected to the real **six routed views**.
- **View count**: README's "Seven views" / "nine SolidJS views" → six.
- **Missing phases**: ROADMAP + ARCHITECTURE now record **AF** (task mgmt + Inbox retirement),
  **AF-11** (tag unification), **AG** (multi-tenant RBAC), and the ship-readiness/hardening work.
- **`category` tag kind** (base Personal/Professional/Social, mig 0126) added to README schema
  table + GLOSSARY taxonomy (was documented as only direction/intention).
- **Missing endpoints** added to README HTTP API table: `/api/accounts` (+invite),
  `/api/owner/profile`, `/api/google-config`, `/api/day-types`, `/api/category-prefs`,
  `/api/health`.
- **"18 scheduled jobs"** → 17 (the retired `promote_possibles` cron is manual-only) in both
  mermaid diagrams.
- **Stale label** README "pattern (direction)" → "direction" (reverted by mig 0105).
- **HANDOFF-2026-07-12** banner: RBAC is no longer "not started" — AG shipped (0125).

## Remaining doc gaps (not yet fixed — lower value)

- README §"Frontend" prose and ARCHITECTURE §9 could mention `owners.role`/RBAC scopes explicitly.
- ARCHITECTURE §9 still describes `config.auth.kekB64` context loosely (the field is now
  annotated dead in `config.ts`).

## Fixes applied during this review

- **Jobs.tsx light-theme** contrast bug (P1 #1) — swapped hardcoded slate/surface classes for
  theme tokens.
- **`config.auth.kekB64`** annotated DEPRECATED/unused (P4 #22) to match its dead siblings.
- **`client/vite.config.ts`** proxy target + port made env-overridable
  (`VITE_API_TARGET`/`VITE_PORT`) so a second stack can run alongside another worktree's — used
  to launch this review's isolated instance.
- The documentation-drift corrections listed above.
