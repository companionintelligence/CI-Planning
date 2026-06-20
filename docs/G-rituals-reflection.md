# G — Time-Blocking, Patterns & the TODAY cockpit (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). **Supersedes the old "Rituals & reflection"
G.** UX source of truth: [design-today-cockpit.md](design-today-cockpit.md).
Depends on **B0** (owner scoping), **C** (task semantics), **E** (task-level
recurrence) and **F** (the calendar grid this phase turns into the PLANNER). It
**reframes A's scheduler** and pulls scoped revisions into **E** and **F** (their
`E'` / `F'` tickets live in [E-recurring-habits.md](E-recurring-habits.md) and
[F-calendar-grid.md](F-calendar-grid.md)).

## Goal
Turn TODAY into a planner cockpit built on three primitives — **Time-Blocks**
(tagged containers), **Patterns** (typed task collections: Routine ▢ / Habit ◯ /
Ritual △), and the **Flight-plan** (a staging area) — driven by a **manual-or-Auto,
flight-plan-centric** model. Auto only ever schedules staged items, governed by the
rules of a Time-Block or Pattern.

## Non-goals (V1 — explicitly deferred)
- **Pattern timing intelligence.** "Check groceries *before work*" relative
  anchors, proximity ranking, and learned/past-pattern ordering are a **later
  ticket** (G-INT). V1 Auto is structural: tag-filter + free-gap packing.
- **Pattern nesting.** V1 patterns contain **tasks only**; shared tasks link related
  patterns. Pattern-in-pattern nesting is deferred to `G-INT`.
- **Reminder *delivery*.** G stores per-pattern-type reminder *config*; firing
  reminders is **Phase H**.
- **Reflection / weekly-review screens.** Dropped from this phase (was in old G);
  reconsider after the cockpit lands.

*(Decided in V1, not deferred: the flight-plan is **persisted owner-scoped until
reset** (with a Reset button); Time-Block **reuse** via `block_templates`; Auto
**replaces** the nightly auto-pack job.)*

## The model (what changes)
- **`planning_mode` (`auto | ritual`) is retired.** "Ritual" becomes a Pattern
  *type*. Scheduling = **manual drag** or **Auto over the flight-plan**.
- **A's scheduler is reframed** as the Auto engine invoked on flight-plan items
  with Time-Block / Pattern rules — it no longer packs the whole open backlog.
