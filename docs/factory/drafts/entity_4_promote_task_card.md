> **Type:** feature · **Phase:** ENTITY · **Branch:** `feat/task-card-new-objective` · **Commit style:** `feat(tasks): create an objective from a task in the picker` · **Design:** user feedback 2026-07-15 · **Dependencies:** **blocked by ENTITY-3**

> ### 📓 HISTORICAL — this is the pre-implementation draft, and it SHIPPED
> It drove **PR #368** (merged 2026-07-16, no migration), closing issue **#360**. It is kept
> as the **decision record**: the *why* behind the design, which the diff cannot explain.
>
> **It describes the codebase as it was BEFORE #368 — read it in the past tense.** Every
> `file:line` below is a snapshot from 2026-07-15 authoring and has drifted. For current
> behavior read the code; the durable pointers here are the *file + symbol* names.
>
> ⚠️ **This draft was stale before implementation even started.** It was written against
> ENTITY-3's *original* placeholder-subtask design, which was overturned as backwards before
> either ticket shipped. Its Non-goals point at ENTITY-3 for the promote mechanism, so read
> ENTITY-3's revision notice first: what shipped is a **direct** promote plus a guard-only
> extraction (`isPromotableToObjective`), not the placeholder-subtask route this draft
> assumed. (The auto-promote-on-subtask-creation mechanism it cites does exist and predates
> the ENTITY wave — `services/tasks.ts:193`, "§H: creating a subtask promotes its parent to
> an objective"; it is the *placeholder* design layered on top that was abandoned.)

## Goal

Let the owner create a **new Objective from a task** directly in the Tasks backlog, without leaving for the Objectives tab.

**This is not a new button.** `TaskCard` already has the **AF-6 assign-to-objective picker** (`TaskCard.tsx:114-210`) — it lazily loads the objectives tree, filters to **leaf** objectives, and links/unlinks via `api.objectives.linkTask` / `unlinkTask`. What it cannot do is create one: its empty state literally reads *"No objectives yet — create one on the Objectives tab."* This ticket adds a **"New objective"** footer row to that existing picker, exactly mirroring the **"New routine"** footer row the picker was modelled on.

## Non-goals

- **Do not add a hover-rail button.** The picker is the established objective affordance on this card; a second entry point would compete with it.
- **No new server route, no migration** — same mechanism as ENTITY-3: creating a subtask auto-promotes the parent (`services/tasks.ts:193`).
- Do not change the existing link/unlink behavior, the leaf filtering, or the search threshold.
- Do not touch `lib/objective-picker.ts` (`buildPickerRows` / `leafObjectives` / `PICKER_SEARCH_THRESHOLD`) — the new row is not a picker row.
- No bulk/multi-select promotion.

## Pinned conventions

Branch `claude/local-backend-frontend-setup-77dae0`, all in `client/src/components/TaskCard.tsx`.

- **The picker component:** `:114-210` — *"AF-6 · Assign-to-objective dropdown (mirrors the add-to-routine menu idiom)"*. Popover shell at `:165`:
  `<div class="absolute z-20 bottom-full left-0 mb-1 w-56 rounded-md border border-border bg-popover shadow-lg py-1">`
- **Insertion point:** immediately **after** the `<For each={rows()}>` block and its empty/`No match`/`loadFailed` states (`~:181-207`), inside the scroll container's parent — i.e. the same structural slot the routine menu uses for its footer.
- **⭐ The footer row to mirror exactly** — `:649`:
  ```tsx
  <button onClick={newRoutineWithTask} class="w-full text-left px-3 py-1.5 text-sm text-accent-hi hover:bg-sidebar-accent border-t border-border mt-1 flex items-center gap-1"><Plus size={12} /> New routine</button>
  ```
  Reuse this class string verbatim; label **"New objective"**; `<Plus size={12} />`.
- **⭐ The handler to mirror exactly** — `newRoutineWithTask` (`:326-336`):
  ```ts
  async function newRoutineWithTask() {
    const name = prompt('New routine name')?.trim();
    if (!name) return;
    try { /* create + link */ refetchPatterns(); showToast(`…`, 'success'); setRoutineMenu(false); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  ```
- **Linked-id field:** `props.task.objective_ids ?? (props.task.objective_id ? [props.task.objective_id] : [])` (`:140`) — **`objective_ids` is plural and authoritative**; `objective_id` is a legacy single-value fallback. Do not regress to the singular.
- **Server constraint (already handled by the picker):** links to **non-leaf** objectives are rejected `422 non_leaf`. A newly-promoted objective is always a leaf, so it is immediately linkable.

## Shared helper (the rule-of-two extraction)

ENTITY-3 lands the same prompt → `api.tasks.create({ title, parent_id })` → refetch sequence in `PlannerEntityCard`. This ticket is the **second** call site, so extract it rather than duplicate:

- **New:** `client/src/lib/objective-promote.ts` exporting
  `export async function promoteTaskToObjective(taskId: string, promptTitle?: () => string | null): Promise<boolean>`
  — returns `false` when the owner cancels the prompt, `true` on success; throws on API error so each caller keeps its own `showToast` copy.
- **Refactor ENTITY-3's** `PlannerEntityCard.promoteObjective()` to call it. Behavior must not change.

## Before implementation

1. **ENTITY-3 must be merged first** — read its `PlannerEntityCard.promoteObjective()` handler; that is the logic being extracted.
2. `server/src/services/task-promotion.ts:46-52` — the promotability guards (`quick` subtype and recurrence instances are silent no-ops).
3. `server/src/services/tasks.ts:185-196` — `if (parentId) ensureTaskPromoted(parentId, ownerId);`.
4. `client/src/components/TaskCard.tsx:114-210` — the picker.
5. `client/src/components/TaskCard.tsx:326-336` and `:649` — the routine idiom being mirrored.

## Files impacted

**New:**
- `client/src/lib/objective-promote.ts` — the shared promote helper.

**Changed:**
- `client/src/components/TaskCard.tsx` — add the "New objective" footer row + handler to the AF-6 picker.
- `client/src/components/PlannerEntityCard.tsx` — refactor ENTITY-3's handler onto the shared helper (behavior-neutral).

**Server:** untouched.

## Schema required

**None.** Reuses `objectives` + `objective_tasks` (Phase N, 0081/0086/0087).

## Definition of Done

- [ ] `client/src/lib/objective-promote.ts` exports `promoteTaskToObjective`; it prompts for the first subtask title, returns `false` on cancel, and otherwise calls `api.tasks.create({ title, parent_id: taskId })`.
- [ ] `PlannerEntityCard.promoteObjective()` delegates to the helper; its toasts and guards are unchanged.
- [ ] The AF-6 picker gains a **"New objective"** footer row using the `:649` class string and `<Plus size={12} />`.
- [ ] Clicking it prompts, creates the subtask, closes the menu, `refetchTasks()`, and toasts success.
- [ ] Cancelling the prompt → no API call, no toast, menu stays open.
- [ ] The footer row is **hidden** when the task is not promotable (`subtype === 'quick'` or `recurrence_parent_id` set) — matching `ensureTaskPromoted`'s no-op set.
- [ ] The footer row shows **even when `leafCount() === 0`**, so the "No objectives yet" dead end is gone.
- [ ] After promotion the new Objective appears in the picker's rows as a linked (checked) leaf.
- [ ] Existing link/unlink, search, leaf filtering, and `loadFailed` states are unchanged.

## Tests

Verification commands (must pass):

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter client test
pnpm --filter server test
```

Cases:

- [ ] Unit: `promoteTaskToObjective` returns `false` and makes no call when the prompt is cancelled/blank.
- [ ] Unit: `promoteTaskToObjective` calls `api.tasks.create` with `{ title, parent_id }`.
- [ ] Tasks list → open the objective picker on a task with **no** objectives → "New objective" row is present (empty-state dead end gone).
- [ ] Click it → prompt → confirm → Objective created, menu closed, success toast, task marked as in-an-objective.
- [ ] Reopen the picker → the new Objective is listed and **checked**.
- [ ] Cancel the prompt → nothing created, menu still open.
- [ ] Row hidden for a `quick` task and for a recurrence instance.
- [ ] Existing link/unlink of an unrelated objective still works.
- [ ] Planner (ENTITY-3) promotion still behaves identically after the refactor.

## Acceptance Criteria

- [ ] Owner can create an Objective from a task without leaving the Tasks tab.
- [ ] Logic is shared with ENTITY-3, not duplicated.
- [ ] Non-promotable tasks do not show the row.
- [ ] `tsc`, client build, client + server tests clean.
- [ ] No new console errors.
- [ ] Screenshot proof: picker with the "New objective" row, and the objective checked after creation.

## Subtasks

1. Extract `promoteTaskToObjective` into `client/src/lib/objective-promote.ts`.
2. Refactor `PlannerEntityCard.promoteObjective()` onto it; verify no behavior change.
3. Add the "New objective" footer row to the AF-6 picker, mirroring `:649`.
4. Wire the handler; close the menu + refetch on success.
5. Add the promotability guard to the row's visibility.
6. Unit-test the helper; hand-verify both surfaces.
7. Run tsc + build + both suites; capture screenshots.
