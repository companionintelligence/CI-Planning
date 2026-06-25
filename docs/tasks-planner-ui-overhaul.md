# Tasks / Planner / Nav UI Overhaul — Ticketed Plan

> **Status:** PLAN ONLY — no code written yet. Migration head `0061`. Each ticket is a
> self-contained agent prompt. Built to fan out across worktree agents by **strict file
> ownership** (no two tickets in the same wave edit the same file).
>
> Companion to [README.md](../README.md) and [GLOSSARY.md](GLOSSARY.md). Every label below
> uses the canonical vocabulary: **Task** · **Time Block** · **Routine** · **Tag /
> pattern-tag (direction = Home/Work/Community)** · **Inbox** · **Flight-plan** ·
> **Planner / Calendar** · **Pattern-block** (availability window).

## Working agreements (apply to EVERY ticket — non-negotiable)

1. **Behavior-preservation is the contract.** Every change is **additive**. Existing
   tests stay green; **changing a test expectation is a red flag** that must be called out
   and justified, not done silently.
2. **No regression, no scope creep.** Do **not** add code "to make things work" beyond the
   ticket's stated goal **without explicit consent**. If a goal appears to require a new
   dependency, a new DB migration, a new SSE event, or a change to scheduler/grooming
   behavior, **stop and ask** — flag it in the PR, do not proceed.
3. **No new migrations in this wave** unless a ticket explicitly says so and consent is
   recorded. Head stays `0061`. (Phase M reserves `0062–0064`; plan-import also wants
   `0062` — any migration here would collide and must be coordinated.)
4. **Glossary fidelity.** User-facing labels map to a glossary noun/state/subtype. New
   labels that aren't in the glossary are bugs — raise them.
5. **Local-first, owner-in-the-loop.** Nothing auto-creates a Task without the owner's
   action (README §How it works). One-click "send to Flight-plan" stages only; it does not
   schedule.
6. **Definition of done, baseline:** `pnpm --filter client build` clean, `tsc` clean both
   packages, server `pnpm test` green, client tests green, no new console errors in the
   browser, and a screenshot/DOM-read proof of the changed surface. Pin `TZ=UTC` for any
   date-sensitive test (see [reference: test gotchas]).

## Ticket index

| ID | Group | Title | Depends on |
|----|-------|-------|-----------|
| T-CORE-1 | Foundation | Shared SortControl + sort comparators | — |
| T-CORE-2 | Foundation | `directionColorForTask` helper | — |
| T-CORE-3 | Foundation | `activeTask` selection signal | — |
| T-CORE-4 | Foundation | Clear-day endpoint + `api.blocks.clearDay` | — |
| T-CORE-5 | Foundation | `SchedulePatternEditor` shared component + api | — |
| **T-TASKS-1** | **Tasks view** | **Tab restructure: Routines tab + Patterns "Coming Soon" stub** | T-NAV-1 |
| **T-TASKS-2** | **Tasks view** | **Task-card right rail: priority toggle + Due + Start** | T-CORE-2 |
| **T-TASKS-3** | **Tasks view** | **Direction-color container outline** | T-CORE-2 |
| **T-TASKS-4** | **Tasks view** | **Sort controls (date / priority / direction)** | T-CORE-1 |
| **T-TASKS-5** | **Tasks view** | **One-click send to Flight-plan** | — |
| **T-TASKS-6** | **Tasks view** | **Functional Time Blocks tab (saved templates)** | T-TASKS-1 |
| T-NAV-1 | Navigation | Calendar → 4th primary; remove Routines from nav | — |
| T-PLAN-1 | Planner | Clear-day button in Planner header | T-CORE-4 |
| T-PLAN-2 | Planner | Scroll to 1h before first scheduled block | — |
| T-PLAN-3 | Planner | Selected Task Summary panel | T-CORE-2, T-CORE-3 |
| T-PLAN-4 | Planner | Replace block-click pop-up with selection | T-CORE-3, T-PLAN-3 |
| T-PLAN-5 | Planner | Constrain Planner/Flight-plan width to header | — |
| T-FP-1 | Flight-plan | Fill ⇄ Clear toggle | — |
| T-FP-2 | Flight-plan | Priority ⇄ Due-Date order (near→far, real placement) | T-CORE-1 |
| T-SCHED-1 | Schedule | Edit pattern-blocks per day from Today + Calendar | T-CORE-5 |
| T-SCHED-2 | Schedule | Schedule-mode horizon control + apply N days ahead | — |
| T-SET-1 | Settings | Remove Routine-type creation | — |
| T-TB-1 | Time Block menu | Weekly recurrence day-of-week picker | — |
| T-RTN-1 | Routine menu | Add existing + new-by-name tasks at create | T-TASKS-1 |
| T-RTN-2 | Routine menu | Edit-task affordance in Routines tab | T-TASKS-1 |
| T-DOCS-1 | Cross-cutting | Update README / GLOSSARY / screenshots | all Wave-1 |
| T-QA-1 | Cross-cutting | E2E coverage + enable client tests in CI | all Wave-1 |

---

## Foundation tickets (land first, sequential)

### T-CORE-1 — Shared SortControl + comparators
**Goal:** One reusable control + pure comparators shared by the Tasks view (T-TASKS-4) and
the Flight-plan (T-FP-2), so sorting semantics are defined once.

**Acceptance criteria**
- New `client/src/lib/sort.ts` exports pure comparators: `byPriority`, `byDueDateAsc`
  (nearest due first; tasks with no `due_at` sort last), `byDirectionTag`.
