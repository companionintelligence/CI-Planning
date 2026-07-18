> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-review`
> **Commit style:** `feat(plan-week): deterministic review-past-data branch`
> **Design:** this ticket is the spec (see `docs/ftue-plan.md` §5 for the weekly-planning-assistant framing)
> **Dependencies:** T1 (`plan_week_sessions` table + `GET /api/plan-week/sessions` + `api.planWeek.session.list`), T2 (`client/src/components/PlanWeekAssistant.tsx` assistant shell with branch routing)

> ### 🚧 LIVE — issue #341, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.

## Goal

Fill in the assistant's **"Review past data"** branch as a fully deterministic, read-only weekly recap — no LLM. It composes the week that just ended from surfaces that already exist and are already tested — `weeklyReview()` (tasks done/overdue, block density, weekly intentions, rotting objectives), the global estimate-calibration readout, the five-star day rows, and day-note dates — **plus** the new planning-session history from T1. The composition is served by ONE thin aggregation endpoint, `GET /api/plan-week/review`, so the branch mounts a single resource with a single loading/error state instead of fanning out 4–5 parallel client fetches and re-deriving the ISO-week date range in the browser.

**Aggregation decision (the ticket asked to verify/justify):** BUILD the thin endpoint. Composing client-side would require 4–5 independent round-trips (`/api/review/week`, `/api/calibration`, `/api/stars`, `/api/reflections/notes`, `/api/plan-week/sessions`), 5 loading/error states, and re-implementing the Mon→Sun ISO-week math (`weekDays()`) in the client just to build the `/api/stars` `from`/`to` range. A single endpoint collapses that to one request, keeps the deterministic composition in one server-vitest-testable function, and gives the branch one `createResource`. It adds **no** migration and **no** new stats SQL — it only calls existing service functions.

## Non-goals (fence off adjacent work)

- Do **not** call any LLM: no `generate()`, no `renderCopy()`, no `parseInstruction()`/`authorPlanOrder()`, no `aiAvailable()` gate. This branch must render fully with Ollama offline. The narrative/prose summarization of the review is **T10 (consolidate)** — not here.
- Do **not** add any editing or mutation of past data: no PATCH/POST/DELETE against tasks, reflections/goals/notes, stars, objectives, or `plan_week_sessions`. The branch is strictly read-only.
- Do **not** create a migration or any new table/column. T5 reads existing tables + T1's `plan_week_sessions` only. (**Schema required = None.**)
- Do **not** write a new stats/aggregation engine. Reuse `weeklyReview()`, `listDayStars()`, `noteDates()`, the extracted `globalCalibrationReadout()`, and T1's session-list service **verbatim**. No new SQL over `tasks`/`time_blocks` for counts.
- Do **not** build the assistant shell (T2), the "plan next week / generate" branch, or the branch-routing mechanism. T5 only fills the content of the existing "Review past data" branch.
- Do **not** change `weeklyReview()`'s stat definitions, `WeeklyReview.tsx`'s layout, or `DayStarsRow.tsx`'s behavior. Extracting the calibration readout must leave `GET /api/calibration`'s response byte-identical.
- Do **not** modify T1's `plan_week_sessions` schema, its `GET /api/plan-week/sessions` handler, or its session-list service signature — only import/consume them.

## Pinned conventions

- **Owner scoping is automatic.** `requireAuth()` is global middleware in `server/src/app.ts` (`app.use(requireAuth())` before `mountRoutes`), gating every `/api/*` path; GET needs `planning:read`. A new GET handler on the plan-week router is auth-gated with **no per-route guard** — do NOT add one. Every read goes through the existing owner-scoped service functions, which resolve `currentOwnerId()` (`server/src/lib/context.ts`, throws if unscoped).
- **Reuse these exact exports** (verified):
  - `weeklyReview(anchor: string): WeekReview` — `server/src/services/weekly-review.ts` (returns `{ week_key, days[7], tasks_completed, tasks_overdue, blocks_count, weekly_goals[], objectives_rotting }`).
  - `listDayStars(owner: string, from: string, to: string): DayStarsRow[]` — `server/src/services/stars.ts` (per-date frozen-or-live five-star rows; `total` field per row).
  - `noteDates(owner: string, from: string, to: string): string[]` — `server/src/services/reflections.ts` (dates in range that carry a `day_note`).
  - T1's session-list service function (confirm its real name/signature in T1's `server/src/services/plan-week.ts` — assumed `listPlanWeekSessions(owner, …)` returning `PlanWeekSession[]`).
- **Calibration readout dedup.** The bare `GET /api/calibration` handler in `server/src/routes/review.ts` builds the global-scope readout inline (SQL: `estimate_calibration WHERE owner_id = ? AND scope_kind = 'global' AND scope_ref = ''`, then a `label` line). Extract it **unchanged** into `globalCalibrationReadout(owner: string)` in `server/src/services/weekly-review.ts`, returning the exact discriminated shape it returns today (`{ calibrated: false, sample_count } | { calibrated: true, sample_count, bias_ratio, p25, p50, p75, computed_at, label }`). Point both `routes/review.ts` AND the new aggregation at it. This is a source-of-truth dedup, not a behavior change.
- **Route registration.** T1 already creates and registers the plan-week router (via `mountRoutes` in `server/src/routes/index.ts`). Add `GET /api/plan-week/review` to **T1's router file** (`server/src/routes/plan-week.ts`); do NOT add a new router or a new `routes/index.ts` entry.
- **Default anchor = the week that just ended.** Add `priorWeekAnchor(today = localISODate()): string` (today − 7 days, noon-UTC pivot for DST safety — same pattern as `weekDays()`/`addDays()` in `weekly-review.ts`) to `server/src/services/plan-week-review.ts`. The route uses `ctx.query.anchor ?? priorWeekAnchor()`. Validate a supplied `anchor` with `isValidISODate` (`server/src/lib/dates.js`) → `422` on a bad value.
- **Client API.** Add `api.planWeek.review(anchor?)` to the `api.planWeek` namespace T1 created in `client/src/lib/api.ts`, using the existing `request<T>('GET', path)` helper: `request<PlanWeekReview>('GET', \`/plan-week/review${anchor ? \`?anchor=${anchor}\` : ''}\`)`. Export the `PlanWeekReview` type from `api.ts`.
- **Solid idiom.** Use `createResource`; declare the resource **before** any `createMemo` that reads it (module-scope eager-eval TDZ — see `reference_solid_module_memo_ordering`). Reuse the presentational component `WeeklyReview` (`client/src/components/WeeklyReview.tsx`) which already takes `{ data: WeekReview; calibration?: Calibration }` — feed it `review().week` and `review().calibration` directly rather than re-laying-out the stats.

## Before implementation

Read, in order:

- `client/src/components/PlanWeekAssistant.tsx` (T2) — find the branch identifier/slot for "Review past data" and mount the review content there. Confirm T2's branch signal name.
- T1's deliverables: `server/src/routes/plan-week.ts`, `server/src/services/plan-week.ts`, the `PlanWeekSession` type, and `api.planWeek.session.list` in `client/src/lib/api.ts`. Confirm the real session-list service export name/signature and the `PlanWeekSession` fields (started/finished timestamps, week key, and whatever summary it records) — the aggregation consumes T1's actual shape; do not invent fields.
- `server/src/routes/review.ts` (the inline calibration readout to extract) and `server/src/services/weekly-review.ts` (`weeklyReview`, `weekDays`, `addDays`).
- `server/src/routes/stars.ts` + `server/src/services/stars.ts` (`listDayStars`, `DayStarsRow`).
- `server/src/routes/reflections.ts` + `server/src/services/reflections.ts` (`noteDates`).
- `client/src/components/WeeklyReview.tsx` and `client/src/components/DayStarsRow.tsx` (reusable presentation; the `WeekReview`/`Calibration`/`DayStar` client types live in `client/src/lib/api.ts`).

## Files impacted

**New:**
- `server/src/services/plan-week-review.ts` — `planWeekReview(anchor)`, `priorWeekAnchor(today?)`, and the `PlanWeekReview` interface.
- `server/src/services/plan-week-review.test.ts` — vitest coverage for the aggregation + prior-week default.

**Changed:**
- `server/src/services/weekly-review.ts` — add `globalCalibrationReadout(owner)` (extracted from `routes/review.ts`, behavior-identical).
- `server/src/routes/review.ts` — `GET /api/calibration` now delegates to `globalCalibrationReadout(currentOwnerId())`; response unchanged.
- `server/src/routes/plan-week.ts` (T1) — add `GET /api/plan-week/review?anchor=YYYY-MM-DD`.
- `client/src/lib/api.ts` — add `api.planWeek.review(anchor?)` + export `PlanWeekReview` type.
- `client/src/components/PlanWeekAssistant.tsx` (T2) — implement the "Review past data" branch: one `createResource(api.planWeek.review)`, rendering `<WeeklyReview>`, a compact week-stars line, day-note dates, and a "recent planning sessions" list. Read-only.

## Schema required

None. No migration. T5 reads existing tables (`tasks`, `time_blocks`, `reflections`, `objectives`, `estimate_calibration`, `daily_recap`) and T1's `plan_week_sessions`; it creates nothing.

`PlanWeekReview` response shape (server type, mirrored client-side):

```ts
export interface PlanWeekReview {
  anchor: string;              // the resolved anchor (defaults to prior week)
  week: WeekReview;            // = weeklyReview(anchor) verbatim (includes weekly_goals)
  calibration: Calibration;    // = globalCalibrationReadout(owner) verbatim
  stars: {
    days: DayStarsRow[];       // 7 rows Mon→Sun, listDayStars(owner, week.days[0], week.days[6])
    fiveStarDays: number;      // count where day.total === 5
    totalStars: number;        // sum of day.total
  };
  reflections: {
    notedDates: string[];      // noteDates(owner, week.days[0], week.days[6])
  };
  sessions: PlanWeekSession[]; // T1's session list (most recent first; empty when none)
}
```

## Definition of Done

- [ ] `globalCalibrationReadout(owner)` lives in `server/src/services/weekly-review.ts`; `routes/review.ts` delegates to it; `GET /api/calibration` output is byte-identical to before.
- [ ] `server/src/services/plan-week-review.ts` exports `planWeekReview(anchor)` and `priorWeekAnchor(today?)`, composing `weeklyReview`, `globalCalibrationReadout`, `listDayStars`, `noteDates`, and T1's session list — with `fiveStarDays`/`totalStars` derived from the star rows.
- [ ] `GET /api/plan-week/review` on T1's router: defaults `anchor` to `priorWeekAnchor()`, validates a supplied `anchor` (`422` on invalid), returns the `PlanWeekReview` payload, and is auth-gated by the existing global `requireAuth` (no per-route guard added).
- [ ] `api.planWeek.review(anchor?)` added and `PlanWeekReview` exported in `client/src/lib/api.ts`.
- [ ] The "Review past data" branch in `PlanWeekAssistant.tsx` renders the aggregation as a scannable, read-only summary: `<WeeklyReview data={review().week} calibration={review().calibration} />`, a week-stars line (`fiveStarDays`/`totalStars`), the day-note dates, and a recent-planning-sessions list. Loading + empty states handled.
- [ ] No LLM call, no `aiAvailable()` gate, no mutation control anywhere in the branch or the endpoint.
- [ ] No migration file added; `server/src/db/migrations/index.ts` unchanged.

## Tests

- [ ] `plan-week-review.test.ts` — empty owner: `planWeekReview(anchor)` returns zeroed `week`, `calibration.calibrated === false`, `stars.days.length === 7` all `total 0`, `fiveStarDays === 0`, `totalStars === 0`, `reflections.notedDates === []`, `sessions === []`.
- [ ] `plan-week-review.test.ts` — seeded week: a `done` task with `completed_at` inside the week, a `day_note` on one in-week date, and one T1 planning session → assert `week.tasks_completed` reflects the task, `reflections.notedDates` includes that date, and `sessions.length === 1`.
- [ ] `plan-week-review.test.ts` — `fiveStarDays`/`totalStars` derive correctly from `stars.days` (seed/freeze at least one all-five day and assert the counts).
- [ ] `plan-week-review.test.ts` — `priorWeekAnchor('2026-07-13')` returns `'2026-07-06'` (7 days back, DST-safe).
- [ ] Regression: existing `server/src/routes/review.ts` calibration test(s) still pass after the extraction — `GET /api/calibration` shape unchanged for both `calibrated: false` and `calibrated: true`.
- [ ] Client: `PlanWeekReview` type + `api.planWeek.review` typecheck; the assistant branch builds. (Add a `PlanWeekAssistant` `*.test.tsx` mirroring the existing `client/src/components/*.test.tsx` pattern only if the review branch is unit-testable in isolation; otherwise rely on typecheck + build.)

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
pnpm --filter client test
```

## Acceptance Criteria

- [ ] **Given** an authenticated owner and no `anchor`, **when** the client opens the "Review past data" branch, **then** exactly one `GET /api/plan-week/review` fires and the response summarizes the **prior** week (Mon→Sun of `today − 7 days`).
- [ ] **Given** a week with completed tasks, weekly intentions, day notes, five-star days, and past planning sessions, **when** the branch renders, **then** the user sees the `WeeklyReview` stats, the week-stars line, the noted dates, and the sessions list — all read-only, with no edit affordances.
- [ ] **Given** Ollama is unavailable, **when** the branch renders, **then** it renders fully and correctly (deterministic; no AI affordance shown, no error).
- [ ] **Given** a supplied `?anchor=YYYY-MM-DD`, **when** valid, **then** that week is summarized; **when** invalid, **then** the endpoint returns `422`.
- [ ] **Given** the extraction refactor, **when** `GET /api/calibration` is called, **then** its response is identical to before this ticket.

## Subtasks

1. [ ] Extract the global calibration readout from `routes/review.ts` into `globalCalibrationReadout(owner)` in `services/weekly-review.ts`; delegate the route to it; confirm the calibration route test stays green.
2. [ ] Create `services/plan-week-review.ts`: `priorWeekAnchor(today?)`, the `PlanWeekReview` interface, and `planWeekReview(anchor)` composing the four existing reads + T1's session list, deriving `fiveStarDays`/`totalStars`.
3. [ ] Add `GET /api/plan-week/review` to T1's `routes/plan-week.ts` (default anchor, `isValidISODate` guard → `422`, no per-route auth guard).
4. [ ] Add `api.planWeek.review(anchor?)` and export `PlanWeekReview` in `client/src/lib/api.ts`.
5. [ ] Implement the "Review past data" branch in `PlanWeekAssistant.tsx`: one `createResource`, `<WeeklyReview>` reuse, week-stars line, noted dates, sessions list; loading + empty states; strictly read-only.
6. [ ] Write `services/plan-week-review.test.ts` (empty owner, seeded week, star derivation, `priorWeekAnchor`); run the five verification commands.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
