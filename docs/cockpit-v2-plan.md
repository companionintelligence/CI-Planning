# Cockpit v2 — UI/UX batch plan

> Status: **planning doc only — no implementation yet.** Branch `claude/cockpit-v2` off `main` (after PR #70 merged). This doc is the contract for the next working session.

## Context

PR #70 shipped Plan-as-container, the TODAY-cockpit refinements, Plans-first Auto, the nightly review/reschedule, and quick-complete. This batch is the next round of UI/UX changes the user specified, refining the cockpit into a date-navigable, two-column workspace and reworking the tag + task-lifecycle models underneath.

Most of this is additive UI. **Two items are deeper and carry real risk** — the tag-model convergence and the task-store/shelf model — see [Risks](#risks). The work is phased so the safe UI lands first and the data-model changes are isolated + independently reviewable. This is a large batch; expect **multiple commits, possibly split across PRs**.

## Decisions locked (with the user)

- **Day navigation**: the cockpit shows any day, not just today. Now-line / next-up pin / auto-scroll show **only when the viewed day === today**; off-today the region label switches from "TODAY" to the date.
- **Day Overview stats** → **pill-shaped tags** (number + label, in a row). Replaces the horizontal bars from PR #70.
- **Two-column desktop layout** (≥ md): Planner left, Flight-plan + Block/Pattern/Open-Task drawer right. Mobile stays stacked.
- **Drawer** opens **upward** over the flight-plan on a higher layer, **freezing** flight-plan input behind an **80% dark overlay**.
- **Concepts**: remove the ConceptLane container; a Concept appears on its goal day in the Planner; clicking it opens a **lightweight popover** (name, tags, goal day, Edit · Add-to-day · Delete) — not the full modal.
- **Tag model**: **one canonical tag store** (the normalized `tags`/`task_tags` table, extended to Plans/Concepts) with a **level** per association. Plans = 1 top-level + N second-level; Concepts = N top-level; Habits/Tasks = N flat. **Dilution**: a tag's match weight = `1 / (number of tags on the item)`, but **top-level tags are immune** (full weight); only secondaries dilute. Applied to **both auto-placement and search recall**.
- **Task stores** = four **filtered views over the one tasks table** (not separate tables), toggled in the Open-Task list: **Open · TBD · Deferred · Past**.
  - **TBD** = strict: a task with a **title and ≥1 tag and nothing else** (no due, no estimate, not scheduled, no notes).
  - **Past** = completed or deferred history; the "shelf".
  - **Recall** from Past = **clone to a brand-new task (new id)**: carries title, tags, estimate, notes, **and subtasks (auto)**; **pattern membership only if a Settings toggle is on** (default OFF); resets dates/status to a fresh open task.
- **Auto button** → round, lightning icon, **no text**, one-tap, **no screen** (result toast only). Keeps the smart behaviour (propose if nothing staged; place if staged).
- **"Fill work hours" toggle** at the flight-plan's top-right next to ⚡ — flips `auto_fill_workday` (the pref already shipped; stays in sync with Settings).
- **Planner window control**: replace the binary Expand/Collapse with a **4h / 8h / 16h** text segmented control (active option **underlined + 30% lighter**). **Drop the 24h view.**

---

## Phases (ordered: safe UI → data model)

### Phase 1 — Day navigation
Make the cockpit date-driven. A `selectedDay` signal (default `localISODate()`) that the Planner, Concepts, blocks fetch, and overview all read instead of calling `localISODate()` directly.

- `client/src/views/Today.tsx` (Day Overview header): calendar-icon date picker to the **right of the date**; **‹ ›** prev/next-day steppers. Region label shows the date; "TODAY" only when on today.
- `client/src/stores/index.ts`: `blockRange` derives from `selectedDay`, not a hardcoded today. Concepts/blocks refetch on day change.
- `client/src/components/Planner.tsx`: `day` comes from `selectedDay`. Gate the now-line, next-up pin, and auto-scroll behind `selectedDay === today`.
- Lazy pattern placement (`ensurePatternsForRange`) already only fills today-or-future, so navigating future days pre-places their patterns (intended); past days are read-only.

### Phase 2 — Day Overview + flight-plan controls (pure UI)
- **Stat pills**: replace the `Bar` rows with inline pills `[icon N label]` in a row (overdue / blocked / open). Tag-pill styling.
- **Auto ⚡**: `client/src/components/FlightPlan.tsx` — round icon button, lightning, no text, one-tap (existing behaviour), result toast.
- **"Fill work hours" toggle** next to ⚡ — bound to `prefs.auto_fill_workday` via PATCH `/api/prefs`; reflects + syncs with Settings.
- **Planner sizes**: `client/src/components/Planner.tsx` + `lib/planner.ts` — `VISIBLE_HOURS` becomes a 3-way `4 | 8 | 16` selection; segmented text control (active underlined, 30% lighter). Remove the 24h path. **Ensure the window can still scroll to reach any block** (see Risks).

### Phase 3 — Two-column layout + drawer overlay
- `client/src/views/Today.tsx`: below the Day-Overview card, a responsive grid — single column on mobile, two columns ≥ md (Planner | Flight-plan + drawer).
- `client/src/components/PlannerDrawer.tsx`: anchor it under the flight-plan in the right column; opening a tab **expands upward** over the flight-plan (higher z-layer), with an **80% dark overlay** over the flight-plan that **traps/freezes** its input until the drawer closes.

### Phase 4 — Concepts
- Remove `client/src/components/ConceptLane.tsx` from the layout.
- Concepts render on their **goal day** in the Planner header lane (already partly there via `todayConcepts` → generalize to `selectedDay`).
- `HeaderChip` becomes clickable → a **popover** (new small component) with the concept's name, tags, goal day, and Edit · Add-to-day · Delete. No full modal on click.

### Phase 5 — Tag model (HIGH RISK — isolate)
Converge Plans/Concepts onto the normalized tag store, add levels + dilution.

- **Schema** (new migration): a `level` column on the tag↔entity association(s). Decide one of:
  - (a) extend `task_tags` semantics + add a `block_tags` join for time_blocks, each with `level`; or
  - (b) a single polymorphic `entity_tags(entity_kind, entity_id, tag_id, level)`.
  Keep `time_blocks.tag` as a **denormalized top-level mirror** for cheap reads + color (back-compat).
- **Backfill**: split existing comma-joined `time_blocks.tag` / concept tags into tag rows + level-1 associations.
- **Reads/writes to update**: the Block Wizard + Plan editor (`PlannerDrawer.tsx`, `BlockEditModal.tsx`), serialization, color resolution, and — critically — the **Plans-first Auto matcher** (`server/src/engine/autoplan.ts`) and any search. The matcher's tag-overlap ordering becomes **weighted** by the dilution rule.
- **Dilution**: weight(tag) = top-level ? 1.0 : `1 / totalTags`. Apply in `orderForPlan` (auto) and the task search/recall ranking.

### Phase 6 — Task stores + shelf (HIGH RISK — isolate)
- **Views**: Open-Task list (in the drawer) gets toggles **Open · TBD · Deferred · Past**. Filtered views over `tasks` by status + the TBD heuristic. No new tables.
  - TBD filter: `title set AND ≥1 tag AND due_at IS NULL AND estimated_minutes IS NULL AND scheduled_for IS NULL AND (notes is empty)`.
  - Deferred: `status='deferred'` (or scheduled_for in the future).
  - Past: `status IN ('done','completed','deferred')` history — the recall pool. Needs **search/pagination** (see Risks).
- **Recall = clone-to-new** (`POST /api/tasks/:id/recall` or client-side compose + create): new id, copies title + tags + estimate + notes + **subtasks (recursively, re-id'd, reset to open)**; **pattern membership only if `prefs.recall_keeps_pattern` (new toggle, default OFF)**; dates/status fresh.
- **Settings**: add the `recall_keeps_pattern` toggle.

---

## Risks

**The two data-model phases (5 + 6) are where this can go wrong. Read before building.**

1. **Tag-store migration is the single riskiest change.** Plans/Concepts move from a comma-joined `tag` string to normalized associations with levels. This touches the Auto matcher *just shipped in #70*, search, color, the wizard, the Plan editor, and serialization. Mitigation: keep `time_blocks.tag` as a denormalized **top-level mirror** so most existing reads keep working, and migrate writers incrementally. Even so it's a broad change with re-test cost — **do it in its own PR**.

2. **Dilution changes behaviour I just shipped.** Weighting tags by `1/count` shifts both Auto's choices and search order. A user who tags heavily will see those tasks *deprioritized* — which can feel like "my tasks aren't getting scheduled." Mitigations: top-level-immune (already chosen) softens it; add a sensible floor; re-run the Plans-first placement tests with weighted overlap. Expect to re-verify `auto-placement.test.ts`.

3. **Shelf / recall (the parts you flagged):**
   - **Auto-cloning subtasks** = recursively duplicating a subtree with **id remapping**; get the parent/child remap wrong and you orphan or cycle. Decide: completed subtasks → clone as **open**? (recommend yes). Large/deep trees → many rows.
   - **The clone has no history** — no streak, no logged time, new id. This is by design ("duplicate", not "resume"), but it *will* surprise anyone expecting continuity. State it in the UI ("duplicated as a new task").
   - **Past grows unbounded.** Every completed/deferred task accumulates; the recall list rots without **search + pagination**. Treat that as part of Phase 6, not an afterthought.
   - **Pattern-membership-on-recall default OFF is correct** — otherwise recalling a shelved habit silently resurrects a pattern you may have retired.

4. **Any-day view ripples.** The cockpit assumed "today" everywhere. Navigating to a **future** day triggers lazy pattern placement *there* (pre-populates future days — likely desired, but a behaviour change). "Missed"/now-line are today-relative. Quick-complete on a past day must still work. Re-check each surface against `selectedDay`.

5. **Conceptual load.** This batch **net-adds** nouns/states — two tag *levels*, four task *views*, a *shelf*/recall flow — to an app the prior review already called overloaded (~25 nouns). It's partly offset by consolidations (one tag store, removing the ConceptLane), but the net direction is *more* surface area. Worth a deliberate "yes, we want the power" decision.

6. **Scope.** This is larger than the entire A–F cockpit batch. A single PR would be un-reviewable. **Phase it**: 1–4 (UI) can be one PR; 5 (tags) and 6 (stores/shelf) each their own.

7. **Dropping the 24h view.** If a block lands outside the largest (16h) window, the user can't reach it. The windowed scroller must be able to **slide to any block's time** (or the 16h window must cover the full block span). Verify no block becomes unreachable.

8. **Drawer overlay / focus trap.** "Open upward over a frozen, 80%-dimmed flight-plan" fights the current never-closing-drawer design. It's a z-index + focus-trap + portal exercise; manageable, but test keyboard/escape and that the freeze actually blocks input.

## Verification (per the established ritual)

- Run server + client suites under **Node 26.3.0** (`export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT`). Baseline at branch point: **server 250 / client 97**.
- New tests: tag dilution weighting (unit, both top-immune + secondary-dilute); TBD/Deferred/Past filters; recall clone (carries title/tags/estimate/notes/subtasks; NOT pattern unless toggle); day-navigation block range.
- `pnpm typecheck` both packages clean; migrations apply on a fresh DB (`migrate.test.ts`).
- Browser-verify via the preview: day stepper + calendar; pills; two-column + drawer overlay/freeze; concept popover; Auto ⚡ + Fill-work-hours toggle; 4/8/16 control; a recall clone; tag dilution affecting Auto order.

## Critical files

- `client/src/views/Today.tsx` — day nav, pills, two-column grid.
- `client/src/components/Planner.tsx` + `lib/planner.ts` — `selectedDay`, 4/8/16 control, concept popover trigger.
- `client/src/components/FlightPlan.tsx` — round ⚡, Fill-work-hours toggle.
- `client/src/components/PlannerDrawer.tsx` — drawer-opens-upward overlay/freeze; Open-Task store toggles + recall.
- `client/src/components/ConceptLane.tsx` — removed; `HeaderChip`/new popover.
- `client/src/stores/index.ts` — `selectedDay` + derived `blockRange`.
- `client/src/views/Settings.tsx` — `recall_keeps_pattern` toggle.
- `server/src/db/schema.ts` + new migrations (0030+) — tag levels, denormalized mirror, `recall_keeps_pattern`.
- `server/src/engine/autoplan.ts` — weighted (diluted) tag matching.
- `server/src/routes/tasks.ts` — TBD/Deferred/Past filters; recall/clone endpoint.

## Reused utilities (don't reinvent)
- `server/src/engine/scheduler.ts` `dayObstacles` / `buildGaps` / `pickGap`.
- `client/src/lib/textures.ts` `tagHueToken` / `tagColorVar` (per-tag color, already shipped).
- `client/src/lib/recurrence.ts`, `client/src/lib/draggable.ts`, `client/src/stores/selection.ts`.
- The prefs-toggle pattern (`Settings.tsx` `Toggle` + generic `/api/prefs`).
