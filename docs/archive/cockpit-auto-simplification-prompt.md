# Cockpit Auto, simplification prompt

> A self-contained correction prompt for one coding agent. Goal: replace the
> overloaded single Auto button with three clear buttons and two small toggles,
> and move the work-hours fill setting out of the cockpit. Most of the engine
> already exists, this is mostly relabeling and rewiring, not new placement logic.
> Add a test with every change.

## Why this change

Today one lightning button does different things depending on hidden state
(whether the flight-plan is empty), and the Suggest/Schedule toggle silently
changes that behavior too. Two invisible state axes behind one button is the whole
source of confusion. The fix is to make every action explicit and labeled.

## Target cockpit

In the flight-plan header (`client/src/components/FlightPlan.tsx`):

- Button: Fill Flight Plan
- Button: Auto Schedule
- Toggle: Priority / Over-Due (ordering for the leftover fill)
- Undo: icon only, no text label, pinned at the far right of the header.

In the Day Overview header, beside the date (`client/src/views/Today.tsx`):

- Toggle: Suggest / Schedule (automation off / on), right-aligned, always present.

The "Fill work hours" control leaves the cockpit and becomes a per-direction
Settings option (Home, Work, Community).

---

## What already exists (do not rebuild)

- Fill step: `fillFlightPlanCandidates()` in `server/src/engine/autoplan.ts`
  pulls open tasks into the flight-plan ordered by priority then due date, now
  inserting `selected = 1`.
- Place step: `placeFlightPlan()` does tag-matched placement into Plans and
  pattern windows, around existing entities.
- Undo: `undoLastAuto()` plus `POST /api/auto/undo`, run-id stamped via
  `time_blocks.auto_run_id` and `owners.last_auto_run_id`.
- Per-direction fill already works end to end: the engine checks
  `pattern_prefs.auto_fill` per direction (autoplan pass 2a), the API is
  `GET/PUT /api/pattern-prefs`, and Settings already renders a per-pattern fill
  toggle (`patternFill` / `togglePatternFill` in `client/src/views/Settings.tsx`).
- Priority fill exists as `POST /api/auto/priority` (the current Priority button).
- Overdue is already a defined concept: `surfaceOverdue()` in
  `server/src/agents/groom.ts` and the summary counts key off `due_at < now`.

---

## Changes

### 1. Move "Fill work hours" into Settings, per Home / Work / Community

The cockpit "Fill work hours" button currently toggles the global
`scheduling_prefs.auto_fill_workday`. Replace it with the existing per-direction
fill preference.

- Remove the "Fill work hours" button from `FlightPlan.tsx`.
- In `client/src/views/Settings.tsx`, surface the per-direction fill toggle
  (already wired via `patternPrefs` / `api.patternPrefs.set` and
  `pattern_prefs.auto_fill`) as a clear control under each direction's
  preferences: "Fill work hours" for Home, Work, and Community.
- Engine: the leftover fill must gate on each direction's `auto_fill` (pass 2a
  already does this). Retire the global `auto_fill_workday` as a live control. For
  tasks with no direction tag, keep a single general default in Settings rather
  than a cockpit toggle (state the default you pick; current default is on).
- Acceptance: turning a direction's fill off in Settings stops Auto from filling
  that direction's open work hours; turning it on resumes it; no cockpit control
  remains for this.

### 2. Replace the Priority button with a Priority / Over-Due toggle

The leftover fill (the old tap 3) folds into Auto Schedule, and a toggle chooses
how that leftover fill is ordered. It is a toggle, not a button.

- Remove the standalone Priority button from `FlightPlan.tsx`.
- Add a small Priority / Over-Due segmented toggle, styled like the
  Suggest/Schedule toggle.
- Data: store the choice as a pref (for example `scheduling_prefs.fill_order`,
  text, default `'priority'`, values `'priority'` or `'overdue'`), reusing
  `GET/PATCH /api/prefs`.
- Behavior: Auto Schedule now does tag-matched placement first, then fills
  leftover capacity (only in directions whose fill is on, per change 1) using the
  chosen order:
  - Priority: highest priority first, P1 first. This is the existing
    `orderForPlan()` with no weights, reuse the current `/api/auto/priority`
    logic.
  - Over-Due: most overdue first, ordered by `due_at` ascending among open dated
    tasks. This function is not built yet, scaffold it as a clear, deterministic
    branch and a stub that orders by `due_at`, leaving a TODO for richer overdue
    rules. It must not throw when no tasks are overdue.
- Acceptance: the toggle changes the order leftover tasks are placed; Priority
  reproduces today's behavior; Over-Due places the most overdue first; switching
  the toggle and re-running Auto Schedule changes the result accordingly.

Note: this supersedes the earlier "priority is a separate third tap" decision. The
leftover fill now runs inside Auto Schedule, bounded by the per-direction fill
settings and reversible with Undo, so it is never unbounded and never silent
beyond what the user configured.

