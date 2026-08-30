> **Type:** Frontend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-suggest-surface`
> **Commit style:** `feat(balance): one-tap stage from the dimension drawer's Open list`
> **Design:** [README.md](README.md)
> **Dependencies:** None

## Goal

Add a one-tap "Stage" action to the dimension drawer's existing Open-tasks list, so
an owner looking at "3.2h unallocated this week" can act on it without leaving the
drawer. The read already exists — this ticket adds only the write affordance.

**Superseded by a rebase, not by design:** this ticket originally planned to add a
server endpoint plus an "Unallocated" field to the drawer. Both are now redundant —
`server/src/db/migrations` PR #587 (merged to `origin/main`, pulled into this branch
by the 2026-08-29 rebase) already shipped `client/src/lib/dimension-rollup.ts` and
rebuilt `DimensionPanel` (`DetailsDrawer.tsx`) with a week/month-scoped Allocation
group — Target, Scheduled, Unallocated-or-Over-target — computed entirely
client-side from `api.blocks.list()`. It is a better version of what this ticket
planned to build. What it does NOT have: any way to act on the shortfall. Every row
in the panel's Open list opens the task (`setActiveTask`); none stages it.

## Non-goals

- **Do not add a server route.** Everything this ticket needs — the shortfall
  number, the candidate open tasks — is already fetched and computed client-side in
  `DimensionPanel`. Adding a server round-trip here would duplicate data the
  component already has, which is exactly the mistake this rewrite is correcting.
  (This also means the wave's server shortfall service, ticket 1, gains no new
  caller from this ticket — it stays scoped to what tickets 3/4 need for
  server-side bias, which cannot reach client code.)
- **Do not touch `Balance.tsx`.** PR #587 deliberately removed Balance.tsx's Focus
  Areas rail in favor of the drawer as the single place for per-dimension detail
  (`Balance.tsx:149` comment: "Single column since the Focus Areas rail was
  removed"). Adding a shortfall readout back onto the summary view would work
  against that simplification. The drawer is one click away and already shows it.
- **Do not re-sort or re-fetch `openTasks()`.** Reuse the panel's existing
  `openTasks()`/`openGroups()` exactly; only add an ordering comparator ahead of
  the existing `groupByTitle` call (see Pinned conventions) and the Stage button.
- **Do not auto-stage.** The tap is the only write; nothing stages without it
  (same posture the original ticket pinned — the human tap is the write).
- **Do not gate on `balance_bias_enabled`.** Unchanged from the original ruling:
  this is a read-and-act surface, independent of the bias pref.
- **Do not add a "suggested" concept distinct from the Open list.** One list,
  one action per row (or per top row — see conventions); no new hidden ranking
  the owner can't see for themselves.

## Pinned conventions

- **Ordering:** `openTasks()` (`DetailsDrawer.tsx:654-659` today) is currently
  unsorted before `groupByTitle`. Add a comparator matching the candidate-fill
  order the rest of the wave already cites (`engine/autoplan.ts:780`):
  `priority, COALESCE(due_at, '9999-12-31'), id` — client-side equivalent:
  `.sort((a, b) => a.priority - b.priority || (a.due_at ?? '9999-12-31').localeCompare(b.due_at ?? '9999-12-31') || a.id.localeCompare(b.id))`
  inserted right before the existing `groupByTitle(openTasks(), ...)` call, so the
  list an owner already sees also becomes consistently ordered (today it is not,
  which this ticket treats as a small pre-existing gap worth closing alongside the
  new button, not a separate ticket).
- **Stage button:** in `RollupRow`'s open-list usage
  (`DetailsDrawer.tsx:747-749` today), add a second action beside the existing
  row click — a small icon button (reuse the `Lock`/similar icon-button sizing
  already in this file, e.g. 11px, `text-muted-foreground hover:text-foreground`)
  that calls `api.flightPlan.stage(g.first.id)` (`api.ts:539`,
  `POST /flight-plan` with `{ task_id }`) and does NOT also trigger the row's
  `setActiveTask` (stop propagation). On success, refetch whatever resource backs
  `tasks()` so the staged task's status reflects immediately (check
  `stores/index.ts` for the existing refetch the row's other mutations already
  use — match it, don't invent a second refresh path). On failure, `showToast`
  with the error message (existing app-wide pattern — grep `showToast` for the
  call shape used elsewhere in this file).
- **Visibility:** show the Stage button only when `unallocated() > 0` (the
  existing signal, `DetailsDrawer.tsx:649` today) — met or over-target dimensions
  get no stage affordance, since there's nothing to fill. This reuses the exact
  signal the Allocation group already renders from; do not recompute it.
- **Scope:** the button appears on every row of `openGroups()`, not just the
  first — a `TitleGroup`'s `first` field already carries the single task id to
  stage (a grouped repeat-count row stages its first occurrence). This matches
  "one action per row" from Non-goals rather than singling out a "top pick" the
  owner didn't choose.

## Before implementation

Read `DetailsDrawer.tsx:618-781` (the current `DimensionPanel` in full — note the
exact current line numbers for `openTasks`/`openGroups`/`RollupRow` usage, since
they will have shifted again by implementation time), `lib/dimension-rollup.ts`
(the pure helpers, esp. `groupByTitle` and `TitleGroup`), `api.ts:433-460`
(`api.blocks.update`/`api.flightPlan.stage` shapes), and `Balance.tsx:44-49`
(`openTasksFor`'s comment — the precedent this ticket is following: "a pure
client-side join... so no new server surface").

## Files impacted

**Changed:**
- `client/src/components/DetailsDrawer.tsx` — `DimensionPanel`: sort `openTasks()`
  before grouping; add the Stage button to open rows

**Changed (test):**
- `client/src/components/DetailsDrawer.dimension.test.tsx` — already covers
  `DimensionPanel`'s five contracts (see its header comment); extend it with a
  sixth: staging from the Open list. Do not create a second test file for the
  same component.

## Schema required

None.

## Definition of Done

- [ ] Open list within a dimension panel is ordered priority → due_at → id
- [ ] A Stage button appears on each Open row only when `unallocated() > 0`
- [ ] Tapping it calls the existing flight-plan stage endpoint for that row's task,
      does not also open the task modal, and the list reflects the change
- [ ] A dimension at or over target shows no Stage buttons
- [ ] A failed stage call surfaces the existing toast pattern and leaves the row
      as before (task not silently marked staged)

## Tests

- [ ] Ordering: three open tasks, mixed priority/due_at ⇒ correct sequence
- [ ] Button visibility: `unallocated() > 0` shows it; `<= 0` hides it
- [ ] Tap stages the correct task id and does not navigate to the task panel
- [ ] A stage-endpoint failure shows the toast and does not change task state
- [ ] Grouped (repeated-title) row stages `first`'s id, not a different occurrence

```bash
pnpm --filter client exec vitest run client/src/components/DetailsDrawer.dimension.test.tsx
pnpm typecheck && pnpm test
```

## Acceptance Criteria

- [ ] Given Health 10h unallocated with open Health tasks, when the owner opens the
      Health drawer, then Open rows are priority/due-ordered and each carries a
      Stage button that adds that task to the flight plan (nothing placed on the
      calendar)
- [ ] Given a dimension at or over target, then no Stage buttons render

## Subtasks

1. [ ] Re-read current `DimensionPanel` to confirm line numbers and confirm no
       further drawer changes have landed since this ticket was written
2. [ ] Add the sort comparator ahead of `groupByTitle`
3. [ ] Add the Stage button + click handler + refetch
4. [ ] Five tests
5. [ ] Run verification
