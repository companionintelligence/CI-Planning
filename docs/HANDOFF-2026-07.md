# Companion Planning — Engineering Handoff

**Date:** 2026-07-04
**Migration head:** `0110_entity_tags_created_at` (~109 migration files; runner applies 0001 → 0110 on boot)

---

## 1. Where we are

Phases **A through Y are all merged to main** — scheduler correctness, the owner-scoped model + migration runner, rich task/habit semantics, time tracking, recurrence, calendar grid, time-blocks/patterns cockpit, notifications + Web Push, backups/export/import, identity/auth + connectors (Google OAuth 2.1 + MCP, live Calendar/Gmail), two-way calendar sync, multi-device sync + offline writes, the AI scheduler, life-planning, the gamified five-star day, planner hygiene, schema hygiene + consolidation, multi-tenant owner-scoping, CI-Portal OIDC + local auth, password reset, MCP intent vocabulary, and env-config. On top of that baseline: the **Z Time-Sense** phase (Focus Ritual + calibration loop) has landed behind the `time_sense_enabled` master flag, and the **UI/calendar owner-feedback waves** have landed. The separately-named **naming-consolidation "Z"** is partial — W2 (tag-axis revert pattern→direction) shipped, while W1 (patterns→routines table rename) and W4 (drop vestigial `auto_mode`) remain planned. The one phase in **active progress is Phase W (GraphQL CRUD)**.

> Two different phases were both called "Z": **Z Time-Sense** (focus ritual + calibration) and the **naming-consolidation Z** (tag-axis/table renames). They are unrelated; the shared letter is a naming accident.

---

## 2. Phase W (GraphQL CRUD) — the active work

**What it is.** A GraphQL surface **alongside** the REST API — REST stays authoritative and untouched. Mounted at **`POST /api/graphql`** using **Apollo Server 5** + `@as-integrations/koa` on Koa 3. Schema-first, hand-authored SDL; introspection on; a **custom complexity-limiter plugin** (not `graphql-query-complexity`); `graphql` pinned to 16.x. The endpoint runs under `requireAuth`, and the resolver context reads `currentOwnerId()` from the **same AsyncLocalStorage the REST routes use**.

**Decision 3 (the load-bearing rule):** every resolver calls the existing `services/*.ts` functions and **never re-derives owner-scoping**. To make that possible, a shared service layer was extracted so REST + GraphQL share one owner-scoped implementation: `services/tasks.ts` and `services/blocks.ts` (new; alongside the pre-existing `services/tags.ts` etc.). Files live in `server/src/graphql/` (`schema.graphql` base + `tag.graphql`/`task.graphql`/`block.graphql` SDL + `tag-resolvers.ts`/`task-resolvers.ts`/`block-resolvers.ts` + `pagination.ts` + `scalars.ts` + `complexity.ts` + `index.ts`).

**Shipped (merged):**
- step-1 bootstrap #235 · TagType #238 · Z-W2 TagKind flip #239
- `services/tasks.ts` extract + owner-scope hardening #243 / #244 / #245 / #249
- `services/blocks.ts` extract #254 · TaskType #255 · TimeBlockType #259
- Taggable forward tags (Task/TimeBlock implement `Taggable`, `EntityTagType.tags`) + `entity_tags.created_at` (mig 0110, table rebuilt to `NOT NULL DEFAULT CURRENT_TIMESTAMP`) #262

**Types live now:** `TagType` (+ direction/intention/category hierarchy connections), `TaskType`, `TimeBlockType`, `EntityTagType` (forward `Taggable.tags` on Task + TimeBlock). Node/Connection/Edge/PageInfo/DateTime/JSON conventions match CI-Server.

**Remaining ticket sequence (one line each):**
- **W4b** — `TagType.entities` reverse edge, cross-table Node union
- **W5** — `FlightPlanEntryType`
- **W6** — routine/pattern family (`Pattern`/`PatternKind`/`PatternBlock`/`PatternPref` types) — ⚠ coordinate with Z-W1 naming
- **W7** — `DayType` + `TagPref`
- **W8** — life-planning (`Objective`/`Reflection`/`DayStars`/`DailyRecap`; unblocks `TaskType.objective`)
- **W9** — inbox (`PossibleTask`/`BlockTemplate`)
- **W10** — notifications (`Reminder`/`PushSubscription`)
- **W11** — `SchedulingPrefs`
- **W12** — admin (`ScheduledJob`/`JobRun`, behind a new admin scope)
- **W13** — mutation-only engine ops (autoplan/find-slot/instruct)
- **W-sandbox** — in-browser GraphiQL IDE (LOCKED to self-hosted `github.com/graphql/graphiql`, vendored, NO CDN; `GET /api/graphql/sandbox`, flag-gated `GRAPHQL_SANDBOX`, prod-off) — **independent / parallelizable, can go anytime**
- **W-close** — DoD sweep + perf indexes + docs sync + adversarial review — **gates on the type tickets above**

**Authoritative references** (siblings of this file, under `docs/`): [`W-graphql-crud.md`](W-graphql-crud.md) (Addendum 2) is the live ticket board; [`W-graphql-schema.md`](W-graphql-schema.md) is the SDL / type map.

---

## 3. Working agreements that made this go well

The per-ticket discipline used throughout Phase W:

- **Branch off fresh main** for each ticket.
- **Extract the service before wiring the resolver** — never re-derive owner-scoping in a resolver (Decision 3). Three IDOR/oracle bugs were caught precisely because scoping stayed in one place.
- **Self-review the diff before opening the PR.**
- Run the **full server suite + `tsc` independently.**
- **Address Copilot review inline and resolve the threads.**

Recurring review lenses worth keeping in mind:
- Owner-scoping must hold on **reads AND writes.**
- **DateTime input coercion** — the scalar normalizes to an ISO string.
- **uuid7 is NOT monotonic within a millisecond** — do not assert creation order in tests.
- Watch for **autofix commits mangling the SDL.**

---

## 4. Cross-phase coordination / watch-outs

- **Z-naming W1 (patterns→routines) vs W6 naming.** W6 introduces the `Pattern`/`PatternKind`/`PatternBlock`/`PatternPref` types; the naming-consolidation W1 renames the `patterns` table to routines. Whichever lands first dictates the GraphQL type names — coordinate before building W6.
- **Migration-slot contention.** New migrations must claim the next free slot after 0110; parallel branches can collide on a number — renumber at merge.
- **`created_at` timezone caveat.** SQLite `CURRENT_TIMESTAMP` columns (e.g. `entity_tags.created_at`) serialize through the DateTime scalar with a possible local-tz shift. This is a **phase-wide follow-up**, not a per-ticket fix.
- **Deferred / not blocking:** G-INT timing intelligence · the three L P3 sync gaps · S optional D1/D2/D3 · Google live mode needs real creds · H Web Push needs VAPID keys · Z-naming W1/W4.

---

## 5. Next actions

- **Pick up W4b next** — it is the next item in the type sequence (`TagType.entities` reverse edge + cross-table Node union).
- **W-sandbox can go anytime** — it is independent of the type tickets and parallelizable.
- Continue the type sequence W4b → W5 → W6 (after Z-W1 coordination) → W7 → W8 → W9 → W10 → W11 → W12 → W13.
- **W-close last** — it gates on the type tickets being done (DoD sweep, perf indexes, docs sync, adversarial review).
