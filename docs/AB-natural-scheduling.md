# Phase AB — Natural Scheduling (start-anchored placement, click-to-create, due list)

Status: IN BUILD (2026-07-06)
Owner decisions (2026-07-06, all four recommended options accepted):
1. Start anchor: blocks are created IMMEDIATELY on save/promote for tasks with a start day.
2. Memory events MIRROR the event (block at the event's exact start time on its day).
3. Open window = no overlapping active block; enforced in BOTH Calendar and Planner clicks.
4. Due list: always-visible "Due" section on the Today view for the selected day.

## The model

- `scheduled_for` (+ optional `task_time`) = START intent — the only thing that picks a
  block's DAY (and time). Written by the wizard and by ingestion; now finally HONORED by
  the engine.
- `due_at` = DEADLINE only. Surfaces in due/overdue lists and ordering. NEVER selects the
  placement day. (This was the AA gap: ingestion stuffed event starts into due_at, and
  placement dumped everything on "today".)

## Diagnosis being fixed (verified 2026-07-06)

- `placeFlightPlan` hardcodes `date = localISODate()` (autoplan.ts:421) and never reads
  `scheduled_for`/`task_time` — both columns exist since 0002/0004 but are vestigial for
  placement (only reminders/re-stage read them).
- `fillFlightPlanCandidates` stages future-scheduled tasks into TODAY's plan.
- memory-suggest wrote the event start into `proposed_due_at`; promote → today.
- Planner grid hints "click an empty slot to add a block" but has no handler
  (Planner.tsx:887); Calendar click-to-create exists (CalendarGrid.tsx:306-316 →
  ElementWizard prefill) but allows clicking over occupied slots.
- Today view's due-today list is hidden behind a count-button expansion (Today.tsx:223).

## Slices

### AB1 — Engine honors start intent (server)

- New shared helper (engine/autoplan.ts): `placeStartAnchoredTask(owner, taskId)` —
  for a task with `scheduled_for`:
  - `task_time` set → block exactly at (scheduled_for, task_time), duration =
    estimated_minutes (fallback default_time_block_minutes). If that exact span overlaps
    an active block → nearest open gap the SAME day (buildGaps/dayObstacles, scheduler.ts:288).
  - no `task_time` → direction-window placement for THAT date (pass-2a logic against the
    date's day-type windows), else workday-gap fallback on that date.
  - Works for any future date. Returns the block or an 'unplaced' marker (day full).
- Trust semantics: start-anchored placement is NOT trust-gated — the user (or accepted
  suggestion) stated the day/time; honoring it is not engine autonomy. The trust dial
  continues to gate engine-CHOSEN placement (autoScheduleOnIngest for start-less tasks).
- Promote path (routes/possibles.ts / services/possibles.ts): after task creation, if the
  task has `scheduled_for` → `placeStartAnchoredTask` (any trust mode); else the existing
  trust-gated `autoScheduleOnIngest` (unchanged, still date=today for start-less tasks).
- `fillFlightPlanCandidates`: exclude tasks whose `scheduled_for` is set and ≠ the fill
  date (future-scheduled work no longer leaks into today's plan; a task scheduled for the
  fill date may still stage if it has no block yet).
- POST /api/tasks: opt-in `auto_place: true` body flag triggers the same helper (the
  wizard keeps creating its own block explicitly — no double placement; flag exists for
  API/agent callers).
- due_at handling unchanged (ordering, overdue lists, reminders).

### AB2 — Memory suggestions mirror the event (server)

- Migration 0115: possible_tasks + `proposed_scheduled_for` TEXT (YYYY-MM-DD),
  `proposed_task_time` TEXT (HH:MM), appended last; schema.ts + snapshot updated.
- memory-suggest templateTask: scheduled_for/task_time = event start (owner's timezone
  wall-time for the HH:MM), due_at = event start (deadline = event begins),
  estimated_minutes = event duration when end_time is known (else 30), title = the event
  name (mirror framing replaces "Prep for X").
- upsertPossible persists the two new proposed_* fields; promote copies them to the task,
  then AB1's promote hook places the block at the event's exact time on its day.

### AB3 — Click-to-create in Planner + open-window enforcement (client)

- Planner.tsx: port CalendarGrid's click detection (near-zero pointer move, 15-min snap)
  → open ElementWizard with prefill { day: selectedDay, start: clicked HH:MM }. The wizard
  already saves Task+linked Block → lands directly on the planner as a scheduled task.
- Open-window rule in BOTH CalendarGrid and Planner: a click whose snapped time falls
  inside any active (non-completed/cancelled) block's span is IGNORED for create (block
  taps keep their existing open/edit behavior). Any free hour of the day is allowed.

### AB4 — Always-visible Due section on Today (client)

- Today.tsx: pinned "Due" card for the selected day — tasks with due_at on that day plus
  an overdue rollup (works for any navigated date, not just today). Replaces the hidden
  count-button expansion as the primary surface (count buttons stay).

## Tests

- AB1: start+time exact placement (incl. future date); occupied-slot → same-day gap;
  start-no-time → direction window of that date; fill excludes future-scheduled;
  promote places regardless of trust mode; start-less promote keeps trust gating.
- AB2: staged possible carries proposed_scheduled_for/task_time; promote → task fields →
  block at event time on event day (fixture events at now+20h/now+30h); estimate = event
  duration.
- AB3/AB4 (client): planner click opens wizard with correct prefill; click over an
  occupied span is a no-op; Due card lists due-that-day + overdue.

## Out of scope

- Multi-day engine horizon (T-SCHED-2) beyond honoring explicit starts; AA2/AA3/AA4.
