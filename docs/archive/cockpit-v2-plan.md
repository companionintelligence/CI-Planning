# Cockpit v2 — UI/UX batch plan (post-consolidation)

> **⚠️ HISTORICAL — superseded, not the current plan.** The cockpit shipped (#77) and
> then diverged from this doc — notably `/calendar` was **restored** (#92), reversing
> the "Planner absorbs Calendar / retire `/calendar`" decision below. Retained for
> history. Live plan:
> [phase-0-reconciliation-plan.md](phase-0-reconciliation-plan.md).

> Status: **planning doc only — no implementation yet.** Branch off `main` after the
> consolidation pass (CON-1 + CON-5 + CON-2, merged via #76). **Supersedes the
> original cockpit-v2 plan (PR #71)**, which was written against `main`@#70 *before*
> consolidation rebuilt the foundation. Canon: [GLOSSARY.md](GLOSSARY.md). Upstream
> reshaping: the "What this does to #71" rebase map in
> [consolidation-plan.md](consolidation-plan.md).

## Why this supersedes #71

#71 planned the cockpit on top of #70. Between then and now the **consolidation
pass** landed and *deliberately absorbed #71's riskiest, most foundational pieces*,
so this batch is now smaller and sits on stable ground:

| #71 assumed | Reality on `main` now |
|-------------|------------------------|
| integer ids | **UUIDv7 TEXT, opaque strings** (CON-1) — recall=clone is trivial (client-mintable ids) |
| "Plan / Concept / Plan-Block / Pattern" | canonical **Time Block** {scheduled · someday · saved} / **Routine** (CON-2b) |
| `block_type` `plan`/`concept`; `?block_type=` | `scheduled`/`someday`; list param `?state=` (CON-2a) |
| habit/fast as ad-hoc flags | **`tasks.subtype`** `standard \| habit \| quick` (CON-2c; `is_habit`/`is_fast_task` kept as aliases) |
| Planner is read-only (wizard-only authoring) | **drag-to-place shipped** (CON-5) — click empty slot → Time Block; drag task → schedule |
| tag store: *open choice* (a) `block_tags` vs (b) polymorphic | **decided: (b) `entity_tags(entity_kind, entity_id, tag_id, level)`** — it's **CON-3**, not this batch |
| ConceptLane removed here | ConceptLane removal is **CON-2d**, *deferred until this batch's day-nav lands* |

Net effect (per the consolidation rebase map): cockpit-v2 = **pure cockpit UI** +
**two isolated data touches** (tag *dilution*, task *views/recall*), each riding a
decision already made.

## Baseline + canon

- Branch point: `main`@#76 (`7edf0ce`). Suite baseline: **server 253 / client 106**
  (Node 26.3.0: `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT`).
- Every UI label must map to [GLOSSARY.md](GLOSSARY.md); the **8-noun budget is the
  review gate** (a new noun requires retiring one). This batch adds **states /
  subtypes / filters**, *not* nouns — keep it that way.
- Migrations: consolidation reserved `0030–0034` (CON-1..4). This batch's migrations
  (tag `level`, `recall_keeps_pattern`) start at **`0035+`**.

## Decisions locked (carried from #71, re-grounded in the canon)

- **Day navigation**: the cockpit shows any day. Now-line / next-up pin / auto-scroll
  appear **only when the viewed day === today**; off-today the region label switches
  from "TODAY" to the date. **Also retire the `/calendar` route** — once the Planner
  is date-navigable it absorbs it (GLOSSARY: Calendar view → Planner).
- **Day Overview stats → pill-shaped tags** (number + label, in a row). Replaces the
  horizontal bars from #70.
- **Two-column desktop (≥ md)**: Planner left, Flight-plan + Block/Routine/Open-Task
  drawer right. Mobile stays stacked. The Planner is already **write-capable** (CON-5),
  so authoring works from the grid, not just the wizard.
- **Drawer opens upward** over the flight-plan on a higher layer, **freezing** its
  input behind an **80% dark overlay** until the drawer closes.
- **Someday Time Blocks** (was "Concepts"): **remove `ConceptLane`** (this completes
  the deferred **CON-2d**), render a someday block on its **goal day** in the Planner
  header lane, and make the chip clickable → a **lightweight popover** (name, tags,
  goal day, Edit · Add-to-day · Delete) — not the full modal.
- **Tag levels + dilution** (the *only* tag change here; the normalized store is CON-3):
  a **`level`** per tag↔entity association. Time Block = 1 top-level + N second-level;
  someday = N top-level; Routine/Task = N flat. **Dilution**: match weight =
  `1 / (#tags on the item)`, but **top-level tags are immune** (full weight); only
  secondaries dilute. Applied to **both auto-placement and search recall**.
- **Task views** = four **filtered views over the one `tasks` table** (no new tables),
  toggled in the Open-Task list: **Open · TBD · Deferred · Past**.
  - **TBD** = strict: title **and** ≥1 tag **and nothing else** (no due, no estimate,
    not scheduled, no notes).
  - **Past** = completed/deferred history — the "shelf".
  - **Recall** from Past = **clone to a brand-new task (new UUIDv7 id)**: carries
    title, tags, estimate, notes, **subtasks (recursively re-id'd, reset to open)**,
    and **`subtype`**; **Routine membership only if `prefs.recall_keeps_pattern`**
    (new toggle, default **OFF**); dates/status reset to a fresh open task.
- **Auto button** → round, lightning icon, **no text**, one-tap, **no screen** (result
  toast only). Keeps the smart behaviour (propose if nothing staged; place if staged).
- **"Fill work hours" toggle** at the flight-plan top-right next to ⚡ — flips
  `auto_fill_workday` (pref already shipped; stays in sync with Settings).
- **Planner window**: replace Expand/Collapse with a **4h / 8h / 16h** segmented
  control (active option underlined + 30% lighter). **Drop the 24h view.**

---

## Phases (ordered: safe UI → data model)

### Phase 1 — Day navigation (+ retire `/calendar`)
Make the cockpit date-driven via a `selectedDay` signal (default `localISODate()`)
that the Planner, header-lane someday blocks, blocks fetch, and overview all read
instead of calling `localISODate()` directly.
- `client/src/views/Today.tsx`: calendar-icon date picker right of the date + **‹ ›**
  steppers; region label shows the date, "TODAY" only when on today.
- `client/src/stores/index.ts`: block range derives from `selectedDay`; refetch on
  day change.
- `client/src/components/Planner.tsx`: `day` from `selectedDay`; gate now-line,
  next-up pin, auto-scroll behind `selectedDay === today`.
- Retire the `/calendar` route + nav entry (`Nav.tsx`/`BottomNav.tsx`) once the
  Planner is date-navigable. Lazy Routine placement already fills today-or-future, so
  future days pre-place; past days are read-only.

### Phase 2 — Day Overview pills + flight-plan controls (pure UI)
- **Stat pills**: replace the `Bar` rows with inline pills `[icon N label]`.
- **Auto ⚡** (`FlightPlan.tsx`): round icon button, no text, one-tap, result toast.
- **"Fill work hours" toggle** next to ⚡ — bound to `prefs.auto_fill_workday`.
- **Planner sizes** (`Planner.tsx` + `lib/`): `VISIBLE_HOURS` → 3-way `4 | 8 | 16`
  segmented control; remove the 24h path. **Window must still scroll to any block.**

### Phase 3 — Two-column layout + drawer overlay
- `Today.tsx`: responsive grid — single column on mobile, two columns ≥ md
  (Planner | Flight-plan + drawer).
- `PlannerDrawer.tsx`: anchor under the flight-plan; opening a tab **expands upward**
  over it (higher z-layer) with an **80% dark overlay** that **traps/freezes** input
  until closed. (Drawer tabs are already canonical post-CON-2b: Block / Routine / Open Task.)

### Phase 4 — Someday popover + finish ConceptLane removal (CON-2d)
- Remove `client/src/components/ConceptLane.tsx` from the layout (the deferred CON-2d
  step — now unblocked by Phase 1's day-nav).
- Render someday Time Blocks on their **goal day** in the Planner header lane
  (generalize the existing `todayConcepts` → `selectedDay`).
- `HeaderChip` → clickable **popover** (new small component): name, tags, goal day,
  Edit · Add-to-day · Delete. No full modal on click.

### Phase 5 — Tag levels + dilution  *(HIGH RISK — isolate; REQUIRES CON-3)*
> **Gated on CON-3** (`entity_tags`). The canonical normalized store is CON-3's
> deliverable, *not* this batch. Do not start Phase 5 until `entity_tags` + its
> tag-repo layer have landed.
- **Schema** (migration `0035+`): add/confirm a `level` column on `entity_tags`
  (CON-3 already specs `level DEFAULT 1`); keep `time_blocks.tag` as the denormalized
  top-level mirror (CON-3 maintains it).
- **Reads/writes**: Block Wizard + Time-Block editor (`PlannerDrawer.tsx`,
  `BlockEditModal.tsx`), serialization, color resolution, and — critically — the
  **Plans-first Auto matcher** (`server/src/engine/autoplan.ts`) and search.
- **Dilution**: `weight(tag) = top-level ? 1.0 : 1 / totalTags`. Apply in the Auto
  ordering and the task search/recall ranking. **Re-verify `auto-placement.test.ts`.**

### Phase 6 — Task views + shelf/recall  *(HIGH RISK — isolate)*
- **Views**: Open-Task list gets toggles **Open · TBD · Deferred · Past** — filtered
  views over `tasks` (status + the TBD heuristic), no new tables.
  - TBD: `title set AND ≥1 tag AND due_at IS NULL AND estimated_minutes IS NULL AND
    scheduled_for IS NULL AND notes empty`.
  - Past: `status IN ('done','completed','deferred')` — needs **search + pagination**.
- **Recall = clone-to-new** (`POST /api/tasks/:id/recall`): mint a new UUIDv7; copy
  title + tags + estimate + notes + **`subtype`** + **subtasks (recursively re-id'd,
  reset to open)**; **Routine membership only if `prefs.recall_keeps_pattern`**
  (new toggle, default OFF); dates/status fresh. (UUIDv7 makes the re-id trivial.)
- **Settings**: add the `recall_keeps_pattern` toggle (migration `0035+`).

---

## Risks

1. **Dilution changes shipped behaviour (Phase 5).** Weighting by `1/count` shifts
   Auto's choices and search order; top-level-immunity softens it. It is now the
   *only* tag behaviour change (normalization is CON-3). **Gated on CON-3**; re-run
   `auto-placement.test.ts` with weighted overlap.
2. **Recall=clone subtree (Phase 6).** Recursively duplicating a subtree with id
   remapping — easier on UUIDv7 (mint a fresh `uuid7()` per node) but still must map
   parent/child correctly. Clone completed subtasks **as open**. The clone has **no
   history** (new id, no streak/logged time) — say so in the UI ("duplicated as a new
   task"). **Past grows unbounded** → search + pagination is part of the phase.
3. **Any-day ripples.** Now-line / "missed" / quick-complete are today-relative;
   navigating to a future day triggers lazy Routine placement there. Re-check each
   surface against `selectedDay`.
4. **Dropping 24h.** Ensure the windowed scroller can slide to **any** block's time so
   nothing becomes unreachable.
5. **Drawer overlay / focus trap.** "Open upward over a frozen, dimmed flight-plan"
   fights the never-closing-drawer design — a z-index + focus-trap + portal exercise;
   test keyboard/escape and that the freeze actually blocks input.
6. **Noun budget.** This batch's additions are **states/filters** (Open/TBD/Deferred/
   Past) and a tag **level** — not new nouns. Keep them mapped to GLOSSARY terms; if a
   new noun is tempted, retire one first.
7. **Scope / phasing.** Phases **1–4 = one PR** (cockpit UI + the CON-2d cleanup);
   **Phase 5 its own PR** (after CON-3); **Phase 6 its own PR**.

## Verification (per the established ritual)

- Server + client suites under **Node 26.3.0**; baseline **server 253 / client 106**.
- New tests: day-range fetch; pills; someday popover; tag dilution (top-immune +
  secondary-dilute); TBD/Deferred/Past filters; recall clone (carries
  title/tags/estimate/notes/**subtype**/subtasks; **NOT** Routine unless toggle).
- `pnpm typecheck` both packages; migrations apply on a fresh DB (`migrate.test.ts`).
- Browser-verify via preview: day stepper + calendar; pills; two-column + drawer
  overlay/freeze; someday popover; Auto ⚡ + Fill-work-hours; 4/8/16 control; a recall
  clone; tag dilution affecting Auto order.

## Critical files

- `client/src/views/Today.tsx` — day nav, pills, two-column grid.
- `client/src/components/Planner.tsx` + `lib/grid.ts`/`lib/planner.ts` — `selectedDay`,
  4/8/16 control, someday-popover trigger. (Drag-to-place from CON-5 already lives here.)
- `client/src/components/FlightPlan.tsx` — round ⚡, Fill-work-hours toggle.
- `client/src/components/PlannerDrawer.tsx` — drawer overlay/freeze; Open-Task views + recall.
- `client/src/components/ConceptLane.tsx` — **removed** in Phase 4 (CON-2d).
- `client/src/components/BlockEditModal.tsx` — tag-level edit (Phase 5).
- `client/src/stores/index.ts` — `selectedDay` + derived block range.
- `client/src/views/Settings.tsx` — `recall_keeps_pattern` toggle.
- `client/src/components/Nav.tsx` / `BottomNav.tsx` — drop `/calendar` (Phase 1).
- `server/src/db/schema.ts` + migrations `0035+` — tag `level` (on CON-3 `entity_tags`),
  `recall_keeps_pattern`.
- `server/src/engine/autoplan.ts` — weighted (diluted) tag matching (Phase 5).
- `server/src/routes/tasks.ts` — TBD/Deferred/Past filters; recall/clone (carry `subtype`).

## Reused utilities (don't reinvent)
- `server/src/engine/scheduler.ts` `dayObstacles` / `buildGaps` / `pickGap`.
- **CON-5 drag-to-place**: `client/src/lib/draggable.ts`, `lib/grid.ts`,
  `lib/group-move.ts` — the Planner is already write-capable.
- **CON-3 tag-repo layer** (once landed) for `entity_tags` reads/writes — Phase 5
  builds on it, it does not re-implement the store.
- `client/src/lib/textures.ts` `tagHueToken` / `tagColorVar` (per-tag color).
- The prefs-toggle pattern (`Settings.tsx` `Toggle` + generic `/api/prefs`).

## Dependencies (sequencing)
- **Phase 5 is blocked on CON-3** (`entity_tags`); coordinate with the consolidation track.
- **Phase 1 (day-nav) unblocks CON-2d** (ConceptLane removal), which Phase 4 then completes.
- CON-4 (recurrence unification) is independent of this batch but shares the migration lane.
