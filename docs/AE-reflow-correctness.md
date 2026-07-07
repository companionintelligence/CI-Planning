# AE — Reflow correctness: stop the wipe

**Status: built (PR 1 of 2).** Fixes the bug where editing one placed task's start time
made every other flight-plan-placed task disappear from the planner. PR 2 (hardening:
narrowed replan triggers, locked-block guards on reschedule, legacy `runScheduler`
removal, day-scoped pin idempotency) follows separately.

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

Related: `docs/AB-natural-scheduling.md` (start intent), `docs/AD-calendar-reliability.md`
(AD1 pins), `docs/archive/M-ai-scheduler.md` §B (original reflow design, superseded here).
