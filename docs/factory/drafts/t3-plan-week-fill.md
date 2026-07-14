> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-fill`
> **Commit style:** `feat(plan-week): deterministic fill-next-week branch`
> **Design:** this ticket is the spec (see also `docs/ftue-plan.md` §5–§6 — the "fewest clicks" / trust-dial framing this branch operationalizes)
> **Dependencies:** T2 (the `PlanWeekAssistant` shell this branch plugs into) — hard; T1 (the active-session transcript + its append seam) — hard

## Goal

Ship the **"Fill next week"** branch of the weekly Planning Assistant: a **fully deterministic** (no LLM) flow that walks the user through **choose horizon → choose sources → preview candidates → confirm**, where confirm runs the EXISTING `POST /api/auto/fill` then `POST /api/auto/run { horizon_days }`. Every step appends one entry to the active session transcript (T1). No new placement engine — the branch is a thin driver over `/api/auto/*` plus one read-only preview endpoint.

## Non-goals (fence off adjacent work)

- Do **not** add any LLM call to this branch: no `renderCopy`, no `parseInstruction`, no `authorPlanOrder` invoked from branch code, no `aiAvailable()` gating. This branch is always available. (LLM ordering is **T9**; assistant follow-ups are **T7** — build neither here.)
- Do **not** write a new placement/scheduling engine or a new fill algorithm. Reuse `fillFlightPlanCandidates` (via `POST /api/auto/fill`) and `autoRun` (via `POST /api/auto/run`) exactly as they are.
- Do **not** add per-source *placement* filtering. The Flight-plan / Objectives / Recurring source toggles are **preview-scoping only** (they change the displayed candidate summary). The single source toggle with a confirm-side effect is **Open tasks**, which gates whether `POST /api/auto/fill` is called. Excluding objectives/recurring work from placement would require engine changes — out of scope.
- Do **not** change `fillFlightPlanCandidates`, `autoRun`, `placeFlightPlan`, or any `/api/auto/*` handler. If you find yourself editing `server/src/engine/autoplan.ts` or `server/src/services/engine-ops.ts`, stop — that is out of scope.
- Do **not** add any schema/migration. This branch reads existing tables and reuses existing write endpoints.
- Do **not** define the session-transcript store or endpoint — **T1 owns it**. This ticket only *appends* to it; do not create a second transcript store/signal.
- Do **not** touch the legacy `FlightPlan.tsx` cockpit component or its buttons.

## Pinned conventions

Verified against the repo at migration head `0126`. Restate/obey these exactly:

- **Reused backend contracts (do not modify):**
  - `POST /api/auto/fill` → `server/src/routes/flight-plan.ts` → `fillFlightPlanCandidates(owner)`. Stages open, non-`habit`, top-level (`parent_id IS NULL`), non-recurrence-child (`recurrence_parent_id IS NULL`) tasks not already staged, **all `selected = 1`**, capped at `CANDIDATE_LIMIT = 20` (`server/src/engine/autoplan.ts:35`). **The handler ignores any request body** — fill always uses the owner's "today", not a passed date. Response: `{ result: { step: 'fill', candidatesAdded }, flight_plan }`.
  - `POST /api/auto/run { date?, horizon_days? }` → `flight-plan.ts` → `autoRun` (`server/src/services/engine-ops.ts:125`). `horizon_days` is clamped **1..60** (`clampDays`, engine-ops.ts:93); a multi-day run fans staged leftovers onto successive days and returns `{ result: { step:'place', blocksCreated, placed, unplaced, days }, flight_plan }` (`days` present only when `> 1`).
- **Auth:** the single global guard `requireAuth()` (`server/src/lib/auth/requireAuth.ts`) is mounted in `app.ts` before the routers; a **GET is auto-gated as `planning:read`**, no per-route wiring. New endpoints must NOT be added to `PUBLIC_PREFIXES`.
- **Route shape:** thin `Router()` shells (pattern: `server/src/routes/objectives.ts`, `flight-plan.ts`) — read `ctx.query`/`ctx.request.body`, return via `ctx.body`, owner via `currentOwnerId()` (`server/src/lib/context.ts`, **throws if unscoped**). Register the router by importing it and appending it to the `mountRoutes` array in `server/src/routes/index.ts`.
- **Owner scoping:** every read filters by `owner_id = currentOwnerId()`. The preview endpoint is **read-only** — it must run zero `INSERT`/`UPDATE`/`DELETE`.
- **Client API:** methods live in `client/src/lib/api.ts` under the `api` object; call via `request<T>(method, path, body?)` where the base is already `'/api'` (api.ts:1). `api.auto.fill` / `api.auto.run` already exist (api.ts:233–244) — reuse them, don't duplicate.
- **Client stores / Solid idiom:** module-scope signals/resources in `client/src/stores/index.ts`; a resource must be declared BEFORE any memo that reads it (eager-eval TDZ). `selectedDay()` (`stores/index.ts:34`, `createSignal(localISODate())`) is the owner-local `YYYY-MM-DD` anchor — use it as the horizon start.
- **Preview candidate sets (read-only queries, owner-scoped):**
  - *Open tasks* — mirror the `fillFlightPlanCandidates` SELECT (open, `subtype IS NOT 'habit'`, `parent_id IS NULL`, `recurrence_parent_id IS NULL`, not in `flight_plan`, `scheduled_for IS NULL` OR scheduled for today with no active task block). Cap the returned list at 20 to match fill's `CANDIDATE_LIMIT`; also report the untruncated eligible `count`.
  - *Flight-plan* — `SELECT COUNT(*) FROM flight_plan WHERE owner_id = ? AND selected = 1` (these are placed by `/api/auto/run`).
  - *Objectives* — open, unstaged tasks with an active objective link: joined via `objective_tasks` (`objective_id, task_id, linked`; active = `linked = 1`, per `server/src/services/objectives.ts`). Informational subset of Open tasks.
  - *Recurring* — owner's `tasks` where `recurrence_rule IS NOT NULL OR subtype = 'habit'`. Informational (these auto-place via the recurrence/pattern engine, not via fill).
- **Determinism note:** `autoRun` internally calls `authorPlanOrder`, which *may* use the LLM for day 0 only when the owner is already in a smart/hands-off plan mode; it **falls back to deterministic ordering when Ollama is down**. This branch neither forces smart mode nor sets the trust dial — so the branch itself issues no LLM call. That pre-existing engine behavior is out of scope (T9 owns LLM ordering).

## Before implementation

Read these first and match reality (paths are worktree-relative):

- `client/src/components/PlanWeekAssistant.tsx` — **the T2 shell** this branch plugs into. Confirm (a) how a branch is registered/selected (branch key + label + the slot/registry the shell renders into), and (b) that the shell guarantees an active T1 session before a branch renders. Match its exact registration mechanism and component-placement convention (flat `client/src/components/` vs a `plan-week/` subfolder). **If T2 is not yet merged into this branch, rebase onto it before starting — do not stub the shell.**
- T1's merged code — locate the **active-session transcript append seam** (store helper in `client/src/stores/index.ts` and/or a method on the `PlanWeekAssistant` session module, and/or `api.*`). Match its exact export name and entry payload shape; **do not invent a second transcript store**.
- `server/src/routes/flight-plan.ts` — `POST /api/auto/fill` and `POST /api/auto/run` handlers (the two endpoints confirm reuses).
- `server/src/engine/autoplan.ts` — `fillFlightPlanCandidates` (lines ~592–626, the candidate SELECT + `CANDIDATE_LIMIT`) so the preview query mirrors it.
- `server/src/services/engine-ops.ts` — `autoRun` (`horizon_days` clamp + multi-day loop) so the confirm call and its response shape are used correctly.
- `client/src/components/FlightPlan.tsx` — `runFill` / `runSchedule` (lines ~137–172) for the existing `api.auto.fill` / `api.auto.run` call + toast + refetch idiom to imitate.
- `server/src/routes/objectives.ts` + `server/src/routes/index.ts` — route-shell + `mountRoutes` registration pattern.
- `server/test/sched-horizon.test.ts` + `server/test/helpers.ts` — the `startTestServer` / `api()` integration-test idiom the backend test must follow.

## Files impacted

**New:**
- `server/src/routes/plan-week.ts` — thin router exposing the single read-only preview endpoint `GET /api/plan-week/candidates`.
- `client/src/components/PlanWeekFill.tsx` — the "Fill next week" branch component (horizon → sources → preview → confirm). *(Place it wherever T2's shell keeps its branch components — adjacent to `PlanWeekAssistant.tsx` unless T2 established a `plan-week/` subfolder; match T2.)*
- `server/test/plan-week-fill.test.ts` — backend integration test (preview endpoint + the confirm reuse path).
- `client/src/components/PlanWeekFill.test.tsx` — client test for the branch's step flow + transcript appends *(place beside the component per the client test convention T2 uses; if T2 has no client test yet, follow existing `client/src/**/*.test.tsx`)*.

**Changed:**
- `server/src/routes/index.ts` — import `planWeekRouter` and append it to the `mountRoutes` array.
- `client/src/lib/api.ts` — add `api.planWeek.candidates(...)` calling `GET /plan-week/candidates?...` (and a `PlanWeekCandidates` response interface).
- `client/src/components/PlanWeekAssistant.tsx` — register the "Fill next week" branch (key `fill-next-week`, label "Fill next week", subtitle "Deterministic — no AI") in the shell's branch registry/switch, per T2's mechanism.

## Schema required

**None.** No new tables, columns, indexes, or migration. The preview endpoint reads existing tables (`tasks`, `flight_plan`, `objective_tasks`); confirm reuses existing write endpoints; the transcript table (if any) is owned by T1.

## Definition of Done

- [ ] `GET /api/plan-week/candidates?horizon=<N>&start=<YYYY-MM-DD>` exists, is auth-gated as `planning:read` (global guard; not in `PUBLIC_PREFIXES`), owner-scoped, and **performs zero writes**.
- [ ] The endpoint echoes the clamped `horizon` (1..60, matching `autoRun`) and `start`, and returns per-source breakdowns: `open_tasks` (`count` + `will_stage = min(count, 20)` + an items list capped at 20), `flight_plan` (`count`), `objectives` (`count`), `recurring` (`count`), each computed by the exact queries in Pinned conventions.
- [ ] `planWeekRouter` is registered in `server/src/routes/index.ts`.
- [ ] `api.planWeek.candidates({ horizon, start })` is added to `client/src/lib/api.ts` with a typed response interface; no duplicate of `api.auto.*`.
- [ ] `PlanWeekFill.tsx` renders the four ordered steps: **(1) Horizon** — numeric input defaulting to **7 days**, range 1..14 in the UI (server clamps 1..60), anchored at `selectedDay()`; **(2) Sources** — four checkboxes (Open tasks, Flight-plan, Objectives, Recurring) all default ON; **(3) Preview** — hydrated from `api.planWeek.candidates`, showing per-source counts and the open-task list; **(4) Confirm**.
- [ ] Confirm runs, in order: `await api.auto.fill({})` **iff** the Open-tasks source is enabled, then `await api.auto.run({ date: selectedDay(), horizon_days: <N> })`; then refetches flight-plan + blocks (same idiom as `FlightPlan.runSchedule`) and surfaces a result toast (`placed` / `unplaced` / `days`).
- [ ] Exactly one transcript entry is appended per step transition via T1's seam — kinds `plan_week:horizon`, `plan_week:sources`, `plan_week:preview`, `plan_week:confirm` (the confirm entry carries the run result: `placed`, `unplaced`, `days`).
- [ ] The branch is registered in `PlanWeekAssistant.tsx` and reachable from the shell's branch picker.
- [ ] No LLM call anywhere in the branch or the new endpoint; no `aiAvailable()` gate on this branch.
- [ ] `server/src/engine/autoplan.ts` and `server/src/services/engine-ops.ts` are **unchanged**.

## Tests

Backend (`server/test/plan-week-fill.test.ts`, `startTestServer` + `api()` idiom, `TZ=UTC` via helpers):

- [ ] `GET /api/plan-week/candidates` returns 200 and, for a set of seeded open tasks, `open_tasks.count` equals the number of fill-eligible tasks and `will_stage` is capped at 20 when more than 20 are eligible.
- [ ] Habits (`subtype='habit'`), child tasks (`parent_id` set), recurrence instances (`recurrence_parent_id` set), and already-staged tasks are **excluded** from `open_tasks` (mirrors `fillFlightPlanCandidates`).
- [ ] `flight_plan.count` reflects only `selected = 1` staged rows; `objectives.count` counts only open unstaged tasks with an active `objective_tasks` link (`linked = 1`); `recurring.count` counts `recurrence_rule IS NOT NULL OR subtype='habit'`.
- [ ] The endpoint **writes nothing**: a `flight_plan` / `time_blocks` row count taken before and after the GET is identical.
- [ ] `horizon` is clamped to `1..60` in the echoed response (e.g. `horizon=0` → `1`, `horizon=99` → `60`).
- [ ] Confirm-equivalence: calling `POST /api/auto/fill` then `POST /api/auto/run { date, horizon_days: 3 }` (the two endpoints this branch drives) fans one task per day across 3 days and drains staging — i.e. the reused pipeline behaves as `sched-horizon.test.ts` documents (guards against a regression in the reuse contract).
- [ ] The endpoint is owner-scoped: a second owner's tasks never appear in the first owner's candidate counts (`x-test-owner` header).

Client (`client/src/components/PlanWeekFill.test.tsx`):

- [ ] Stepping horizon → sources → preview → confirm appends exactly four transcript entries in order (`plan_week:horizon`, `plan_week:sources`, `plan_week:preview`, `plan_week:confirm`) via the T1 seam (mock it).
- [ ] With Open tasks enabled, confirm calls `api.auto.fill` then `api.auto.run` (mocked); with Open tasks disabled, confirm calls **only** `api.auto.run`.
- [ ] `api.auto.run` is called with `{ date: selectedDay(), horizon_days: <chosen N> }`.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] **Given** an owner with open backlog tasks, **when** they open the assistant and pick "Fill next week", **then** they see a horizon step defaulting to 7 days, a sources step (4 toggles, all on), and a preview listing the candidate counts and open-task list — with no calendar writes yet.
- [ ] **Given** the preview, **when** the user confirms, **then** the app calls `POST /api/auto/fill` (Open tasks on) followed by `POST /api/auto/run { date, horizon_days: 7 }`, the day/week is populated by the existing engine, and a toast reports placed/unplaced (and `days` when > 1).
- [ ] **Given** Open tasks is toggled off, **when** the user confirms, **then** only `POST /api/auto/run` is called (no new open tasks staged) and already-staged items are placed across the horizon.
- [ ] **Given** each of the four steps, **when** the user advances, **then** exactly one transcript entry per step is appended to the active session (visible in the T1 transcript).
- [ ] **Given** Ollama is off, **when** the branch runs end to end, **then** it succeeds unchanged (no `aiAvailable()` gate, no LLM dependency in the branch).
- [ ] **Given** the preview endpoint, **when** it is called, **then** `flight_plan` and `time_blocks` are byte-for-byte unchanged (read-only).

## Subtasks

1. [ ] Rebase onto T2; read `PlanWeekAssistant.tsx` (branch registry) and T1's transcript-append seam; note exact export names + branch-component placement.
2. [ ] Add `server/src/routes/plan-week.ts` with `GET /api/plan-week/candidates` (read-only, owner-scoped, horizon clamp 1..60, four source breakdowns per the pinned queries).
3. [ ] Register `planWeekRouter` in `server/src/routes/index.ts`.
4. [ ] Add `api.planWeek.candidates(...)` + `PlanWeekCandidates` type to `client/src/lib/api.ts`.
5. [ ] Build `PlanWeekFill.tsx`: horizon step (default 7) → sources step (4 toggles) → preview (hydrate from the endpoint) → confirm (`api.auto.fill` iff Open tasks, then `api.auto.run { date, horizon_days }`, refetch flight-plan + blocks, result toast).
6. [ ] Append one T1 transcript entry per step (`plan_week:horizon|sources|preview|confirm`), confirm entry carrying the run result.
7. [ ] Register the branch (key `fill-next-week`) in `PlanWeekAssistant.tsx`.
8. [ ] Write `server/test/plan-week-fill.test.ts` and `client/src/components/PlanWeekFill.test.tsx`.
9. [ ] Run all five verification commands; confirm `autoplan.ts` + `engine-ops.ts` are untouched in the diff.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
