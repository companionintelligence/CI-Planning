# Companion Planning — Canonical Vocabulary (GLOSSARY)

> **Status:** canonical, 2026-06-20. The single source of truth for user-facing
> nouns. Companion to [consolidation-plan.md](consolidation-plan.md). Every label
> in the UI and every entity in the data model must map to a term here.

## Why this exists

The app accreted ~25 user-facing concepts (Plan, Concept, Container, Template,
Plan-Block, Pattern, Habit, Ritual, Fast Task, Possible Task, …). Most are not
distinct *things* — they are *states*, *subtypes*, *kinds*, or *filters* of a
much smaller set. This glossary fixes the canon at **8 nouns (7 in use, 1
reserved)** and demotes everything else.

## The noun budget (governance)

1. **At most 8 top-level nouns.** Introducing a new one **requires retiring one**.
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

**Surfaces** (places you work):

| # | Noun | Definition |
|---|------|------------|
| 5 | **Inbox** | Capture / triage queue. (internal: `possible_tasks`; promoting one creates a Task) |
| 6 | **Flight-plan** | The day’s staging tray — what Auto runs over. |
| 7 | **Planner** | The date-navigable board where Time Blocks live. (absorbs the old `/calendar` view once day-nav lands) |
| 8 | **Pattern-block** | A named availability window tying a direction tag to a time range on a given day type. Constrains auto-placement and shades the Planner. | Workday (Mon–Fri) · Weekend (Sat–Sun) *(day types)* |

## States, subtypes & kinds (demoted — not nouns)

- **Pattern-block day types:** `workday` (Mon–Fri) · `weekend` (Sat–Sun). Each direction tag has
  0–N time ranges per day type. Direction-less tasks fall back to the general `workday_start`/
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
  **direction** (top-level category — brand-set **Home / Work / Community**,
  `is_base` & undeletable, plus user-added) · **intention** (every other tag, grouped
  under one or more directions via `tag_directions`; ungrouped = *Unsorted*). A tag may
  be **muted** (a per-tag state, not a noun). Directions/intentions are Tag sub-levels,
  **not** new nouns.

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
| Calendar (view) | Planner (date-navigable) |
