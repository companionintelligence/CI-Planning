# Design — the TODAY cockpit, Time-Blocks & Patterns

> **Status:** design canonical, 2026-06-20. This is the UX source of truth for
> **Phase G** ([archive/G-rituals-reflection.md](archive/G-rituals-reflection.md)) and the
> revisions it pulls into **E** (habits → patterns) and **F** (calendar →
> PLANNER). Built on the CI-Hub design system (see
> [design-brief-recurrence-settings.md](archive/design-brief-recurrence-settings.md)) —
> semantic tokens + primitives, global styles first.

## 1. The planning model (the big shift)

Scheduling is no longer an `auto` vs `ritual` mode toggle. There are two ways a
task lands on the day, and a staging area between them:

- **Manual** — drag a task onto the PLANNER, either directly or out of the
  flight-plan.
- **Auto** — operates **only on the flight-plan**, in two steps:
  1. Auto with an **empty/unselected** flight-plan → **fills the flight-plan**
     with candidate items.
  2. Auto with **selected** flight-plan items → **places them** on the day per the
     rules of the relevant **Time-Block** (tag filter) or **Pattern** (collection
     rules). V1 placement is structural (tag filter + free-gap packing); the
     proximity / relative-timing / learned-ordering intelligence is **deferred**.

Consequences:
- The legacy `planning_mode` (`auto | ritual`) toggle is **retired**. "Ritual"
  becomes a **Pattern type**, not a planning mode.
- Phase A's deterministic scheduler is **reframed** as the engine Auto runs over
  the flight-plan — it no longer auto-packs the entire open backlog.
- Manual drag/resize is **collision-clamped**: a block stops at a neighbour's edge
  rather than overlapping it (a whole Plan group clamps by its outer edge). It never
  *increases* a pre-existing overlap; any **residual** overlap from earlier data still
  shows a conflict marker. (The standalone Calendar view keeps overlap allowed-but-flagged.)

## 2. TODAY cockpit layout

```
┌──────────────────────────────┬──────────────────────────────┐
│ DAY OVERVIEW                  │ SUMMARY            [+ New Task]│
│ Friday · Jun 20               │  ⚠ 2 overdue                  │
│ #work #family #errands        │  ⛔ 1 blocked   ▢ 5 open      │
├──────────────────────────────┴──────────────────────────────┤
│ PLANNER  (8h visible · expand ⌄ to 24h)        [filters]     │
│  08:00  ┌ errands ───────────────────────┐  (time-block      │
│  09:00  │  ◯ Meditate        09:30–09:45 │   outline)         │
│ ▶09:30  └────────────────────────────────┘  ◀ next-up pinned │
│  10:00     Write update      10:00–11:00      to 2nd slot     │
│  …                                                            │
├──────────────────────────────────────────────────────────────┤
│ FLIGHT-PLAN                            [⚡ Auto Schedule]     │
│  ☑ Review PRs   ☐ Grocery shopping  ☐ ◯ Stretch              │
├──────────────────────────────────────────────────────────────┤
│ ▲ drawer (never closes)   [+ Block] [+ Pattern] [+ Open Task]│
└──────────────────────────────────────────────────────────────┘
```

- **Top-left — Day Overview:** day + date; below it, the **tag set** of everything
  scheduled today (`#work #family …`), so the shape of the day reads at a glance.
- **Top-right — Summary:** **overdue / blocked / open** counts with quantities.
  The **+ New Task** button moves here.
- **PLANNER** (renamed from "Next Up"): the hour-by-hour day, **8 hours visible**,
  **expandable to 24h / 24 items**, with **"next up" pinned to the 2nd slot from
  the top** and auto-scrolled there. Executive-assistant clarity: every item shows
  **name · tag · start–end**.
- **Flight-plan** (replaces the old "Open Tasks" slot): the staging area. The
  **Auto Schedule** button sits at its **top**.
- **Lower drawer:** `[+ Block] [+ Pattern] [+ Open Task]`. It **floats above all
  other UI**, **expands/contracts but never closes**.

## 3. The three primitives

### Time-Block — `[+ Block]`
A named, **tagged container** drawn as an **outline** over a time range in the
PLANNER. It groups tasks that belong together.
- Default **name = tag**; the user can rename it and choose to **save it as a
  sub-item of the parent tag** or **standalone** for later reuse (a reusable
  block template).
- Selecting a block (e.g. tag `errands`) and hitting **Auto** filters **open items
  tagged `errands`** into the block's window. V1 picks by tag + fit; proximity /
  type ranking is deferred.

### Pattern — `[+ Pattern]`
A **typed, reusable collection of tasks** — *not* necessarily sequential.
Patterns do **not** own recurrence; repetition comes from **E's task-level
recurrence** on their member tasks (or by re-adding the pattern).
- **Types** (extensible): **Routine ▢ · Habit ◯ · Ritual △**, plus user-defined
  types. The user can **add a new type or change a type's icon shape**. Each type
  carries its **own reminder settings** (configured in Settings).
- **Membership is many-to-many:** a task can belong to several patterns (e.g.
  "Grocery shopping" is in both the `errands` collection and the "Family dinner"
  ritual).