- **Overlaps are allowed but flagged** (relaxes A/F's no-overlap invariant).
- **Patterns are collections only** — no own recurrence; repetition is E's
  task-level RRULE on member tasks.

## Data model (new tables + extensions; all owner-scoped, via the B0 runner)
```sql
-- Extensible pattern types (Routine ▢ / Habit ◯ / Ritual △ + user-defined).
CREATE TABLE pattern_types (
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id),
  name TEXT NOT NULL, icon_shape TEXT NOT NULL,        -- square | circle | triangle | <custom>
  reminder_config TEXT,                                -- JSON: per-type reminder defaults (Phase H reads)
  is_builtin INTEGER DEFAULT 0
);
-- A pattern = a typed, reusable collection of tasks (no own recurrence).
CREATE TABLE patterns (
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id),
  type_id INTEGER REFERENCES pattern_types(id),
  name TEXT NOT NULL, tag TEXT, notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Membership is many-to-many; a task can be in several patterns. position orders it.
CREATE TABLE pattern_tasks (
  pattern_id INTEGER REFERENCES patterns(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  PRIMARY KEY (pattern_id, task_id)
);
-- Reusable Time-Block templates (named, tagged containers).
CREATE TABLE block_templates (
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id),
  name TEXT NOT NULL, tag TEXT, default_minutes INTEGER
);
-- time_blocks gains a container variant + a tag (the outline drawn in the PLANNER).
ALTER TABLE time_blocks ADD COLUMN tag TEXT;            -- container/grouping tag
-- block_kind already enumerates kinds; add 'timeblock' (the container) at the app layer.

-- Flight-plan: the persisted, owner-scoped staging area. Survives reloads/devices;
-- cleared by the Reset button. Holds tasks (members of staged patterns land here as
-- individual rows, tagged with their source pattern). `selected` drives the Auto pass.
CREATE TABLE flight_plan (
  owner_id INTEGER REFERENCES owners(id),
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  source_pattern_id INTEGER REFERENCES patterns(id) ON DELETE SET NULL, -- null = added directly
  selected INTEGER DEFAULT 1,
  position INTEGER DEFAULT 0,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, task_id)
);
```
- `tasks.is_habit` is **migrated away** by `E'` (see E spec): existing habits become
  members of a habit-type pattern; the column is dropped/ignored after backfill.
- **Textures are derived, not stored:** a deterministic `textureSeed(tag)` (hash of
  the tag name) + the type's `icon_shape` fully determine the look.

---

## Tickets

> Convention: every ticket carries **Goal · Acceptance · Tests · State**. State is
> one of `not-started | in-progress | blocked | done`. All schema lands as numbered
> B0 migrations; the standing Vitest + container suites stay green each ticket.

### G1 — Pattern model + types (server)
- **Goal.** `pattern_types`, `patterns`, `pattern_tasks` tables + seeded built-in
  types (Routine ▢, Habit ◯, Ritual △). REST: `GET/POST/PATCH/DELETE /api/patterns`,
  `GET/POST/PATCH/DELETE /api/pattern-types`, and pattern↔task membership endpoints.
- **Acceptance.** Create a pattern of any type with N member tasks; a task can
  belong to ≥2 patterns; deleting a pattern leaves its tasks intact; a user-defined
  type with a custom `icon_shape` is creatable and usable; all owner-scoped.
- **Tests.** CRUD + membership round-trip; many-to-many (task in 2 patterns);
  cascade on pattern delete leaves tasks; owner isolation; invalid type → 422.
- **State.** not-started.

### G2 — Habit → Pattern migration (bridges E′)
- **Goal.** Migrate every `is_habit` template into a **habit-type pattern** whose
  member task is the (still-recurring) task; preserve streak/skip/complete behaviour
  by keying it off habit-type patterns; drop reliance on `tasks.is_habit`.
- **Acceptance.** After migration, every former habit shows as a habit-type pattern;
  recurrence (RRULE, generation job) and streaks/skips behave exactly as before
  (E's tests stay green); no orphaned habits.
- **Tests.** Migration on a copy of a 0.x DB maps each habit → one habit pattern,
  idempotent; E's `generate.test.ts` + `recurrence-ops.test.ts` pass unchanged
  against the pattern-backed habit; streak counts identical pre/post.
- **State.** not-started. *(Detailed as `E′-1`/`E′-2` in the E spec.)*

### G3 — Time-Block containers (server + reuse)
- **Goal.** A Time-Block: a named, tagged container over a time range, plus reusable
  `block_templates`. API to create a container block (default name = tag, renameable,
  save standalone or under the tag) and to list/instantiate templates.
- **Acceptance.** Create a container block tagged `errands`; rename + save as a
  reusable template; re-instantiate it on another day; the container persists its
  tag and range; container blocks never count as schedulable tasks.
- **Tests.** Container create/rename/save-template/instantiate round-trip;
  template reuse produces an independent block; owner-scoped; container excluded
  from the today-set.
- **State.** not-started.

### G4 — Flight-plan + the Auto reframe (the A′ reframe)
- **Goal.** A **persisted, owner-scoped** flight-plan (`flight_plan` table; survives
  reloads/devices; a **Reset** button clears it) + the **two-step Auto**: (1) empty
  flight-plan → Auto proposes candidates into it; (2) staged selection → Auto
  **places** them via Time-Block tag-filter or Pattern rules (free-gap packing, V1).
  Staging a Pattern adds its **member tasks** to the flight-plan (tagged with the
  source pattern). Manual drag from flight-plan onto the PLANNER. The old nightly
  `auto_schedule` "pack the whole backlog" job is **retired** — Auto only ever
  touches the flight-plan (it may at most *propose* candidates into it).
  REST: `GET /api/flight-plan`, `POST /api/flight-plan` (add task / add pattern's
  tasks), `PATCH` (toggle `selected`/`position`), `DELETE /api/flight-plan/:taskId`,
  `POST /api/flight-plan/reset`, plus the Auto endpoints.
- **Acceptance.** Flight-plan persists across reloads + is owner-scoped; Reset
  empties it; staging a pattern adds its tasks; Auto on an empty flight-plan adds
  candidates and schedules **nothing**; Auto on a tag-filtered Time-Block places only
  matching **selected** staged items inside the block window; manual drag persists
  one tz-correct PATCH; nothing outside the flight-plan is auto-placed; the nightly
  auto-pack no longer runs.
- **Tests.** Flight-plan CRUD + persistence + reset + owner isolation; pattern-stage
  expands to member tasks; step-1 fills flight-plan / creates 0 blocks; step-2 places
  selected staged items into the block window respecting its tag; non-staged tasks
  never auto-placed; placement invariants (no lost minutes, tz-correct) hold;
  property test over random staged sets; the retired `auto_schedule` job is gone /
  no-ops (update A's tests).
- **State.** not-started. *(Revises the Phase-A `auto_schedule` contract — A's
  scheduler tests are reworked here.)*

### G5 — TODAY cockpit layout (client)
- **Goal.** Rebuild `Today.tsx`: **Day Overview** (day/date + today's tag set),
  **Summary** (overdue/blocked/open counts **+ the moved `+ New Task` button**),
  the **PLANNER** (renamed from "Next Up"), the **Flight-plan** container (where Open
  Tasks was, **with `Auto Schedule` at its top**), and the **lower drawer**
  (`[+ Block] [+ Pattern] [+ Open Task]`) that floats on top and never closes.
- **Acceptance.** All four regions render on the CI-Hub tokens; `+ New Task` lives in
  the Summary; `Auto Schedule` lives atop the flight-plan; the drawer expands/
  contracts but cannot be dismissed and overlays other UI; responsive (mobile sheet
  behaviour from F/responsive shell).
- **Tests.** Component tests: button placement, drawer open/expand/contract (no
  close), region presence; visual-regression via `capture-listing`.
- **State.** not-started.

### G6 — PLANNER view (bridges F′)
- **Goal.** The hour-by-hour PLANNER: 8h visible / expand to 24h, **next-up pinned
  to the 2nd slot** + auto-scroll, items show **name · tag · start–end**, Time-Block
  **outlines**, pattern **textures**, **drag-to-reorder**, **overlap allowed +
  flagged**.
- **Acceptance.** Default 8h window; expand shows 24h/24 items; next-up sits row-2
  and stays there on scroll; reordering persists; two items can share a slot and a
  conflict marker appears; outlines/textures render; no tz drift.
- **Tests.** next-up pin position; expand/collapse; drag-reorder emits correct
  PATCH; overlap detection flags (not prevents); tz-correct placement (reuse F's
  grid tests). *(Detailed as `F′-1..4` in the F spec.)*
- **State.** not-started.

### G7 — Pattern types & reminders in Settings (client + server config)
- **Goal.** Settings UI to **add a pattern type / change its icon shape** and edit
  each type's **reminder config**. Persist to `pattern_types.reminder_config`.
- **Acceptance.** A new type with a chosen icon appears everywhere patterns are
  picked; per-type reminder config saves and round-trips; built-in types editable
  but not deletable.
- **Tests.** Type CRUD via Settings; reminder-config round-trip; built-in delete
  rejected (400); icon-shape change reflected in pattern rendering.
- **State.** not-started. *(Reminder **firing** is Phase H; this only stores config.)*

### G8 — Pattern textures (client)
- **Goal.** A deterministic, dependency-light texture generator: `icon_shape` →
  motif (squares/circles/triangles), `textureSeed(tag)` → the per-tag variation;
  rendered as a ≤8%-contrast background behind pattern items.
- **Acceptance.** Same tag → identical texture across renders/sessions; different
  tags → visibly different; texture shape always matches the pattern type; contrast
  stays subtle in both light and dark.
- **Tests.** `textureSeed` deterministic + well-distributed (unit); shape↔type
  mapping; snapshot of a few tag/type pairs.
- **State.** not-started.

### G-INT — Pattern timing intelligence (**deferred** — own follow-on)
- **Goal.** Relative anchors ("before the first work block"), proximity/type
  ranking for Time-Block auto-fill, and learned ordering from past patterns.
- **Acceptance / Tests / State.** **deferred** — specced when V1 lands and there's
  history (E actuals/streaks) to learn from.

---

## Acceptance criteria (phase-level)
1. TODAY renders the cockpit (Day Overview · Summary+NewTask · PLANNER · Flight-plan ·
   never-closing drawer) on the CI-Hub design system.
2. Time-Blocks (tagged outline containers, reusable) and Patterns (typed, textured,
   many-to-many task collections) exist end-to-end with owner-scoped APIs.
3. Scheduling is **manual-or-Auto, flight-plan-only**; Auto's two-step flow works;
   nothing outside the flight-plan is auto-placed.
4. The PLANNER shows 8h/expand-24, next-up pinned row-2, drag-reorder, and
   **overlap-allowed-but-flagged**.
5. Former habits are **patterns** with recurrence/streaks intact (E migration green).
6. `planning_mode` retired; "ritual" is a pattern type. Standing suites green.

## Cross-cutting
- **Tests.** Server Vitest + container Playwright green each ticket; new
  client-component tests for the cockpit + drawer; a scheduler **property test** for
  the flight-plan placement pass (no lost minutes, deterministic, tz-correct,
  overlap-flagged-not-prevented); the idempotent-migration check covers the new
  tables + the habit→pattern backfill.
- **Scale budget.** `pattern_tasks` and the texture seed are cheap; index
  `patterns(owner_id, type_id)` and `pattern_tasks(task_id)`; the Auto pass is
  bounded by the flight-plan size (small), not the backlog.
- **Risks.** (a) The A-scheduler reframe changes the `auto_schedule` contract —
  guard with the property test and update A's tests. (b) Overlap-allowed weakens an
  invariant several F tests assert — relax those deliberately in `F′-3`. (c) Habit
  migration must be lossless — the E suites are the gate.

## Suggested PR breakdown
G1 (pattern model) → G2/E′ (habit→pattern) → G3 (time-blocks) → G4/A′ (flight-plan +
Auto) → G6/F′ (PLANNER) → G5 (cockpit layout) → G8 (textures) → G7 (type/reminder
settings). G-INT follows once V1 is in daily use.
