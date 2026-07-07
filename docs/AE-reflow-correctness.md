# AE — Reflow correctness: stop the wipe

**Status: built (PR 1 + PR 2).** Fixes the bug where editing one placed task's start time
made every other flight-plan-placed task disappear from the planner, plus the peripheral
scheduling-correctness findings. PR 1 = the reflow rewrite (below); PR 2 = the hardening
in [§ PR 2](#pr-2--hardening).

## The bug

`PATCH /api/tasks/:id` fires `requestReplan('task:updated')` → debounced `reflow()`.
Reflow's re-place set was `daily_plan ∩ status='open' ∩ currently-placed`, but
`clearPriorAuto` deleted **all** of the day's `is_auto=1, source_kind='agent'` task
blocks. Clear-everything / re-place-a-subset ⇒ any placement outside the restage set
was silently unscheduled. Entry conditions (all reproduced in `test/reflow-wipe.test.ts`):

- **A — author-once staleness.** `authorPlanOrder` freezes `daily_plan` on the day's
  first Auto run; anything staged + placed later had no row → invisible to restage.
- **B — status ≠ 'open'.** The wizard / add-tasks / routine paths flip placed tasks to
  `'scheduled'`; the restage filter excluded them.
- **C — no `daily_plan` at all.** `autoScheduleOnIngest` (hands-off ingest, calendar-sync
  cron) never authors; the same cron then fired `requestReplan('calendar')` and could
  wipe what it had just placed.

The explicit path had the same asymmetry: a **second Auto run** of the day deleted the
first run's placements (no longer staged, so cleared but not re-placed).

## The contract now

1. **Snapshot-based reflow** (`engine/auto-defense.ts`). The re-place set is exactly the
   movable blocks reflow snapshotted — clear set == re-place set by construction.
   `daily_plan` is an *ordering* hint only (authored position first, current block-start
   order for the unauthored tail — minimal movement). Blocks whose task is terminal
   (done/cancelled/…) are garbage-collected: cleared, never re-placed. Reflow never
   reads or writes `flight_plan` (re-placement goes through `placeFlightPlan`'s
   `replaceTaskIds`), so a re-place failure can't leak rows into the staging UI.
2. **Scoped clears** (`engine/autoplan.ts`). `clearPriorAuto` / `clearPriorAutoInWindow`
   take the task-id set the run is about to (re)place; an empty set clears nothing.
   Explicit Auto runs are now **additive**: placed-but-unstaged work survives re-runs.
3. **Status-vocabulary alignment.** The clear excludes `'missed'`/`'cancelled'` blocks
   (settled history — e.g. the review surface's missed evidence), matching the
   snapshot/obstacle queries.
4. **Status parity (R2).** Every placement path now flips `open → scheduled`.
   Engine-chosen placements mirror `scheduled_for` (via `mirrorEnginePlacement`) but
   **never `task_time`** — a wall-clock time on the task is reserved for user-stated
   intent; if the engine wrote it, the next run's AD1 pin pass would freeze the chosen
   slot as an `is_auto=0` pin and reflow would rust solid. The reverse edge holds too:
   a task whose placement is cleared/skipped and not re-placed reverts `scheduled → open`
   (`placeFlightPlan` unplaced, reflow GC, `sweepMissedBlocks` before its re-queue check).
5. **Not-before-now clamp (R3).** On the owner-local *current* day, engine-chosen slots
   never start before `now` — a late-day reflow packs the remaining day instead of
   moving future work into already-past morning gaps (which the missed sweep would
   immediately recycle). Exact user `task_time` pins are exempt (stated intent is
   honored even in the past). Other days are unclamped. `nowMs` is injectable
   throughout for deterministic tests.
6. **Owner-tz reactive dates.** `fireReplan`/`reflow`/`sweepMissedBlocks` default to the
   owner's current day (`scheduling_prefs.timezone`), not the server's calendar day.

## Invariants worth keeping in review

- The clear set and the re-place set must remain the same set in every placement path.
- `task_time` is written only by user-intent paths (wizard, quick-add parse, task PATCH,
  block drag via `syncTaskFromBlock`) — never by engine placement.
- A `'scheduled'` task always holds an active placement; every path that removes a
  task's last active block must call `revertTaskPlacementStatus`.
- A `is_locked = 1` task block is a deliberate user pin: no engine path (reflow clear,
  reschedule, nightly review, missed sweep) may delete, relabel, or relocate it.

## PR 2 — hardening

The peripheral findings from the same audit, each low-risk on its own but load-bearing
for how safe the reflow fix stays over time.

1. **Narrowed replan trigger (H1).** `requestReplan('task:updated')` now fires only when
   the edit touched a scheduling column (`services/tasks.ts › updateTouchesSchedule`:
   `scheduledFor`/`taskTime`/`estimatedMinutes`/`priority`/`dueAt`/`status`/`completedAt`/
   `deferUntil`). A title/notes/tag edit no longer churns the day. Gated identically in
   the REST route and the GraphQL `updateTask` resolver.
2. **Locked-block guards (H2).** `rescheduleTask` and the nightly `reviewAndReschedule`
   skip `is_locked = 1` blocks — a pinned placement is never destroyed by a reschedule
   or a defer. The review's missed-detection query *also* excludes locked blocks, so a
   pinned-but-not-done past block never triggers an endless nightly re-defer (it isn't
   "missed work").
3. **Legacy `runScheduler` removed (H3).** The unrouted backlog-packer in
   `engine/scheduler.ts` had an unscoped day-clear (no `block_kind`/`source_kind`/
   `is_locked` filter) that would delete routine and container blocks if ever re-wired.
   Deleted along with its only caller-less helper `agents/plan.ts › orderForToday`; the
   shared gap primitives (`buildGaps`/`pickGap`/`splitIntoSessions`/`dayObstacles`) stay.
4. **Day-scoped pin idempotency (H4).** `placeStartAnchoredTask`/`pinTaskAt` treated
   *any* active block anywhere as "already placed", so a stale block on another (often
   past) day silently suppressed the stated `(scheduled_for, task_time)`. Now
   `reconcilePriorPlacement` is idempotent only against a block **on the stated day** (or
   a locked pin anywhere, which is honoured, not fought); a stale *unlocked* block on
   another day is cleared so the stated day wins (a "move").
5. **Sweep requeue positions (H5).** `sweepMissedBlocks` re-queues each task at
   `nextPos()` instead of a hard-coded position `0`, so requeue order is stable across
   sweeps. Multi-session edit behaviour was re-checked post-AE (the pin pass's day-scoped
   idempotency absorbs the moved block) — characterized by a test: no double-placement.

Related: `docs/AB-natural-scheduling.md` (start intent), `docs/AD-calendar-reliability.md`
(AD1 pins), `docs/archive/M-ai-scheduler.md` §B (original reflow design, superseded here).
