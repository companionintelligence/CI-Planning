> **Type:** fix · **Phase:** ENTITY · **Branch:** `fix/confirm-destructive-deletes` · **Commit style:** `fix(planner): confirm before deleting tasks and blocks` · **Design:** user feedback 2026-07-15 · **Dependencies:** none

## Goal

Close the **four delete paths that destroy work with no confirmation**. Today the codebase confirms *trivial, reversible* edits (changing a task's priority) but silently deletes tasks and blocks on a single click.

The user asked for this on the Planner (Today + Calendar) and then chose **global** scope: every delete action confirms.

## Non-goals

- **Do not introduce a new modal/dialog system.** Every confirm in this repo is native `window.confirm()` (10 sites). Adding a branded `<ConfirmDialog>` is a separate, larger refactor — out of scope here.
- **Do not touch the 7 paths that already confirm** (listed below). This ticket only closes gaps.
- **Do not remove the existing edit-confirms** at `TaskCard.tsx:283/288/294` (priority/due/start). They are arguably over-confirmation, but removing them is a separate UX decision the owner has not made.
- No soft-delete, trash bin, or undo.
- No server change. No audit-logging change.

## Pinned conventions

Branch `claude/local-backend-frontend-setup-77dae0`.

- **Confirm style:** bare `confirm(\`…\`)` in components, `window.confirm(\`…\`)` in views. Guard shape is uniform:
  `if (!confirm(\`…\`)) return;` as the **first statement** of the handler, before the `try`.
- **Copy style:** state the object by name and the consequence. Existing examples:
  - `TimeBlocksPanel.tsx:38` — ``Delete the "${t.name}" Time Block? Saved tasks won't come back.``
  - `FlightPlan.tsx:289` — ``Delete the "${props.t.name}" saved block? Its embedded tasks won't come back.``
  - `DayTypeManager.tsx:43` — ``Delete the "${t.name}" day type? Days using it fall back to the default.``
- **Error style:** `catch (err) { showToast((err as Error).message, 'error'); }` — unchanged.
- **Already confirming — DO NOT MODIFY:** `ObjectivesPanel.tsx:98` · `TimeBlocksPanel.tsx:38` · `FlightPlan.tsx:289` · `DayTypeManager.tsx:43` · `Settings.tsx:380` · `Planner.tsx:858` (clear-day) · `PlannerEntityCard.tsx:212` (template replace) · `Planner.tsx:590` `DeletePlanDialog` (a branded dialog — already a confirmation, reached from `requestDeletePlan` when `childCount > 0`).

### Semantics that must shape the copy (verified, do not guess)

- **`TaskCard.tsx:270`** — `api.tasks.delete()` toasts **"Task cancelled"**: the server maps DELETE to `status='cancelled'`, recoverable from Archive. Copy must say **cancel**, not "delete forever".
- **`PlannerEntityCard.tsx:228`** — deleting a **non-container** block **re-stages its task to the flight-plan** (`api.flightPlan.addTask(b.task_id)`; toast *"Removed — sent back to the flight-plan"*). This is an **unschedule**, not a destroy. Copy must reflect that; a task-bearing block losing its slot is not the same as losing the task.
- **`PlannerEntityCard.tsx:228`** — a **container** block does **not** delete here; it delegates to `props.onRequestDeletePlan(b)` → `Planner.requestDeletePlan`. Do **not** add a confirm on the container branch; it would double-prompt in front of `DeletePlanDialog`.

## Before implementation

1. `client/src/components/TaskCard.tsx:270-276` — the unguarded `remove()`.
2. `client/src/components/Planner.tsx:845-853` — `requestDeletePlan`; note the `childCount === 0` fast path is the only unguarded branch.
3. `client/src/components/Planner.tsx:902-906` — `del()` for a someday/concept block.
4. `client/src/components/PlannerEntityCard.tsx:222-236` — `remove()`; note the container delegation at `:228`.
5. `client/src/components/TimeBlocksPanel.tsx:38` — the copy template to imitate.

## Files impacted

**Changed:**
- `client/src/components/TaskCard.tsx` — guard `remove()` (`:270`).
- `client/src/components/Planner.tsx` — guard the `childCount === 0` branch of `requestDeletePlan` (`:847`); guard `del()` (`:902`).
- `client/src/components/PlannerEntityCard.tsx` — guard the **non-container** branch of `remove()` (after `:228`).

**New:** none.

## Schema required

**None** — client-only.

## Definition of Done

- [ ] `TaskCard.remove()` prompts, e.g. ``Cancel "${props.task.title}"? You can restore it from Archive.`` — cancelling the prompt makes no API call.
- [ ] `Planner.requestDeletePlan()` prompts on the `childCount === 0` branch only, e.g. ``Delete "${plan.title}"?`` — the `childCount > 0` branch still opens `DeletePlanDialog` with **no** extra prompt.
- [ ] `Planner.del()` (someday block) prompts, e.g. ``Delete "${props.block.title}"?``
- [ ] `PlannerEntityCard.remove()` prompts on the **non-container** branch only, e.g. ``Remove "${title}" from the day? The task returns to the flight-plan.`` — the container branch still delegates with no prompt.
- [ ] Every guard is `if (!confirm(…)) return;` placed before the `try`.
- [ ] Declining leaves state untouched — no API call, no toast, no refetch.
- [ ] Accepting behaves exactly as today (same call, same toast, same refetch).
- [ ] The 7 already-confirming sites are byte-unchanged.

## Tests

Verification commands (must pass):

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter client test
```

Cases:

- [ ] Tasks list → delete a task → prompt appears; **Cancel** → task still present, no toast.
- [ ] Tasks list → delete a task → **OK** → task cancelled, "Task cancelled" toast (unchanged).
- [ ] Planner → delete an empty plan (no children) → prompt; Cancel → block remains.
- [ ] Planner → delete a plan **with** children → `DeletePlanDialog` opens directly, **no** native prompt first (double-prompt guard).
- [ ] Planner → delete a someday/concept block → prompt; Cancel → block remains.
- [ ] PlannerEntityCard → remove a **task** block → prompt; OK → block removed **and** task re-staged to the flight-plan (existing behavior preserved).
- [ ] PlannerEntityCard → remove a **container** block → `DeletePlanDialog` opens, **no** native prompt first.
- [ ] Grep proof: no `api.tasks.delete` / `api.blocks.delete` / `api.objectives.delete` call site remains without either a `confirm()` guard or a `DeletePlanDialog` path.

## Acceptance Criteria

- [ ] All four gap paths confirm before destroying work.
- [ ] No double-prompting on either container path.
- [ ] Copy matches real semantics (cancel vs. unschedule vs. delete).
- [ ] `tsc`, client build, client tests clean.
- [ ] No new console errors.
- [ ] Screenshot proof of one prompt.

## Subtasks

1. Guard `TaskCard.remove()` with cancel-accurate copy.
2. Guard the `childCount === 0` branch of `Planner.requestDeletePlan`.
3. Guard `Planner.del()` for someday blocks.
4. Guard the non-container branch of `PlannerEntityCard.remove()` with unschedule-accurate copy.
5. Verify both container paths do not double-prompt.
6. Re-grep every delete call site to prove coverage.
7. Run tsc + build + tests; screenshot one prompt.
