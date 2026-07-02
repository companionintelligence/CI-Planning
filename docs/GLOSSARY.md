# Companion Planning — Canonical Vocabulary (GLOSSARY)

> **Status:** canonical, 2026-07-01 (updated: ratify `kind='pattern'`; tag-axis rename 0043; Phase N adds Objective — noun budget raised to 9; Phase O renames the Today "Goals" card → **FOCUS** with source-linked focus (0088), adds a one-per-day note reusing the same `reflections` table with no new migration, and adds a derived five-star day score cached in `day_stars` + a nightly freeze job (0089/0090); Phase O also retires the standalone Morning Briefing section. Phase P adds a `recurrence_horizon_days` Setting and a "Clear Date Range" Settings tool; Objectives joined the multi-device sync layer (0087). Phase T makes multi-tenant real (`owner_id` scoping across time_blocks/tags/sync_events, 0098–0100) and ratifies **owner ≡ user** (decision #1); Phase U adds auth-identity columns to `owners` (U0 / 0101). **None of Phase O/P/T/U adds a noun** — owner is an internal model concept, budget stays 9). The single source of truth for user-facing
> nouns. Companion to [ROADMAP.md](ROADMAP.md) (consolidation history in [archive/consolidation-plan.md](archive/consolidation-plan.md)). Every label
> in the UI and every entity in the data model must map to a term here.

## Why this exists

The app accreted ~25 user-facing concepts (Plan, Concept, Container, Template,
Plan-Block, Pattern, Habit, Ritual, Fast Task, Possible Task, …). Most are not
distinct *things* — they are *states*, *subtypes*, *kinds*, or *filters* of a
much smaller set. This glossary fixes the canon at **9 nouns** and demotes everything else.
*(Phase N raised the original cap from 8 to 9 to accommodate the Objective hierarchy — a genuinely distinct entity with its own view, lifecycle, and progression mechanics.)*

## The noun budget (governance)

1. **At most 9 top-level nouns.** Introducing a new one **requires retiring one** or a deliberate budget amendment.
2. **Every UI label maps to a glossary term** (a noun, or a listed state/subtype/
   kind/filter). A label that isn't here is a bug.
3. **The data model maps 1:1 to the glossary.** Internal table names may differ
   (e.g. `patterns`), but must declare their user-facing noun (“Routine”).

## The nouns

**Entities** (have rows):

| # | Noun | Definition | Absorbs (→ state / subtype / filter) |
|---|------|------------|--------------------------------------|
| 1 | **Task** | The atom of work. | Open · TBD · Scheduled · Deferred · Done · Missed · Past *(states)*; Standard · Habit · Quick *(subtypes)*; Subtask *(has parent)* |
| 2 | **Time Block** | A named, tagged span of time. | Scheduled (was *Plan*) · Someday (was *Concept*) · Saved (was *Plan-Block/Template*) *(states)*; task · meeting · focus · break · buffer · container *(kinds, hidden)* |
| 3 | **Routine** | A reusable bundle of tasks. (internal: `patterns`) | Ritual *(flavor, flagged off)*; surfaces Habit-subtype tasks |
| 4 | **Tag** | A cross-cutting label. | Concept-Tag (= tag + default duration); top-level / second-level *(levels)* |
| 9 | **Objective** | A hierarchical life goal — *Goal* › *Project* › *Objective* (the task-bearing leaf). (internal: `objectives` + `objective_tasks`) | Level is server-derived from tree **height** (a leaf that holds tasks = *Objective*; a node of Objectives = *Project*; a node of Projects = *Goal*). Tasks link only to leaf Objectives; a task that gains a subtask is auto-promoted into its own leaf Objective. Progress is `NULL` when no tasks/children — a rot signal. |

**Surfaces** (places you work):

| # | Noun | Definition |
|---|------|------------|
| 5 | **Inbox** | Capture / triage queue. (internal: `possible_tasks`; promoting one creates a Task) |
| 6 | **Flight-plan** | The day’s staging tray — what Auto runs over. |
| 7 | **Planner** | The single-day, date-navigable cockpit board where Time Blocks live. The multi-day day/week/month view over the same Time Blocks is the **Calendar** (`/calendar`). |
| 8 | **Pattern-block** | A named availability window tying a pattern-tag to a time range on a given day type. Constrains auto-placement and shades the Planner. | Workday (Mon–Fri) · Weekend (Sat–Sun) *(day types)* |

## States, subtypes & kinds (demoted — not nouns)

- **Owner ≡ User (multi-tenant):** **not a user-facing noun** — the internal `owners`
  table **is** the user/account table (Phase T decision #1: 1:1, tenant = user). Each
  person who signs in owns exactly one isolated workspace; every owner-scoped table's
  `owner_id` references `owners(id)`. Phase U adds the auth-identity columns directly to
  `owners` — `external_subject` (OIDC/CI-Portal token `sub`, U1), `username` +
  `password_hash` (local login, U2) — so there is **no separate `users` table**. All
  three are nullable; which are set implies the auth mode. The `SYSTEM_OWNER` sentinel
  is the single owner in dev/test/standalone mode and is auth-inert (all three NULL).
- **Connection / Integration (e.g. a connected Google account):** **not a noun** — it is a
  **Setting** (managed under Settings → MCP connections). Connecting Google adds no new
  glossary entity; its data surfaces as existing nouns (calendar events → **Time Block**
  *meeting* mirrors; extracted action items → **Inbox** items).
- **Today Focus / Weekly Goals (the FOCUS card):** **not nouns** — named focus slots in the
  Today cockpit's **FOCUS** card (renamed from "Goals") and the Weekly Review surface
  (internal: `reflections` table, `kind` = `today_goal` / `weekly_goal`). Each slot may
  **link** to a Task (today) or an Objective (weekly) via `source_kind`/`source_ref`, or hold
  freeform text (`source_kind='manual'`) — a reference, not ownership; completing a linked task
  auto-checks its focus. They are a feature of the Today cockpit / **Planner** surface, not
  a standalone entity with its own CRUD lifecycle.
- **Day note:** **not a noun** — one free-text note per day, reusing the same `reflections`
  table as the FOCUS card (a dedicated `kind='day_note'`; the composite primary key enforces
  the one-per-day rule, no application logic required). A header affordance and a calendar
  dot surface it; it is not a journal/notes entity with its own CRUD lifecycle.
- **Five-star day (the day-stars tally / calendar heatmap):** **not a noun** — a derived
  score, never a manual toggle, computed from existing Task/Habit/reflection state
  (internal: `computeStars()`, frozen into `daily_recap`). Today computes live; a nightly job
  freezes each day's score permanently once it ends. Visually distinct from the Objective
  deep-link star on task cards (`EightPointStar`, 8-pointed, accent color) — the day-stars
  are 5-pointed and gold, and only ever appear as the header tally or the calendar heatmap,
  never on a task card.
- **Pattern-block day types:** `workday` (Mon–Fri) · `weekend` (Sat–Sun). Each pattern-tag has
  0–N time ranges per day type. Pattern-tag-less tasks fall back to the general `workday_start`/
  `workday_end` window from scheduling\_prefs.

- **Task states:** `open` · `TBD` (title + ≥1 tag, nothing else) · `scheduled` ·
  `deferred` · `done` · `missed` · `past` (the shelf).
- **Task subtypes** — `tasks.subtype`, **mutually exclusive**, default `standard`:
  `standard` · `habit` (recurring) · `quick` (lightweight). Replaces the old
  `is_habit` / `is_fast_task` booleans.
- **Task relation:** subtask = a Task with a `parent_id`.
- **Time Block states:** `scheduled` (has a clock time) · `someday` (goal day only)
  · `saved` (a reusable template).
- **Time Block kinds** (hidden by default): task · meeting · focus · break · buffer
  · container.
- **Routine flavors:** routine · ritual (flagged off via `enable_rituals`).
  **Habit is a Task subtype** surfaced in the Routines menu — *not* a Routine
  flavor or a “pattern type”.
- **Tag levels (per-entity, dilution):** top-level (full match weight,
  dilution-immune) · second-level (diluted: weight = `1 / #tags`). This is a weight on
  a tag *as applied to an entity*.
- **Tag taxonomy (per-tag, `tags.kind` — a separate axis from the levels above):**
  **pattern-tag** (top-level category — brand-set **Home / Work / Community**,
  `is_base` & undeletable, plus user-added; canonical DB value: `tags.kind = 'pattern'`) ·
  **intention** (every other tag, grouped under one or more pattern-tags via the
  `tag_patterns` junction table; ungrouped = *Unsorted*). A tag may be **muted**
  (a per-tag state, not a noun). Pattern-tags/intentions are Tag sub-levels,
  **not** new nouns.

  > **Naming note:** the `tag_patterns` junction table and `tags.kind = 'pattern'`
  > refer to this tag-taxonomy axis. The separate `patterns` table is the Routine collection
  > system (Habit / Routine / Ritual templates). The §3b Routine rename (`patterns` → `routines`)
  > that would have de-collided these is **deferred** — the as-built `patterns` naming is
  > ratified for now (README marks `pattern_types` load-bearing). Until/unless §3b is revived,
  > use the table name and the `kind` value as the disambiguator: `patterns`/`pattern_types`/
  > `pattern_tasks` = the Routine collection system; `tags.kind='pattern'` + `pattern_blocks`/
  > `tag_prefs`/`tag_patterns` = the tag-category axis.

## Translation (old term → canonical)

| Old | Canonical |
|-----|-----------|
| Plan | Time Block · *scheduled* |
| Concept | Time Block · *someday* |
| Plan-Block / Template | Time Block · *saved* |
| Container | Time Block · kind *container* |
| Pattern | Routine |
| Habit (pattern type) | Task subtype `habit` (shown in Routines) |
| Ritual | Routine flavor (flagged off) |
| Fast Task | Task subtype `quick` |
| Possible Task | Inbox item |
| Open Tasks | Task · *open* state |
| Subtask | Task with a parent |
| Concept-Tag | Tag (with a default duration) |
