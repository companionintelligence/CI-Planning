> **Type:** Frontend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-schedule`
> **Commit style:** `feat(plan-week): deterministic schedule-tasks branch`
> **Design:** this ticket is the spec; see `docs/ftue-plan.md` §5 (the FTUE flow) and §6 ("fewest clicks" steady state) for the weekly-planning framing.
> **Dependencies:** **T2** (the Weekly Planning Assistant shell — `client/src/components/PlanWeekAssistant.tsx`, its session transcript, and the branch dispatcher that routes to "Schedule tasks"). All task / flight-plan / Auto APIs this ticket calls already exist on `main`.

> ### 🚧 LIVE — issue #340, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.

## Goal

Build the **"Schedule tasks"** branch of the Weekly Planning Assistant as a purely **deterministic** flow: list the owner's undated, unscheduled open tasks, let the user pick one, and place it either **manually** (give it a day, optionally a time) or by **letting Auto place it** (stage → run the two-step Auto). Every successful (and failed) action appends an honest line to T2's session transcript. No new endpoint, no LLM — this branch reuses the existing task/placement APIs only.

## Non-goals

<!-- Explicit fences so the model doesn't build adjacent things. -->

- Do **not** add or change any server route, service, or engine. This is client-only; every API method already exists in `client/src/lib/api.ts`.
- Do **not** add a migration or touch `server/src/db/**`. **Schema: None.**
- Do **not** call any LLM path (`parseInstruction`, `authorPlanOrder`, `renderCopy`, `api.plan.instruct`, `generate()`). This branch is deterministic; there is no `(AI)` affordance here.
- Do **not** create tasks. `api.tasks.create` (with `auto_place`) is the sibling *new-task* placement seam — it is **out of scope**; this branch only places tasks that already exist.
- Do **not** build the bulk **"Fill my week"** flow — that is the **T3** fill branch (`api.auto.fill` over the whole backlog). This branch stages/places **one user-picked task at a time**.
- Do **not** build the T2 shell, its transcript store, or the branch menu/dispatcher. Consume them; do not re-implement or fork a parallel transcript.
- Do **not** mutate the global `taskFilter` signal in `client/src/stores/index.ts` (that would perturb the AllTasks view). Fetch candidates with a **local** resource.
- Do **not** stage recurrence instances (the server returns `422` for them) and do **not** offer scheduling for habits.

## Pinned conventions

<!-- Exact, verified values this change must match. -->

- **Component location & naming.** Components are flat files in `client/src/components/*.tsx` (verified: `TaskCard.tsx`, `FlightPlan.tsx`, `DayGoals.tsx`, …). Name the new branch component `PlanWeekScheduleTasks` at `client/src/components/PlanWeekScheduleTasks.tsx`; its test is the co-located `client/src/components/PlanWeekScheduleTasks.test.tsx` (verified sibling-test idiom: `TaskCard.test.tsx`, `QuickAdd.test.tsx`).
- **Existing placement seams (verified in `client/src/lib/api.ts`).** Use these exactly, no new methods:
  - `api.tasks.list(params)` → `{ tasks: Task[] }`. `params: Record<string,string>`; falsy values are stripped. Use `{ status: 'open' }`.
  - `api.tasks.update(id, body)` → `{ task: Task }`. `body.scheduled_for` / `body.task_time` accept `string | null`. **Send explicit `null` to clear** — `undefined` is dropped by `JSON.stringify` and no-ops server-side (verified comment in api.ts:101-114 and `TaskCard.setStart`).
  - `api.flightPlan.addTask(task_id)` → `{ flight_plan: FlightPlanItem[]; added: number }`.
  - `api.flightPlan.update(taskId, { selected })` → `{ flight_plan: FlightPlanItem[] }`.
  - `api.auto.run({ date })` → `{ result: AutoResult; flight_plan: FlightPlanItem[] }`. `AutoResult = { step, blocksCreated?, placed?, unplaced?, days? }`. Pass `{ date: selectedDay() }` (matches `FlightPlan.runSchedule`, api.ts:159); the server applies the Schedule-mode horizon (`planning_horizon_days`) so placement spans the week.
- **VERIFIED server semantics — do not overpromise the manual path.** `api.tasks.update({ scheduled_for, task_time })` on an **unplaced** task only *dates* it. It does **not** create a Planner block: `updateTask` (server/src/services/tasks.ts:448-453) calls `syncBlockFromTask`, which **returns `null` (no-op) when the task has no existing planned block** (server/src/services/block-task-sync.ts:268-275). A start-anchored block is materialized only by Auto, by `POST /api/tasks` with `auto_place`, or by quick-add. So: the **manual** action = "give the task a day/time" (mirrors `TaskCard.setStart`); the **"Let Auto place it"** action (stage + `auto.run`) is the one that produces a calendar block now. State this honestly in copy and Acceptance Criteria; never assert a block appears synchronously from the manual path.
- **Stage-then-run idiom (verified in `FlightPlan.tsx`).** `addTask` stages an item; `auto.run` places the **selected** staged items and removes placed items from the returned `flight_plan`. Determine whether *this* task was placed by its **absence from the post-run `flight_plan`** (`!after.some(i => i.task_id === id)`), not by the aggregate `result.placed` (Auto may also place other pre-staged items). Guard selection: after `addTask`, if the returned item's `selected === false`, call `api.flightPlan.update(id, { selected: true })` before running.
- **Stores (verified in `client/src/stores/index.ts`).** Import `showToast`, `selectedDay`, `flightPlanTaskIds`, `refetchFlightPlan`, `refetchBlocks`, `refetchTasks`. Toast signature: `showToast(msg: string, kind: 'success' | 'error' | 'default')`. `flightPlanTaskIds()` is a `Set<string>` memo of staged task ids. Do not read the global `tasks` resource for candidates — use a local `createResource` (mirrors `FlightPlan.tsx:98-101` backlog fetch).
- **Date/time inputs (verified idioms).** Day = `YYYY-MM-DD` from `<input type="date">` (`TaskCard.DateField`, currentTarget.value). Time = `HH:MM` from `<input type="time" step={900}>` (`FlightPlan.TemplateRow`, api.ts `task_time` is an `HH:MM` local wall time). Default the day to `localISODate()` from `client/src/lib/dates.js`.
- **Transcript seam (T2 dependency).** T2 owns the transcript. This branch appends through a **prop injected by T2's shell**, not a self-owned store. Confirm the exact export name/shape against the landed `PlanWeekAssistant.tsx` before wiring; do not re-declare T2's entry type if T2 exports one — import it. Contract this ticket targets:
  ```ts
  interface PlanWeekScheduleTasksProps {
    // Append one line to T2's session transcript. If T2 exports a
    // `PlanWeekTranscriptEntry` type, import and use it instead of this literal.
    appendTranscript: (entry: { role: 'assistant' | 'action'; text: string }) => void;
    // Let the shell return to the branch menu (empty state / "Done").
    onDone?: () => void;
  }
  ```
- **Solid store ordering.** Declare local resources/signals before any `createMemo` that reads them (eager-eval TDZ — reference in MEMORY). Follow the `createSignal`/`createResource`/`createMemo` ordering used in `FlightPlan.tsx`.

## Before implementation

Read these first and match their patterns exactly:

- `client/src/components/PlanWeekAssistant.tsx` — **the T2 shell.** Find (a) how it dispatches to the "Schedule tasks" branch, and (b) how it exposes the transcript append (prop vs. store). Wire this branch there.
- `client/src/lib/api.ts` — `api.tasks.list/update`, `api.flightPlan.addTask/update`, `api.auto.run`; the `Task`, `FlightPlanItem`, `AutoResult` types.
- `client/src/components/FlightPlan.tsx` — `runSchedule` (lines 155-172: `auto.run` → honest `placed`/`unplaced` copy → `refetchFlightPlan()`/`refetchBlocks()`), `stageFromBacklog` (111-117), and the local `openTasks` backlog resource (98-109, incl. the `!recurrence_parent_id` exclusion).
- `client/src/components/TaskCard.tsx` — `DateField` (49-112) and `setStart`/`setDue` (287-298) for the update-with-`null`-to-clear convention and inline date UI.
- `client/src/stores/index.ts` — `showToast`, `selectedDay`, `flightPlanTaskIds`, `refetchFlightPlan`, `refetchBlocks`, `refetchTasks`; the `createSignal`/`createResource`/`createMemo` ordering.
- `client/src/components/TaskCard.test.tsx` — the `vi.mock('../lib/api.js')` + `vi.mock('../stores/index.js')` seam pattern and `@solidjs/testing-library` `render` usage to copy for this branch's test.
- `server/src/services/tasks.ts` (`updateTask`, ~440-453) and `server/src/services/block-task-sync.ts` (`syncBlockFromTask`, 260-275) — **read-only**, to confirm the "manual update dates but does not place" semantics pinned above.

## Files impacted

**New:**
- `client/src/components/PlanWeekScheduleTasks.tsx` — the deterministic "Schedule tasks" branch component.
- `client/src/components/PlanWeekScheduleTasks.test.tsx` — vitest + `@solidjs/testing-library` coverage.

**Changed:**
- `client/src/components/PlanWeekAssistant.tsx` — mount `<PlanWeekScheduleTasks appendTranscript={…} onDone={…} />` at the shell's "Schedule tasks" branch, passing the transcript-append seam and a return-to-menu callback. (Insertion point depends on T2's branch dispatcher — do not restructure the shell.)

**Not changed:** `client/src/lib/api.ts` (all methods exist), any `server/**`, any `client/src/stores/index.ts` export.

## Schema required

None. This ticket adds no table, column, index, or migration.

## Definition of Done

- [ ] `PlanWeekScheduleTasks.tsx` exports a component taking `{ appendTranscript, onDone? }` (props reconciled against T2's landed transcript seam).
- [ ] **Candidates:** a **local** `createResource` fetches `api.tasks.list({ status: 'open' })` and filters to undated, schedulable tasks: `!t.scheduled_for && !t.is_habit && !t.recurrence_rule && !t.recurrence_parent_id && !flightPlanTaskIds().has(t.id)`. The global `taskFilter` signal is never mutated.
- [ ] The candidate list renders title + estimate (if any); loading and empty states are handled. Empty (no candidates) shows a clear "nothing to schedule" message and offers `onDone`.
- [ ] Selecting a task reveals a placement panel with: a day picker (`<input type="date">`, default `localISODate()`), an optional time (`<input type="time" step={900}>`), a **"Set"** (manual) action, and a **"Let Auto place it"** action.
- [ ] **Manual "Set":** calls `api.tasks.update(id, { scheduled_for: day, task_time: time || null })` (explicit `null` when no time). On success: honest toast + `appendTranscript`, then the task drops out of the candidate list (local refetch + `refetchTasks()`). Copy states the task is **scheduled for** that day/time — it must not claim a calendar block was created.
- [ ] **"Let Auto place it":** `api.flightPlan.addTask(id)` → ensure the staged item is `selected` (call `api.flightPlan.update(id, { selected: true })` if not) → `api.auto.run({ date: selectedDay() })`. Placement of *this* task is derived from `!flight_plan.some(i => i.task_id === id)` in the run response. On success: honest toast + `appendTranscript` (placed vs. "didn't fit"), then `refetchFlightPlan()`, `refetchBlocks()`, `refetchTasks()`, and the local candidate refetch.
- [ ] Every API call is wrapped in `try/catch`; failures call `showToast((err as Error).message, 'error')` and append **no** success line (an optional error line is fine). One in-flight guard prevents double-submit (a `running` signal, per `FlightPlan.tsx`).
- [ ] `PlanWeekAssistant.tsx` renders the branch and passes a working `appendTranscript` + `onDone`.
- [ ] No LLM import, no `api.tasks.create`, no `api.plan.*`, no server file touched.
- [ ] `pnpm --filter client typecheck`, `pnpm --filter client test`, and `pnpm --filter client build` all pass.

## Tests

Co-located `client/src/components/PlanWeekScheduleTasks.test.tsx` (vitest + `@solidjs/testing-library`), mocking `../lib/api.js` and `../stores/index.js` per the `TaskCard.test.tsx` seam pattern; pass a `vi.fn()` `appendTranscript` prop.

- [ ] **Candidate filtering:** given a mixed `api.tasks.list` result (one plain open+undated task, one with `scheduled_for` set, one `is_habit`, one with `recurrence_parent_id`, one already in `flightPlanTaskIds`), only the plain undated task renders.
- [ ] **Empty state:** `api.tasks.list` resolves `[]` → the "nothing to schedule" message renders; no crash.
- [ ] **Manual Set with time:** picking a task, setting day + time, pressing **Set** calls `api.tasks.update` once with `{ scheduled_for: '<YYYY-MM-DD>', task_time: '<HH:MM>' }`, calls `appendTranscript` once, and removes the task from the list.
- [ ] **Manual Set without time:** pressing **Set** with no time sends `task_time: null` (not `undefined`).
- [ ] **Auto place — success:** **Let Auto place it** calls `api.flightPlan.addTask(id)` then `api.auto.run`; with the run response `flight_plan` **not** containing the task id, `appendTranscript` gets a "placed" line and `refetchBlocks`/`refetchFlightPlan` are called.
- [ ] **Auto place — didn't fit:** run response `flight_plan` still contains the task id → `appendTranscript` gets a "didn't fit" line (no false "placed" claim).
- [ ] **Error path:** `api.tasks.update` rejects → `showToast(..., 'error')` is called and `appendTranscript` is **not** called with a success line.

```
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

(No server files change; `pnpm --filter server typecheck` / `pnpm --filter server test` are unaffected but may be run for belt-and-braces.)

## Acceptance Criteria

- [ ] **Given** the assistant is on the "Schedule tasks" branch and the owner has undated open tasks, **when** the branch mounts, **then** exactly those tasks (undated, non-habit, non-recurring, not already staged) are listed.
- [ ] **Given** a selected task, **when** the user picks a day (and optionally a time) and presses **Set**, **then** `api.tasks.update` is called with `{ scheduled_for, task_time: time || null }`, a transcript line records "Scheduled '<title>' for <day>[ at <time>]", and the task leaves the list.
- [ ] **Given** a selected task, **when** the user presses **Let Auto place it**, **then** the task is staged and Auto runs over the week; a transcript line honestly reports whether the task was placed (absent from the returned `flight_plan`) or "didn't fit", and the Planner refetches.
- [ ] **Given** any API call fails, **when** it rejects, **then** an error toast shows and no success transcript line is appended.
- [ ] **Given** no undated tasks remain (or all were just placed), **when** the list empties, **then** a "nothing to schedule" state is shown and `onDone` is reachable.
- [ ] No LLM path, no `api.tasks.create`, no new endpoint, and no server file is modified (verified by diff).

## Subtasks

1. [ ] Read `PlanWeekAssistant.tsx` (T2) to learn the branch dispatch + the exact transcript-append seam (prop or store); reconcile `PlanWeekScheduleTasksProps` with it.
2. [ ] Scaffold `PlanWeekScheduleTasks.tsx`: imports from `../lib/api.js`, `../stores/index.js` (`showToast`, `selectedDay`, `flightPlanTaskIds`, `refetchFlightPlan`, `refetchBlocks`, `refetchTasks`), and `localISODate` from `../lib/dates.js`.
3. [ ] Local candidate `createResource` over `api.tasks.list({ status: 'open' })` + the client-side undated/schedulable filter; loading + empty states.
4. [ ] Candidate list UI (title + estimate) with a select action revealing the placement panel (date input default `localISODate()`, optional `type="time"` input, **Set** + **Let Auto place it** buttons, `running` guard).
5. [ ] Manual **Set**: `api.tasks.update(id, { scheduled_for, task_time: time || null })` → honest toast + `appendTranscript` → refetch local candidates + `refetchTasks()`.
6. [ ] **Let Auto place it**: `addTask` → ensure `selected` → `auto.run({ date: selectedDay() })` → derive placement from the returned `flight_plan` → honest toast + `appendTranscript` → `refetchFlightPlan()`/`refetchBlocks()`/`refetchTasks()` + local refetch.
7. [ ] Wrap all calls in `try/catch` with `showToast(..., 'error')`; suppress success transcript lines on failure.
8. [ ] Wire `<PlanWeekScheduleTasks appendTranscript={…} onDone={…} />` into `PlanWeekAssistant.tsx` at the "Schedule tasks" branch.
9. [ ] Write `PlanWeekScheduleTasks.test.tsx` covering all cases above.
10. [ ] Run `pnpm --filter client typecheck`, `pnpm --filter client test`, `pnpm --filter client build`; fix to green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