- New `client/src/components/SortControl.tsx` renders a **Priority ⇄ Due Date** segmented
  toggle and an optional **direction dropdown** (Home / Work / Community / All). Props:
  `{ order, onOrder, direction?, onDirection?, showDirection? }`. Purely presentational —
  no store writes inside the component.
- Visual parity with the existing toggle styling at `FlightPlan.tsx:207-223`.

**Files impacted:** `client/src/lib/sort.ts` (new), `client/src/components/SortControl.tsx` (new).
**Connections:** none (pure). Consumers wire callbacks.
**Expected state:** importable control + comparators; no behavior change anywhere yet.
**Definition of done:** unit test for each comparator (incl. null `due_at` ordering); tsc clean.

### T-CORE-2 — `directionColorForTask` helper
**Goal:** Resolve a Task's direction (pattern-tag) color in one place for the card outline
(T-TASKS-3) and the Selected Task Summary (T-PLAN-3).

**Acceptance criteria**
- Add `directionColorForTask(task): string` to `client/src/lib/pattern-meta.ts`,
  generalizing `colorFor(dirTagId)` (`PatternBlockOverlay.tsx:79-83`): find the task's
  pattern-tag (the `kind:'pattern'` tag among `task.tags`), look up
  `patternPrefs.prefs[tagId].color_token`, fall back to `BASE_TAG_DEFAULTS`, then `colorVar`.
- Returns a CSS `var(--…)` string; null-safe (returns `var(--primary)` when no direction).

**Files impacted:** `client/src/lib/pattern-meta.ts`.
**Connections:** reads `patternPrefs` store + `tags` store.
**Expected state:** helper available; no caller yet.
**Definition of done:** unit test (home/work/community + no-direction fallback); tsc clean.

### T-CORE-3 — `activeTask` selection signal
**Goal:** A single "focused" Task distinct from the existing multi-select `Map`, to drive
the Selected Task Summary (T-PLAN-3/4).

**Acceptance criteria**
- Extend `client/src/stores/selection.ts` with `activeTask()` / `setActiveTask()` /
  `clearActiveTask()`. Does **not** alter the existing multi-select `Map` API.

**Files impacted:** `client/src/stores/selection.ts`.
**Connections:** none.
**Expected state:** signal exported; existing selection behavior untouched.
**Definition of done:** existing selection tests still green; tsc clean.

### T-CORE-4 — Clear-day endpoint + client method
**Goal:** Server capability to clear a day's auto/unlocked Time Blocks, for T-PLAN-1.

**Acceptance criteria**
- `POST /api/days/:date/clear` in `server/src/routes/blocks.ts`: deletes **only auto-placed**
  Time Blocks for that local date — i.e. `is_auto = 1` and **not** locked. It must **preserve**:
  calendar/meeting mirrors (`external_events`-linked, meeting kind), user-placed/locked blocks,
  and **habit-derived** blocks (habit-subtype occurrences). Audit-logged via
  `writeAudit({ownerId, actor, action, entity})`. Returns `{ ok, cleared }`. Mirror the
  flight-plan reset pattern (`flight-plan.ts:100-106`). *(Consent recorded: auto-placed only.)*
- `api.blocks.clearDay(date)` in `client/src/lib/api.ts`.

**Files impacted:** `server/src/routes/blocks.ts`, `client/src/lib/api.ts`.
**Connections:** broadcasts an existing block-changed SSE event so open clients refetch; no new event type.
**Expected state:** endpoint callable; no UI yet.
**Definition of done:** server test — clearing a day removes auto blocks, **preserves locked
blocks and meeting mirrors**; idempotent on an already-empty day; tsc clean.

### T-CORE-5 — SchedulePatternEditor shared component + api
**Goal:** One editor for Pattern-blocks (availability windows) scoped to a day, mountable in
Today (T-SCHED-1), Calendar (T-SCHED-1), and Settings (existing section).

**Acceptance criteria**
- New `client/src/components/SchedulePatternEditor.tsx`, extracted from the inline editor at
  `Settings.tsx:431-477` (per-direction time ranges, add/remove window, fill toggle). Props
  let it target a **day type** (`workday`/`weekend`) derived from a given date.
- Uses existing `api.patternBlocks.set(...)`; **no new endpoint, no migration**. Editing a
  given day edits its **day-type template** (Workday Mon–Fri / Weekend Sat–Sun) per the
  glossary Pattern-block model — **not** a per-date override (see consent note T-SCHED-1).

**Files impacted:** `client/src/components/SchedulePatternEditor.tsx` (new), `client/src/lib/api.ts` (only if a typed helper is added — reuse existing `patternBlocks` if possible).
**Connections:** `api.patternBlocks` (GET/PATCH `/api/pattern-blocks`).
**Expected state:** component importable; Settings still renders the same editor (refactor is behavior-neutral).
**Definition of done:** Settings → Schedule Patterns still works identically; tsc clean.

---

## TASKS VIEW tickets

> Surface: `/tasks` (`client/src/views/AllTasks.tsx`) and the shared card
> `client/src/components/TaskCard.tsx`. Glossary: this is the **Task** backlog. Tabs split
> Tasks by subtype/relation; the card edits Task fields directly via `PATCH /api/tasks/:id`.

### T-TASKS-1 — Tab restructure: Routines tab + Patterns "Coming Soon" stub
**Goal:** Fold Routines into the Tasks screen as a tab and add a placeholder final tab, so
Routines stops being a top-level nav destination.