- **Rendering:** patterns appear as ordinary tagged tasks, marked with a subtle
  **background texture** — the **shape encodes the type** (squares / circles /
  triangles), and the **variation is deterministic per tag** (seeded by the tag
  name, so a tag always looks the same).
- The `[+ Pattern]` action lets the user **search an existing pattern** or **create
  a new one**, then **tap items to add them to the flight-plan** (toggle-select
  any number).

### Open Task — `[+ Open Task]`
The open backlog, surfaced in the drawer. **Tap to add to the flight-plan**, then
place by **manual drag**, by **Auto with a time-block tag filter**, or by
**pattern preference**.

## 4. Pattern types, icons & textures

| Type | Icon shape | Texture motif | Reminder defaults |
|---|---|---|---|
| Routine | ▢ square | squares | (per-type, set in Settings) |
| Habit | ◯ circle | circles | streak-aware nudges |
| Ritual | △ triangle | triangles | ritual reminders |
| *user-defined* | user-chosen | matches shape | per-type |

- The texture **shape** is fixed by the type; the **specific pattern/cell** of the
  texture is a deterministic function of the **tag name** (hash → seed), so it is
  *unique per tag* but stable across renders and sessions. No per-tag texture is
  stored — it is derived.
- Pattern types live in data (`pattern_types`), not a hard-coded enum, so adding a
  type or changing an icon is a Settings action.

## 5. The Auto flow (two-step, flight-plan-centric)

1. **Auto with nothing staged** → Auto proposes candidates and drops them into the
   flight-plan (it does **not** touch the day yet). The user reviews/toggles.
2. **Auto with staged items selected** → Auto **schedules** them:
   - inside a selected **Time-Block**, filtered to the block's **tag**;
   - or per a **Pattern's** rules (its member tasks, kept same-day; ordering /
     "before work" anchors are a later ticket);
   - else into free gaps around fixed/locked items.
3. Manual always available: drag any flight-plan or backlog item straight onto the
   PLANNER.

## 6. PLANNER interaction

- **Viewport:** 8 hours tall by default; a control expands to the full 24h (or a
  24-item list). "Next up" is always pinned to the **2nd row from the top** and the
  view auto-scrolls to keep it there.
- **Items:** name · tag · start–end; Time-Blocks render as labelled **outlines**
  spanning their range; pattern instances carry their **type texture**.
- **Drag to reorder** items within the hour grid.
- **Collision-clamped, residual flagged:** a dragged/resized block (or Plan group)
  stops at a neighbour's edge instead of overlapping — live during the drag, not just
  on release — and never increases a pre-existing overlap. Any residual overlap still
  shows a clear **conflict marker** (the PLANNER never silently reflows). Plan
  containers are attach-on-drop targets, so dropping a task into a Plan's window
  attaches it rather than clamping.
- **Placement ⇄ task in lockstep:** a placed task IS scheduled, so the two stay in
  sync. Moving/resizing a block writes the linked task's `scheduled_for` + `task_time`
  (the earliest session owns them; tz-correct in the owner's zone), and completing a
  block completes the task. Editing the task's time/day/estimate moves its placed block
  in return. One-block tasks are the common case; multi-session tasks anchor on the
  first session.

## 7. Visual spec (CI-Hub tokens — global styles first)

- Surfaces `bg-background`/`bg-card`; text `text-foreground`/`text-muted-foreground`;
  lines `border-border`; primary actions `bg-primary text-primary-foreground`;
  focus `ring-ring`. Montserrat. No hardcoded hex, no inline styles.
- Time-Block outline = `border-border` (or the tag's accent) at ~1.5px, label in
  `text-muted-foreground`.
- Pattern textures: very low-contrast (≤ ~8% over the surface), so they read as a
  whisper, never noise. Conflict marker uses `bg-destructive`/`text-destructive`
  sparingly.
- The drawer and flight-plan use `bg-card`/`bg-popover` with `border-border`; the
  drawer respects `safe-area-inset-bottom`.

## 8. Decisions (resolved 2026-06-20)

- **Flight-plan is persisted, owner-scoped, "until reset."** It survives reloads
  and devices; a **Reset** button clears it. → owner-scoped `flight_plan` table.
- **Staging a Pattern stages its member tasks.** Tapping a pattern in the drawer
  adds each of its tasks to the flight-plan (grouped under the pattern for display);
  Auto then places the individual tasks.
- **Patterns contain tasks only in V1 (no nesting).** Shared tasks link related
  patterns (e.g. "grocery shopping" is in both `errands` and "Family dinner");
  pattern-in-pattern nesting is deferred to `G-INT`.
- **Time-Block reuse is in V1.** Saved/reusable blocks are lightweight
  `block_templates` (named, tagged, default duration).
- **Auto replaces the nightly auto-pack.** Auto is flight-plan-only (two-step); the
  old `auto_schedule` "pack the whole backlog" job is **retired** (repurposed at most
  to *propose* candidates into the flight-plan). Phase-A scheduler tests are reworked.
- **"Open bugs" in the Summary** is read as **open tasks/items**.