### 3. Move and relabel the Suggest / Schedule toggle

Move the toggle out of the flight-plan header into the Day Overview header in
`client/src/views/Today.tsx`, beside the date, right-aligned, and always present
(not conditional on the flight-plan having items). With explicit buttons it is
purely automation on/off, it no longer changes what any button does.

- Suggest: nothing schedules until the user presses a button.
- Schedule: new tasks auto-schedule as they arrive; buttons still work for manual
  runs.
- Set that exact wording as the toggle tooltip.
- Today.tsx needs the `prefs` / `refetchPrefs` store and the `auto_mode` set
  logic (move `mode()` / `setMode()` out of `FlightPlan.tsx`, or lift to a shared
  spot both read). Remove the toggle from `FlightPlan.tsx`.
- Acceptance: the toggle sits next to the date and shows on the Today view
  regardless of flight-plan state; in Suggest, no placement happens without a
  button press; in Schedule, ingest auto-fills and auto-places, and the buttons
  still work as manual runs.

### 4. The three buttons, explicit and single-purpose

In `FlightPlan.tsx`, split the overloaded lightning button.

- Fill Flight Plan: always runs `fillFlightPlanCandidates` (open tasks into the
  flight-plan by P rank). Never places anything.
- Auto Schedule: always places the selected staged items (tag-matched), then runs
  the leftover fill per change 2. Never proposes candidates.
- Undo: the existing `undoLastAuto` (last run only, no confirmation). Render it as
  an icon only, drop the "Undo" text label, and pin it at the far right of the
  flight-plan header (keep the `Undo2` icon and the `canUndo()` visibility).
- Remove the empty-vs-nonempty branching from the button layer. `runAuto()` keeps
  its internal logic, but the UI now calls the fill path and the place path
  through two distinct buttons, not one button reading hidden state.
- Acceptance: each button does exactly one thing every time, with a label that
  says what it does; pressing Fill Flight Plan never schedules; pressing Auto
  Schedule never just proposes.

---

## Files that change

- `client/src/components/FlightPlan.tsx`: remove the Fill-work-hours button, the
  Priority button, and the Suggest/Schedule toggle; split the lightning button
  into Fill Flight Plan and Auto Schedule; add the Priority/Over-Due toggle; make
  Undo icon-only and pin it far right.
- `client/src/views/Today.tsx`: add the Suggest/Schedule toggle beside the date in
  the Day Overview header, right-aligned, always present, with the tooltip wording
  and `auto_mode` set logic.
- `client/src/views/Settings.tsx`: surface per-direction "Fill work hours" for
  Home, Work, Community (uses existing `patternPrefs`); add the general fallback
  default for undirected tasks.
- `client/src/lib/api.ts`: add the `fill_order` pref field; keep `api.auto.run`,
  `api.auto.undo`; fold the priority path into Auto Schedule (or keep
  `/api/auto/priority` as the engine for the leftover fill, called by Auto
  Schedule).
- `server/src/engine/autoplan.ts`: Auto Schedule does place then leftover fill,
  ordered by `fill_order`; add the Over-Due ordering branch (stub by `due_at`);
  gate leftover fill on per-direction `auto_fill`; retire the global
  `auto_fill_workday` live control.
- `server/src/routes/flight-plan.ts` and/or `prefs`: pass `fill_order` through.
- `server/src/db/migrations/0049_*.ts`: add `scheduling_prefs.fill_order`
  (default `'priority'`). Keep `auto_fill_workday` column for the undirected
  default, or migrate its meaning, state which.

---

## Test plan

- Fill Flight Plan only fills, by priority then due date; never creates blocks.
- Auto Schedule places selected items tag-matched, then fills leftover capacity
  only where the direction's fill is on.
- Priority/Over-Due toggle: Priority places P1 first; Over-Due places the most
  overdue first; with nothing overdue, Over-Due does not throw and falls back
  sensibly.
- Per-direction fill in Settings: off for Work stops Work-hours filling; Home and
  Community unaffected.
- Suggest vs Schedule: Suggest never places without a button; Schedule auto-places
  on ingest and the buttons still work.
- Undo still reverts the last run exactly and re-stages those tasks.
- No overlap regression: leftover fill flows around existing blocks; re-run
  idempotent.

---

## Build order

1. Split the lightning button into Fill Flight Plan and Auto Schedule (change 4).
   Small, removes the main confusion immediately.
2. Move Fill-work-hours to per-direction Settings, remove the cockpit button
   (change 1). Mostly UI plus an engine gate that already exists.
3. Add the Priority/Over-Due toggle and fold the leftover fill into Auto Schedule;
   scaffold the Over-Due branch (change 2). Medium.
4. Relabel the Suggest/Schedule tooltip (change 3). Trivial.