**Acceptance criteria**
- Tab strip (`AllTasks.tsx:120-133`) becomes **Tasks · Habits · Routines · Time Blocks · Patterns**.
  - **Tasks** / **Habits**: unchanged (existing `view` signal + `is_habit` split, `AllTasks.tsx:19-21`).
  - **Routines**: renders the **Routine** collection content extracted from `Patterns.tsx`
    (the Routines section only — Habits already has a tab).
  - **Time Blocks**: **functional** — built in **T-TASKS-6** (saved Time Block templates).
  - **Patterns**: a **"Coming Soon"** placeholder — **do not build content**. A centered
    muted message, nothing else.
- Counts shown per tab where cheap; Routines/Time Blocks/Patterns may omit a count.
- Removing the `/patterns` nav entry is **T-NAV-1** (separate ticket, different files).

**Files impacted:** `client/src/views/AllTasks.tsx`; `client/src/views/Patterns.tsx` (extract a
`RoutinesPanel` the tab can render — keep `Patterns.tsx` compiling so any remaining
deep-link still works during transition). Optionally `client/src/components/RoutinesPanel.tsx` (new).
**Connections:** existing Routines data (`api.patterns`, `refetchPatterns`), `tasks` store.
**Expected state:** `/tasks` shows four tabs; Routines tab is functional; Patterns tab is a stub.
**Definition of done:** all four tabs switch without console errors; Routines tab parity with the
old Routines section; existing Tasks/Habits behavior unchanged; tsc + client build clean.
**Depends on:** T-NAV-1 (so the moved-from nav entry and the moved-to tab land together).

### T-TASKS-2 — Task-card right rail: priority toggle + Due + Start
**Goal:** Add quick-edit controls in the **empty right space** of the existing card without
disturbing its current layout.

**Acceptance criteria**
- **Existing placement is preserved**: checkbox, the priority dot (`TaskCard.tsx:124`),
  title, description, all tags, and the `Nm` estimate stay exactly where they are.
- The **right column** (currently only the estimate at top, then blank — see
  `TaskCard.tsx:122-136`) gains, stacked under the estimate:
  1. **Priority selector** — 4-segment toggle **P1 · P2 · P3 · Later**; the selected segment
     is **filled with that priority's color** (`.p1/.p2/.p3` + a "Later" shade). Mapping:
     P1→`priority:1`, P2→2, P3→3, **Later→4** (display any `priority ≥ 4` as "Later").
     Writes via `api.tasks.update(id, { priority })`. The existing left dot reflects the same value.
  2. **Due** — label + calendar icon opening an inline `<input type="date">`; writes
     `api.tasks.update(id, { due_at })`. Reuse the overdue-red styling from `dueLabel()`
     (`TaskCard.tsx:73-83`).
  3. **Start** — calendar icon → inline date; writes `api.tasks.update(id, { scheduled_for })`.
     ("Start" = `scheduled_for`, the planned start day per the data model.)
- Optimistic refetch via `refetchTasks()` after each write; errors surface via `showToast`.
- **No new priority scale.** The model stays P1–P5 (README); "Later" is a display bucket over 4/5.

**Files impacted:** `client/src/components/TaskCard.tsx` (and `index.css` only if a "Later" color token is needed — additive class, no edits to existing `.p1–.p5`).
**Connections:** `PATCH /api/tasks/:id` via `api.tasks.update` (fields `priority`, `due_at`,
`scheduled_for` — all already in the `Task` type, `api.ts:22-27`); `refetchTasks`, `showToast`.
**Expected state:** every card shows an editable priority toggle + Due + Start on the right;
clicking writes through immediately and persists across refresh.
**Definition of done:** changing priority/Due/Start persists (verified via refetch + reload);
existing card content visually unchanged; subtask-recursion cards still render; tsc + build clean;
browser DOM-read proof.
**Depends on:** none (T-CORE-2 only if the outline ticket lands in the same edit — kept separate).
**Scope (confirmed):** apply the right rail to **all `TaskCard` usages** (top-level + subtasks). No `variant` prop.

### T-TASKS-3 — Direction-color container outline
**Goal:** Outline each task card in its **direction (pattern-tag) color** for at-a-glance grouping.

**Acceptance criteria**
- The card container (`TaskCard.tsx:93-96`, the `.card` element) gets a border/left-accent in
  `directionColorForTask(task)` (T-CORE-2). Tasks with no direction keep the default border.
- Subtle, theme-consistent (e.g., a 2px left border or full border at low opacity) — no layout shift.

**Files impacted:** `client/src/components/TaskCard.tsx`.
**Connections:** `directionColorForTask` (T-CORE-2) → `patternPrefs` + `tags` stores.
**Expected state:** cards are visually grouped by direction color; undirected tasks look as today.
**Definition of done:** Home/Work/Community cards each show the right hue; no console errors;
tsc + build clean; screenshot proof.
**Depends on:** T-CORE-2.

### T-TASKS-4 — Sort controls (date / priority / direction)
**Goal:** Let the owner sort the Tasks list by **due date**, **priority**, or **direction**,
reusing the same Priority ⇄ Due-Date toggle the Today/Flight-plan surface uses.

**Acceptance criteria**
- Mount `SortControl` (T-CORE-1) in the Tasks toolbar (near the existing filters,
  `AllTasks.tsx:83-118`): the **Priority ⇄ Due Date** toggle + a **direction dropdown**
  (Home / Work / Community / All).
