# Corrections prompt, Companion Planning

> A structured, copy-pasteable prompt for a coding agent. Each item states the
> change, where it lives in the codebase, acceptance criteria, and notes. Grounded
> in the current source so the agent does not have to rediscover it.

## How to use this

Hand the agent the "Global constraints" section plus whichever numbered items you
want done. Each item is self-contained. Ask for a test with every change.

---

## Global constraints

- Stack: Koa + TypeScript server (`server/`), SolidJS + Tailwind client
  (`client/`), SQLite via Drizzle and raw better-sqlite3, croner for jobs.
- Keep the deterministic core deterministic. AI assists ordering and tagging only,
  and every AI path needs a deterministic fallback when Ollama is unavailable.
- Schema changes go through a new forward-only migration (current head is 0048).
- No regression to the no-overlap guarantee in the Auto engine, or to existing
  Vitest suites. Add a test for each item below.
- Respect owner scoping (`currentOwnerId()`), and broadcast SSE events for any
  state the client mirrors so open clients stay in sync.

---

## 1. Add a button in the Tasks view to auto-tag tasks

What: a button in the Tasks view that semantically tags tasks that have no tags,
using the existing suggestion path.

Where:
- Client: `client/src/views/AllTasks.tsx` for the button and the call.
- Reuse the existing suggestion logic in `server/src/agents/tags.ts`
  (`suggestTags`, constrained to the user's existing tag vocabulary) and the tag
  apply path used by the task form.
- Tag application writes to `entity_tags` for the task.

Acceptance:
- A visible button in the Tasks view tags untagged tasks with best-guess tags from
  the user's existing vocabulary.
- Tagging is additive and reversible, it never removes a user's tags.
- With Ollama down, the button degrades gracefully (deterministic heuristic or a
  clear "tagging unavailable" toast), it never throws.
- Decide and state in the PR whether the button tags all untagged tasks or only a
  selected subset, default to all untagged in the current filter view.

Notes: `suggestTags` already refuses to invent tags outside the vocabulary, lean
on that to keep results clean.

---

## 2. Add a cron job that semantically tags tasks as they arrive

What: a scheduled job that finds recently created, untagged tasks and applies
semantic tags, so tagging happens automatically without the button in item 1.

Where:
- Register a new job kind (for example `tag_tasks`) in the job registry and the
  `scheduled_jobs` seed, executed in `server/src/jobs/index.ts` alongside
  `promote_possibles`, `nightly_grooming`, and the others.
- Reuse the same tagging logic as item 1 so the button and the cron share one code
  path.

Acceptance:
- The job tags untagged tasks created since its last run, on a sensible cadence
  (state the cron expression chosen).
- Idempotent, re-running does not duplicate tags or thrash existing ones.
- Visible and manually runnable from the Jobs view like every other job.
- Deterministic fallback when Ollama is unavailable, logged, never crashes the
  job runner.

Notes: this and item 1 are the same operation triggered two ways. Build the
shared service first, then wire the button and the job to it.

---

## 3. The task edit menu must always render on the top layer

What: the task edit menu (`ElementWizard`) must render above all other elements,
on the highest layer, so nothing in the Planner or cockpit overlaps it.

Where:
- `client/src/components/ElementWizard.tsx`, the modal overlay and panel.
- Audit competing stacking contexts in `client/src/components/Planner.tsx`,
  `CalendarGrid.tsx`, and the nav components, which currently use elevated
  z-index values.

Acceptance:
- The edit menu always sits above the Planner grid, pattern overlays, nav, and
  toasts, on every view and at mobile widths.
- Its internal popovers (for example the tag suggestion dropdown, already at
  z-50) still render above the panel itself.
- No element can paint over the open edit menu.

Notes: prefer a single, documented z-index scale over ad hoc values, so this does
not regress later. The wizard is a `fixed` overlay already, the fix is ordering
and stacking context, not layout.

---

## 4. Change the start-task day to a calendar-icon date picker

What: replace the start-day quick picks in the task editor with a calendar-icon
control that opens a date picker.

Where:
- `client/src/components/ElementWizard.tsx`. The start day is the `scheduledFor`
  signal, currently set by the `startPicks` quick buttons (Today, +1 day,
  +1 week) near the task fields.

Acceptance:
- A calendar icon opens a date picker for the start day, replacing the three quick
  buttons.
- The chosen date binds to `scheduledFor` exactly as the buttons did, with no
  change to what gets submitted to the API.
- Sensible default (today) and clearable if start day is optional.
- Keyboard and screen-reader accessible.

Notes: the editor already uses native `type="date"` inputs elsewhere (goal day,
due date, defer), so match that pattern behind the icon for consistency.

---

## 5. Remove scheduled tasks from the flight plan, but only the user closes them

What: when a task is placed on the calendar, remove it from the flight plan, but
do not mark it done. Closing stays a user action. Any task still open at end of
day reappears in the flight plan the next day.

Where:
- Placement: `server/src/engine/autoplan.ts` (`placeIntoWindow` /
  `placeFlightPlan`), remove a task from `flight_plan` once it gets a placed block.
- Daily re-stage: `server/src/engine/review.ts`, run by the `review_day` cron
  (01:00). Extend it to re-add still-open, no-longer-scheduled tasks to the flight
  plan for the new day.
- Flight plan store and rows: `server/src/routes/flight-plan.ts`.

Acceptance:
- Placing a staged task removes it from the flight plan and leaves the task open
  (status unchanged).
- The task remains closable only by the user, placement never closes it.
- A task that is open and not on a current block at day end reappears in the next
  day's flight plan, exactly once, no duplicates.
- Completed or cancelled tasks do not reappear.

Notes: decide the precise re-stage rule (open and unscheduled, versus open with a
missed block) and state it. Reuse the existing missed-task handling in
`review.ts` rather than adding a parallel path. Broadcast a flight-plan update so
clients refresh.

---

## 6. Non-habit recurring tasks show once in the flight plan, with a multi-event icon

What: do not flood the flight plan with every instance of a non-habit recurring
task. Show a single instance, marked with a small icon indicating it repeats, the
same treatment habits already get.

Where:
- Candidate filter: `server/src/engine/autoplan.ts`, `fillFlightPlanCandidates`
  already excludes `subtype = 'habit'`. Extend the rule so recurring non-habit
  tasks (those with `recurrence_rule` set, or instances with
  `recurrence_parent_id`) collapse to one representative entry rather than many.
- Recurrence fields live on `tasks`: `recurrence_rule`, `recurrence_parent_id`,
  `recurrence_dtstart` (see `server/src/db/schema.ts`).
- Icon: `client/src/components/FlightPlan.tsx` for the repeat indicator, following
  the habit icon pattern (see `ShapeIcon.tsx`).

Acceptance:
- A non-habit recurring task appears at most once in the flight plan, not one row
  per occurrence.
- That single row carries a small icon signaling it is a recurring series,
  visually consistent with how habits are marked.
- Promoting or scheduling the shown instance behaves correctly and does not strand
  the rest of the series.
- One-off (non-recurring) tasks are unaffected.

Notes: confirm whether the representative entry should be the next due occurrence
or the series template, and state the choice. Keep the existing habit exclusion
intact.

---

## Suggested order

Do the shared tagging service first (items 2 then 1, since the cron and button
share it). Then the self-contained UI fixes (3, 4). Then the flight-plan behavior
changes (6, then 5), since both touch `autoplan.ts` and the flight plan and are
easier to reason about together. Each lands with its own test.
