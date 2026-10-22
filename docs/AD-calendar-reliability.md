# Phase AD — Calendar reliability + scheduling fixes

Status: IN BUILD (2026-07-06). Branch: claude/ac-today-ui (folded into PR #292).
Owner decisions (2026-07-06):
- Time blocks: a Work/Home/Community **direction** primary tag COEXISTS with the category
  picker (block may carry both `time_blocks.tag` = direction and `category_id`).
- A scheduled task with NO time is AUTO-PLACED in that day's direction window on create.

Schema facts (verified live): direction axis = `tags.kind='direction'`, base work/home/community;
task tags = `entity_tags(entity_kind='task', level=1)` for primary; time-block direction =
`time_blocks.tag` (denormalized string); `tag`/`category_id` split is CONVENTION, not a DB CHECK.
(AF-4, 2026-07-11: the leftover service-level tag-XOR-category guard in `services/blocks.ts` was
relaxed to match this contract — create/update now accept both; category-frozen `color_token`
still wins when both are set.)

## Root cause of the reliability bug (all reported symptoms = one cause)

`task_time` is honored ONLY by the start-anchored path (`placeStartAnchoredTask`). Elsewhere it's ignored:
- Quick-add (`routes/tasks.ts:186` /quick) creates the task from `parseQuick` but calls NO
  placement → no block → invisible.
- Flight-plan `placeFlightPlan`/`placeIntoWindow` (`autoplan.ts:281`) ignores `task_time`
  (not in `StagedTask`/`selectedStaged`) → packs by priority/gaps → 2pm task lands at 10am.
- Re-saving via the wizard → `auto_place` → `placeStartAnchoredTask` honors task_time → 2pm.

## Slices

### AD1 — task_time authoritative (SERVER)

> **Shipped — pattern-placement pinning (#615, merged 2026-09-15 as `wip(scheduling)`; settled
> here 2026-10-21, Track D4).** The last AD1 gap was *routine* placement: nightly pattern
> placement wrote through `syncTaskFromBlock`, which sets `task_time` on the task — and on a
> task `task_time` means a user-stated **pin**, so the job that existed to honour pins was
> erasing them every night. What landed in `engine/patterns-place.ts` (+ `blocks-place.ts`):
>
> - Placement now routes through `mirrorEnginePlacement` (`services/block-task-sync.ts`), which
>   mirrors the engine's block onto the task **without** touching `task_time`.
> - A routine's candidate windows are the discrete `windows[]` derived from its own direction
>   tags (a home routine is never packed into work hours); when a routine derives no windows at
>   all, the fallback is the day's **work + community** fill — the hard-coded 09:00–18:00
>   fallback that read the abandoned `workday_start/_end` columns is gone (#583 removed it;
>   the rebase kept that).
> - For a recurring routine the **occurrence instance's own `task_time` wins** over the
>   master's (dragging ONE occurrence pins that occurrence only).
>
> The commit message noted a `triality-metrics` failure "pre-existing on clean main"; the full
> server suite is green as of 2026-10-21 (3,599 passed), so nothing from #615 is quarantined.
> Behaviour is covered by the `patterns-place`, `blocks-place` and `blocks-service` suites.
- `engine/quickadd.ts parseQuick`: when a time is present, ALSO set `scheduledFor` to the
  parsed instant's LOCAL date (so "2pm" has scheduled_for=today + task_time=14:00). Keep
  dueAt as-is. Bare-date behavior unchanged.
- `routes/tasks.ts` POST /api/tasks/quick: after insert, if the task has `scheduled_for`,
  call `placeStartAnchoredTask(owner, id)` (time → exact; no time → day's direction window,
  per owner decision), then broadcast so it shows. Best-effort (logger.warn on failure).
- `engine/autoplan.ts` flight-plan: add `task_time` to `StagedTask` + `selectedStaged`.
  In `placeFlightPlan`, a staged task with a `task_time` on the target date is PINNED at that
  time (reuse the start-anchored/`isPinned` logic — treat as a fixed obstacle) and excluded
  from the gap-packer; flexible (time-less) tasks pack around the pins. Net: a pinned time is
  respected in create, quick-add, flight-plan, and auto.

### AD2 — container → task direction inheritance (SERVER + client)
- When a task lands in a container (`engine/blocks-place.ts placeTasksInBlock`, `autoplan.ts
  placeIntoWindow` into a Plan, `routes/blocks.ts` add-tasks): if the task has no level-1
  direction tag, set `entity_tags(entity_kind='task', tag=<container direction>, level=1)`
  from the container's `time_blocks.tag` (or pattern tag). Also stamp the created task-block's
  `tag` to match (blocks-place/autoplan currently leave it NULL).
- Client wizard: when opening in a container context, default `form.primary` to the
  container's direction (nice-to-have; server inheritance is the source of truth).

### AD3 — New Task form layout (CLIENT, ElementWizard.tsx ~577-599)
- Replace `Start`(full) + `[Time|Min|Due]` (grid-cols-3) with a 2-col grid:
  LEFT col: Start-day (date) stacked over Due-day (date); RIGHT col: Start-time stacked over
  Duration (min).
- Default `dueAt = scheduledFor` on open (signals init ~161); mirror Start→Due until the user
  edits Due (a `dueEdited` flag).

### AD4 — time-block direction primary tag (CLIENT)
- In the timeblock wizard branch (~419-439, currently category-only), ADD a Work/Home/Community
  direction picker that sets `form.primary`. Keep the category picker (coexist). `element.ts`
  saveElement already maps `form.primary`→`tag`; ensure it isn't filtered out for timeblocks.

### AD5 — Alt free-drag (CLIENT, Planner.tsx + drag.ts)
- Extend the existing Alt handling (currently Alt=detach at Planner.tsx:126/593/605): a held-Alt
  MOVE bypasses collision clamping — drop exactly where released, overlap allowed — for task
  chips and blocks; nested blocks still detach on drop. Hook `clampLiveDyFor` (return raw dy on
  altKey) + the `resolveGesture`/commit path (skip neighbours / no clamp on altKey).

## Tests
- AD1: parseQuick("2pm") sets scheduled_for+task_time; quick route places a block at task_time;
  quick "breakfast tomorrow" places in tomorrow's window; flight-plan pins a task_time task at
  its time while packing a time-less one around it.
- AD2: task added to a container with direction X gets entity_tags level-1 X; task-block tag=X.
- AD3/AD4/AD5: client — form defaults due=start; timeblock direction picker sets tag; alt-drag
  helper bypasses clamp (pure fn test where possible).

## Out of scope
- Renaming direction↔pattern (owner: naming unsettled, do NOT adhere to the consolidation).