- Apply the matching comparator from `sort.ts` to `shownList()` (`AllTasks.tsx:21,141`).
  Due-Date order is **nearest due first**, undated last. Direction sort groups by pattern-tag.
- Sort is **client-side display only** — it does **not** call the scheduler or change
  `fill_order` (that's T-FP-2). Default order unchanged from today unless the owner picks one.

**Files impacted:** `client/src/views/AllTasks.tsx`.
**Connections:** `SortControl` + comparators (T-CORE-1); local signal for chosen order/direction.
**Expected state:** the Tasks list reorders live as the owner toggles; refresh-safe if persisted
to a local signal (persisting to prefs is out of scope unless requested).
**Definition of done:** each sort mode orders correctly (incl. undated-last); existing filters
still work; tsc + build clean; browser proof.
**Depends on:** T-CORE-1.

### T-TASKS-5 — One-click send to Flight-plan
**Goal:** From the Tasks view, stage any Task into the **Flight-plan** in one click (staging
only — never schedules, per README).

**Acceptance criteria**
- A quick-action on the card (hover actions area, `TaskCard.tsx:194-223`) calls
  `api.flightPlan.addTask(task.id)` (`api.ts:182`) and toasts success/no-op.
- Idempotent UX: adding an already-staged Task is a friendly no-op (surface the server's
  `added` count). **Does not** auto-select or auto-schedule.

**Files impacted:** `client/src/components/TaskCard.tsx`.
**Connections:** `POST /api/flight-plan { task_id }` via `api.flightPlan.addTask`; `showToast`;
the Flight-plan refetches via its existing SSE/store path.
**Expected state:** clicking the action stages the Task; the Flight-plan reflects it on next refetch.
**Definition of done:** staging works from the Tasks list; no scheduling side-effect; tsc + build clean.
**Depends on:** none.

### T-TASKS-6 — Functional Time Blocks tab (saved Time Block templates)
**Goal:** Build the **Time Blocks** tab (T-TASKS-1) as a working surface for **saved Time Block
templates** — not a stub.

**Acceptance criteria**
- Extract the Time Blocks section from `Patterns.tsx:401-433` into a `TimeBlocksPanel` rendered by
  the Time Blocks tab: list saved templates, **instantiate onto today** (`api.blockTemplates.instantiate`),
  and **delete** (`api.blockTemplates.delete`), with the existing empty-state hint.
- Parity with the current Patterns Time Blocks section — **no behavior change**, just relocated.
- Glossary: these are Time Blocks in the **saved** state (`block_templates`); label the tab **Time Blocks**.

**Files impacted:** `client/src/views/Patterns.tsx` (extract), `client/src/components/TimeBlocksPanel.tsx` (new), `client/src/views/AllTasks.tsx` (mount in the tab — same owner as T-TASKS-1).
**Connections:** `api.blockTemplates.list` / `.instantiate` / `.delete` (GET/POST/DELETE `/api/block-templates`).
**Expected state:** the Time Blocks tab lists saved templates and supports instantiate + delete, identical to today's Patterns section.
**Definition of done:** list/instantiate/delete all work from the tab; Patterns view no longer needs the duplicated section; tsc + build clean; browser proof.
**Depends on:** T-TASKS-1.

---

## Navigation

### T-NAV-1 — Calendar → 4th primary; remove Routines from nav
**Goal:** Promote **Calendar** into the primary bottom nav and remove **Routines** from both
navs (it now lives as a Tasks tab, T-TASKS-1).

**Acceptance criteria**
- `BottomNav.tsx:7-18`: primary row becomes **Today · Inbox · Tasks · Calendar** (4 buttons)
  + **More**. Remove Routines (`/patterns`) from primary and overflow.
- `Nav.tsx:10-19` (desktop rail): remove the Routines entry.
- `App.tsx:153-162`: **redirect** `/patterns` → `/tasks` (confirmed) so existing
  bookmarks/deep-links don't 404.
**Files impacted:** `client/src/components/BottomNav.tsx`, `client/src/components/Nav.tsx`, `client/src/App.tsx`.
**Connections:** SolidJS Router routes.
**Expected state:** Calendar reachable in one tap on mobile; Routines absent from nav; `/patterns` redirects.
**Definition of done:** both navs render correctly; no dead Routines link; redirect verified; tsc + build clean.

---

## Planner cockpit

### T-PLAN-1 — Clear-day button in Planner header
**Goal:** A header action that clears the current day's auto/unlocked Time Blocks.
**Acceptance criteria:** button in the Planner header row (`Planner.tsx:705-735`) → confirm →
`api.blocks.clearDay(day())` (T-CORE-4) → refetch. Disabled/no-op on an empty day. Never clears
locked blocks or meeting mirrors.
**Files impacted:** `client/src/components/Planner.tsx`.
**Connections:** `POST /api/days/:date/clear` (T-CORE-4); block SSE refetch.
**Expected state:** one action empties the day's auto blocks; locked/meetings remain.
**Definition of done:** clears as specified; preserves locked/meetings; tsc + build clean; browser proof.
**Depends on:** T-CORE-4.

### T-PLAN-2 — Scroll to 1h before the first scheduled block
**Goal:** Open the Planner scrolled to one hour before the **earliest scheduled Time Block**
of the day (not "next up").
**Acceptance criteria:** change the initial scroll anchor in `planner.ts:42-50`
(`scrollTopForBlock`/`nextUpScrollTopPx`) and `repin()` (`Planner.tsx:645-652`) to use the day's
**first scheduled block** start minus 60 min, clamped ≥ 0. Empty day → top. The 4/8/16h window
toggle still works.
**Files impacted:** `client/src/components/Planner.tsx`, `client/src/lib/planner.ts`.
**Connections:** none (pure scroll math).
**Expected state:** the board opens showing ~1h of lead-in above the first block.
**Definition of done:** unit test for the new anchor math (first-block, empty-day, pre-9am block);
tsc + build clean; browser proof.

### T-PLAN-3 — Selected Task Summary panel
**Goal:** A panel under the Planner header showing the **active Task** with quick actions —
replacing the click pop-up (T-PLAN-4).
**Acceptance criteria:** new `client/src/components/SelectedTaskSummary.tsx` mounted under the
header in `Today.tsx`. Shows the `activeTask` (T-CORE-3): **name in the direction color**
(T-CORE-2), the direction **ShapeIcon** (`icon_shape` from patternPrefs), secondary tags, and
actions **Edit** (ElementWizard), **Promote to habit** (`POST /tasks/:id/promote-habit`),
**Delete** (`DELETE /tasks/:id`). Empty when nothing is selected.
**Files impacted:** `client/src/components/SelectedTaskSummary.tsx` (new), `client/src/views/Today.tsx`.
**Connections:** `activeTask` store (T-CORE-3); `directionColorForTask` (T-CORE-2); `api.tasks.promoteHabit`, `api.tasks.delete`, `setElementModal`.
**Expected state:** selecting a block populates the summary; actions operate on it.
**Definition of done:** all three actions work from the panel; tsc + build clean; browser proof.
**Depends on:** T-CORE-2, T-CORE-3.

### T-PLAN-4 — Replace block-click pop-up with selection
**Goal:** Clicking a Planner block **selects** it (feeding the Summary) instead of opening the
BlockMenu pop-up.
**Acceptance criteria:** block click sets `activeTask` (T-CORE-3) rather than opening `BlockMenu`
(`Planner.tsx:126-147,355-362`). The multi-select Cmd/Ctrl-click path (`Planner.tsx:390-398`) and
drag-to-schedule are **unchanged**. The BlockMenu's actions now live in the Summary (T-PLAN-3),
so removing the pop-up loses no capability.
**Files impacted:** `client/src/components/Planner.tsx`.
**Connections:** `activeTask` store.
**Expected state:** single click selects (no modal); Edit/Promote/Delete available via the Summary.
**Definition of done:** no pop-up on click; no lost actions; drag + multiselect intact; tsc + build clean; browser proof.
**Depends on:** T-CORE-3, T-PLAN-3.

### T-PLAN-5 — Constrain Planner/Flight-plan width to header
**Goal:** Align the Planner and Flight-plan columns to the header card width.
**Acceptance criteria:** tune the Today grid (`Today.tsx:134`,
`md:grid-cols-[1fr_minmax(20rem,24rem)]`) so the cockpit columns line up with the header card.
Done at the grid wrapper — **does not edit `FlightPlan.tsx` internals** (keeps T-FP tickets disjoint).
**Files impacted:** `client/src/views/Today.tsx`.
**Connections:** none (layout).
**Expected state:** header, Planner, and Flight-plan share a consistent width frame.
**Definition of done:** alignment holds at md+ and stacks cleanly on mobile; tsc + build clean; screenshot proof.

---

## Flight-plan

### T-FP-1 — Fill ⇄ Clear toggle
**Goal:** When the Flight-plan has items, the **Fill Plan** button becomes **Clear Plan**.
**Acceptance criteria:** in `FlightPlan.tsx`, when `items().length > 0` show **Clear Plan** →
existing `reset()` (`FlightPlan.tsx:129-136` → `POST /api/flight-plan/reset`); when empty show
**Fill Plan** → existing `runFill()`. No new endpoint.
**Files impacted:** `client/src/components/FlightPlan.tsx`.
**Connections:** existing `api.flightPlan.reset` / `api.auto.fill`.
**Expected state:** the one button flips label+action by fullness.
**Definition of done:** both states behave correctly; tsc + build clean; browser proof.

### T-FP-2 — Priority ⇄ Due-Date order (near→far, real placement)
**Goal:** Rename the **Over-Due** option to **Due Date** and change the **actual scheduling
order** so Due-Date places **nearest-due → furthest** (not overdue-first).
**Acceptance criteria**
- Replace the inline toggle (`FlightPlan.tsx:207-223`) with `SortControl` (T-CORE-1); label is
  **Priority ⇄ Due Date**.
- Server: in `server/src/engine/autoplan.ts`, the Due-Date fill order sorts by `due_at`
  **ascending (nearest first)**, undated last. Migrate the `fill_order` pref value
  `'overdue'` → `'due'` with a **back-compat read** (treat legacy `'overdue'` as `'due'`); update
  the `Prefs` type (`api.ts:412`). **No DB migration** — `fill_order` is a free-text/string pref;
  confirm before touching the column.
- This is the **one** ticket that intentionally changes scheduling order (consent recorded here).
**Files impacted:** `client/src/components/FlightPlan.tsx`, `server/src/engine/autoplan.ts`, `client/src/lib/api.ts` (Prefs type).
**Connections:** `PATCH /api/prefs { fill_order }`; autoplan fill ordering.
**Expected state:** "Due Date" mode schedules nearest-due tasks first; "Priority" mode unchanged.
**Definition of done:** server test asserting near→far placement under `'due'` and back-compat for
`'overdue'`; existing priority-order tests stay green; tsc + build clean.
**Depends on:** T-CORE-1.

---

## Schedule patterns

### T-SCHED-1 — Edit Pattern-blocks per day from Today + Calendar
**Goal:** Let the owner adjust the day's **Pattern-blocks** (availability windows) from the
Today and Calendar surfaces, not only Settings.
**Acceptance criteria**
- Mount `SchedulePatternEditor` (T-CORE-5) from Today (`Today.tsx`) and Calendar
  (`Calendar.tsx`), scoped to the selected date's **day type** (Workday/Weekend).
- **Confirmed (migration-free):** editing a day edits its **day-type template** (the existing
  Pattern-block model). **Per-date overrides are NOT built** — they would require a new table +
  migration + reconciler and **explicit consent** (flagged, not done).
**Files impacted:** `client/src/views/Today.tsx` (Today mount), `client/src/views/Calendar.tsx` (Calendar mount). *(Editor + api are T-CORE-5.)*
**Connections:** `api.patternBlocks` (GET/PATCH `/api/pattern-blocks`).
**Expected state:** owner can open the schedule-pattern editor for a day from Today/Calendar; edits
persist to the day-type template and shade the Planner accordingly.
**Definition of done:** edits round-trip and reflect in the Planner shading; Settings editor still
works; tsc + build clean; browser proof.
**Depends on:** T-CORE-5. **Note:** Today.tsx is also touched by T-PLAN-3/5 — assign Today.tsx to one
owner in the wave (see file-ownership matrix).

### T-SCHED-2 — Schedule-mode horizon control + apply N days ahead
**Goal:** Let the owner set **how many days ahead** "Schedule" mode plans, in the Schedule
Patterns area of Settings, and have Schedule mode apply Pattern-blocks/placement for that many days.
**Acceptance criteria**
- Add a **"Planning horizon — Schedule mode (days)"** numeric control to the Schedule Patterns
  section of Settings (`Settings.tsx:411-486`).
- Schedule mode applies placement for **N days ahead** instead of a single day.
- **Confirmed (migration-free): reuse `planning_horizon_days`** and document the overlap (it
  also governs candidate *selection*). A dedicated `schedule_horizon_days` pref would need a
  migration → **explicit consent** (flagged, not done).
- **Engine change requires consent:** running placement across N days touches
  `scheduler.ts`/`patterns-place.ts`. Implement as a bounded loop over the existing single-day
  placement (no new placement semantics). If this risks reflow/grooming behavior, **stop and ask**.
**Files impacted:** `client/src/views/Settings.tsx` (control), `server/src/engine/scheduler.ts` and/or `server/src/engine/patterns-place.ts` (N-day apply).
**Connections:** `PATCH /api/prefs`; `POST /api/schedule/run` (or its callers) looped per date.
**Expected state:** Schedule mode plans the next N days using existing per-day placement.
**Definition of done:** server test: N-day apply places across N days and is idempotent per day;
single-day behavior preserved at N=1; tsc + build clean.
**Note:** if T-FP-2 and this both end up editing `autoplan.ts`, sequence this after T-FP-2.

---

## Settings

### T-SET-1 — Remove Routine-type creation
**Goal:** Owners can no longer **create** Routine types; built-ins remain editable.
**Acceptance criteria**
- Remove the "Add custom type" button + `startNew()` create path in
  `RoutineTypeSettings.tsx:179-185,38-42`; keep edit-on-builtins.
- Trim the "Routine Types" sub-section copy in the merged Settings card (`Settings.tsx:653-658`).
- **Optional, consent-gated:** refuse create at `POST /api/pattern-types`
  (`server/src/routes/patterns.ts:151-183`) so the lockdown is server-enforced. If the API is used
  elsewhere (tests/import), confirm before changing server behavior — otherwise UI-only removal.
**Files impacted:** `client/src/components/RoutineTypeSettings.tsx`, `client/src/views/Settings.tsx` (copy); optionally `server/src/routes/patterns.ts`.
**Connections:** `api.patternTypes.create` (removed from UI).
**Expected state:** no create affordance; existing types still editable (and Ritual still flag-gated).
**Definition of done:** no create path in the UI; edit still works; existing pattern-type tests green; tsc + build clean.
**Glossary note:** `pattern_types` is **load-bearing — do not rename** (README). This ticket only
removes the create affordance.

---

## New Time Block menu

### T-TB-1 — Weekly recurrence day-of-week picker for Time Blocks
**Goal:** When **Weekly** is selected in the New/Edit **Time Block** menu, let the owner pick
specific days-of-week — matching the Task menu.

**Background (already in place):** the Task path renders an inline weekday multi-select
(`ElementWizard.tsx:441-453`, writing `taskWeekdays`); the Time Block path hardcodes
`buildRule(tbRepeat(), [], tbCustomRule())` (`ElementWizard.tsx:202`) and exposes only a raw RRULE
box (`:372-374`). `buildRule`/`rulePreset` already handle `BYDAY` (`recurrence.ts:25-58`), and the
server stores `recurrence_rule` for blocks identically to tasks — so this is **client-only, one file**.

**Acceptance criteria**
- Add a `tbWeekdays` signal + toggle in `ElementWizard.tsx`, mirroring `taskWeekdays` (`:50-52,:69`).
- Under the Time Block **Weekly** preset, render the **same** weekday multi-select markup as the
  task path, reusing `WEEKDAYS` / `DAY_INITIAL` from `recurrence.ts`.
- Change the block rule build to `buildRule(tbRepeat(), tbWeekdays(), tbCustomRule())` (`:202`).
- On **edit**, prefill `tbRepeat` + `tbWeekdays` by parsing the block's `recurrence_rule` via
  `rulePreset()` (mirror the task prefill).
- **No API / DB / server change** — `BYDAY` round-trips today.

**Files impacted:** `client/src/components/ElementWizard.tsx` (reuses `client/src/lib/recurrence.ts`, no edit).
**Connections:** `api.blocks.create` / `api.blocks.update` `recurrence_rule` (already wired).
**Expected state:** a weekly Time Block on Mon/Wed/Fri saves `FREQ=WEEKLY;BYDAY=MO,WE,FR`; reopening
edit reselects those days; the description line reads "Repeats every Mon, Wed, Fri".
**Definition of done:** create + reopen round-trip verified; the **Task** weekly picker is unchanged;
tsc + build clean; browser proof.
**Optional (consent-gated):** extract a shared `<WeekdayPicker>` to dedupe the task / block /
`Patterns.tsx:244-259` markup — touches 3 call sites, so only with sign-off.

## New Routine menu

### T-RTN-1 — Add existing + new-by-name tasks during Routine creation
**Goal:** In the New Routine flow, add an area to **(a)** attach **existing** Tasks and **(b)** add a
**new Task by name only**. The name-only Task is fleshed out later from the Routines tab (T-RTN-2).

**Background:** routine creation today is a name + `#tag` inline form that attaches no tasks
(`Patterns.tsx:310-345`; moves into `RoutinesPanel` after T-TASKS-1). Membership API exists:
`api.patterns.addTask(patternId, taskId, position?)` / `removeTask` (`api.ts:145-148` →
`POST/DELETE /api/patterns/:id/tasks`). Title-only Task create works (server requires only a
non-empty `title`, `tasks.ts:92-96`).

**Acceptance criteria**
- The create form gains a **task-attach area**: a picker/typeahead to select existing open Tasks,
  plus an **"add new task by name"** input that creates a name-only Task.
- On **Create**: create the Routine (`api.patterns.create`), then for each selected existing Task
  call `addTask`; for each new name, `api.tasks.create({ title })` then `addTask`. Preserve order
  via `position`.
- New-by-name Tasks carry **only a title** — no other fields written (behavior-preservation). A hint
  tells the owner to edit details later from the Routines tab.
- **No auto-scheduling**, no extra side-effects.

**Files impacted:** `client/src/views/Patterns.tsx` and/or `client/src/components/RoutinesPanel.tsx` (whichever holds the create form after T-TASKS-1).
**Connections:** `api.patterns.create`, `api.patterns.addTask`, `api.tasks.create`; the membership
route already broadcasts `pattern:updated` (SSE) — no new event.
**Expected state:** creating a Routine can seed it with existing + brand-new (name-only) Tasks in one step.
**Definition of done:** create a Routine with 1 existing + 1 new-by-name Task → both appear as members;
the new Task exists with title only; tsc + build clean; browser proof.
**Depends on:** T-TASKS-1 (same Routines surface/owner).

### T-RTN-2 — Edit-task affordance in the Routines tab
**Goal:** From the Routines member list, let the owner open a Task to edit — so a name-only Task
from T-RTN-1 can be completed.

**Background:** `MemberRow` (`Patterns.tsx:149-170`) currently only removes / promotes-to-habit /
dials an estimate — **no edit**. The ElementWizard edit path opens via `setElementModal({ open,
mode:'edit', kind, editTarget })`.

**Acceptance criteria**
- Add an **Edit** (pencil) action to `MemberRow` that opens the ElementWizard in edit mode for that
  Task (`setElementModal`). Habit members open as `kind:'habit'`, otherwise `kind:'task'`.
- **No change to `ElementWizard.tsx`** itself (only invoked). Existing remove / promote / dial intact.

**Files impacted:** `client/src/views/Patterns.tsx` / `client/src/components/RoutinesPanel.tsx` (MemberRow).
**Connections:** `setElementModal` store → ElementWizard edit → `PATCH /api/tasks/:id`.
**Expected state:** each routine member has an edit affordance; editing persists.
**Definition of done:** editing a name-only member adds details and persists; existing member actions
unchanged; tsc + build clean; browser proof.
**Depends on:** T-TASKS-1.

---

## Cross-cutting (land LAST, after Wave 1 integrates)

### T-DOCS-1 — Update README / GLOSSARY / screenshots
**Goal:** Keep the source-of-truth docs honest after the nav/view changes.
**Acceptance criteria**
- **README.md:** the "**Eight views**" list and the architecture-diagram `UI[...]` node drop **Routines**
  as a top-level view (it's now a Tasks tab); reflect **Calendar** in the primary bottom nav and the
  removal of Routine-type creation. Adjust the Tasks-view screenshot caption to mention tabs.
- **GLOSSARY.md:** confirm **Routine** stays a noun (it does — only its *navigation surface* moved, from
  a top-level view to a Tasks tab); add a one-line note that Routines/Time Blocks are now Tasks-screen
  tabs. No noun-budget change. Keep `pattern_types` "load-bearing, do not rename".
- **Screenshots:** refresh `docs/screenshots/tasks.png` (new tabs + card right rail) and `today.png`
  (Selected Task Summary, width frame); note any others that drift.
**Files impacted:** `README.md`, `docs/GLOSSARY.md`, `docs/screenshots/*`.
**Connections:** none (docs).
**Expected state:** docs match the shipped UI; no stale "Routines view" references.
**Definition of done:** README view list + diagram updated; GLOSSARY note added; screenshots refreshed;
no broken cross-links.
**Depends on:** all Wave-1 tickets (capture the final UI).

### T-QA-1 — End-to-end coverage of reworked surfaces + enable client tests in CI
**Goal:** Guard the reworked surfaces against regression, and close the known CI gap where **client
tests are skipped**.
**Acceptance criteria**
- Add focused tests for the new behaviors that aren't covered by a single ticket's DoD: tab switching
  + Routines/Time Blocks/Patterns tabs (T-TASKS-1/6), card right-rail writes (T-TASKS-2), one-click
  stage (T-TASKS-5), clear-day **preserves** locked/meeting/habit blocks (T-CORE-4/T-PLAN-1), due-date
  near→far placement (T-FP-2), and the container smoke flow if a view route changed.
- **CI:** wire client tests into `.github/workflows/ci.yml` so client regressions fail CI (currently
  skipped — known drift). **Consent note:** this changes CI config; if it risks flakiness, gate behind
  a discussion first.
- **No production behavior change** — tests + CI only.
**Files impacted:** `client/**/*.test.ts(x)` (new), `server/test/*` (new where server-side), `.github/workflows/ci.yml`, `tests/container/*` (if a route changed).
**Connections:** CI; existing vitest + Playwright harness.
**Expected state:** the reworked surfaces have regression coverage; CI runs client tests.
**Definition of done:** new tests green locally; CI runs client tests and is green; respects the
test-harness gotchas (pin `TZ=UTC` for date-sensitive specs; shared sequential DB).
**Depends on:** all Wave-1 tickets.

---

## Fan-out & sequencing

**Wave 0 (sequential):** T-CORE-1 … T-CORE-5 land first; everyone rebases on the tip.

**Wave 1 (parallel, one worktree each):**

| Worktree | Tickets | Owns (exclusive) |
|----------|---------|------------------|
| W-TASKS-CARD | T-TASKS-2, T-TASKS-3, T-TASKS-5 | `TaskCard.tsx` |
| W-TASKS-VIEW | T-TASKS-1, T-TASKS-4, T-TASKS-6, T-RTN-1, T-RTN-2 | `AllTasks.tsx`, `Patterns.tsx`, `RoutinesPanel.tsx`, `TimeBlocksPanel.tsx` |
| W-WIZARD | T-TB-1 | `ElementWizard.tsx` |
| W-NAV | T-NAV-1 | `BottomNav.tsx`, `Nav.tsx`, `App.tsx` |
| W-PLANNER | T-PLAN-1…5, T-SCHED-1 (Today/Calendar mounts) | `Planner.tsx`, `planner.ts`, `Today.tsx`, `Calendar.tsx`, `SelectedTaskSummary.tsx` |
| W-FLIGHT | T-FP-1, T-FP-2 | `FlightPlan.tsx`, `autoplan.ts` |
| W-SETTINGS | T-SET-1, T-SCHED-2 | `RoutineTypeSettings.tsx`, `Settings.tsx`, `scheduler.ts`/`patterns-place.ts` |

**Disjointness:** the only shared files (`api.ts`, `pattern-meta.ts`, `selection.ts`) are
**Wave-0-only**. `Today.tsx` is owned solely by **W-PLANNER** (it absorbs the T-SCHED-1 Today mount).
`ElementWizard.tsx` is owned solely by **W-WIZARD** (T-RTN-2 only *invokes* it via `setElementModal`).
`Patterns.tsx` / `RoutinesPanel.tsx` are owned solely by **W-TASKS-VIEW** (it absorbs the Routine-menu tickets).
If **W-FLIGHT** (autoplan.ts) and **W-SETTINGS** (scheduler/patterns-place) both reach into
`autoplan.ts`, sequence W-SETTINGS after W-FLIGHT.

**Wave 2 (sequential, after Wave 1 integrates):** **T-DOCS-1** and **T-QA-1** land last — they
describe and test the *final* integrated UI, so they must follow everything else. T-QA-1's CI change
is consent-gated (see ticket).

**Integrate → adversarial review → browser-verify each surface → squash to main.**
Base Wave-1 agents on the Wave-0 tip (not `main`) and tell each its head + owned files.

## Consent items — RESOLVED (2026-06-24)
1. **T-CORE-4 clear-day scope:** ✅ clear **only auto-placed** blocks; preserve calendar/meeting mirrors, user-placed/locked blocks, and habits.
2. **T-NAV-1 `/patterns`:** ✅ **redirect** to `/tasks`.
3. **T-SCHED-1 per-day model:** ✅ **day-type template editing** (migration-free). Per-date overrides not built.
4. **T-SCHED-2 horizon pref:** ✅ **reuse `planning_horizon_days`** (migration-free).
5. **T-TASKS-2 scope:** ✅ apply the right rail to **all `TaskCard` usages**.

**Result: the entire wave is migration-free (head stays `0061`) and adds no new dependencies.**
Remaining consent gates are *optional enhancements only* (T-TB-1 shared `<WeekdayPicker>` extraction;
T-SET-1 server-side create refusal; per-date schedule overrides / dedicated horizon pref).
