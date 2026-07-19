> **Type:** fix · **Phase:** ENTITY · **Branch:** `fix/confirm-destructive-deletes` · **Commit style:** `fix: confirm before destructive deletes` · **Design:** user feedback 2026-07-15 · **Dependencies:** none

> ### 📓 HISTORICAL — this is the pre-implementation draft, and it SHIPPED
> It drove **PR #364** (merged 2026-07-16, no migration), closing issue **#358**. It is kept
> as the **decision record**: the *why* behind the design, which the diff cannot explain.
>
> **It describes the codebase as it was BEFORE #364 — read it in the past tense.** Every
> `file:line` below is a snapshot from 2026-07-15 authoring and has drifted. For current
> behavior read the code; the durable pointers here are the *file + symbol* names.
>
> The revision notice below is part of that history — it records a correction made while
> the ticket was still open, not a live instruction.

> ### ⚠️ Ticket revised 2026-07-15 — the original body was wrong
> It claimed **4** unguarded paths; there are **5**, and it proposed copy that made a promise the code does not keep. Corrections, all verified against `main`:
> - **Missed:** `RoutinesPanel.tsx:68` (deletes a Routine) and `Tags.tsx:37` (deletes a Tag) are both silent. Now in scope (owner: "global means global").
> - **Not a gap:** `CategorySettings.tsx:63` already has its own inline `confirmDelete` state.
> - **Exempted (owner decision):** `PlannerEntityCard.tsx:231` is an *unschedule*, not a delete — see below.
> - **Copy corrected:** the original said *"You can restore it from Archive."* There is **no restore affordance** — do not promise one.
> - **New finding:** deleting a Routine **hard-deletes** its `quick` member tasks. This is the only irreversible path in the set.

## Goal

Close the delete paths that destroy work with no confirmation. Today the codebase confirms *trivial, reversible* edits (changing a task's priority — `TaskCard.tsx:283`) while silently deleting tasks, blocks, routines, and tags on a single click.

## Verified semantics — the copy must match these, do not guess

| # | Site | What actually happens | Reversible? |
|---|------|----------------------|-------------|
| 1 | `TaskCard.tsx:272` | `deleteTask` sets `status:'cancelled'` (`services/tasks.ts:515-528`) — a **soft cancel**. Lands in the Archive (`AllTasks.tsx:36`). | Visible in Archive, but **no restore UI exists**. `toggleDone` only un-does a `done` task. |
| 2 | `Planner.tsx:848` | Hard-deletes a **childless** plan block. | No — but no task is lost. |
| 3 | `Planner.tsx:904` | Hard-deletes a someday/concept block. | No — but no task is lost. |
| 4 | `RoutinesPanel.tsx:68` | **`DELETE FROM tasks WHERE subtype='quick'`** for members (`services/patterns.ts:351-366`). Quick member tasks are **destroyed**; standard/habit members survive (membership rows cascade only). | **NO — irreversible.** The only true data loss in this ticket. |
| 5 | `Tags.tsx:37` | Hard-deletes a tag. Affordance is already hidden for `is_base` or `used` tags (`Tags.tsx:83,124`), so only user-created unused tags are reachable. | No. |

Blocks: `DELETE /api/blocks/:id` (`routes/blocks.ts:335`) destroys the block but reverts its task to the open backlog (`revertedTaskIds`, REQ2) — so no task is lost.

## Non-goals

- **Do not introduce a new modal/dialog system.** Every confirm in this repo is native `confirm()` / `window.confirm()`. A branded `<ConfirmDialog>` is a separate refactor.
- **`PlannerEntityCard.tsx:231` is exempt (owner decision).** Removing a non-container block **unschedules** it — the task is re-staged to the flight-plan (`api.flightPlan.addTask`, toast *"Removed — sent back to the flight-plan"*). Nothing is destroyed, and it is the most frequent Planner gesture. Adding a prompt here was explicitly rejected. Its **container** branch delegates to `requestDeletePlan` and is covered by #2.
- **Do not touch the paths that already confirm:** `ObjectivesPanel.tsx:98` · `TimeBlocksPanel.tsx:38` · `FlightPlan.tsx:289` · `DayTypeManager.tsx:43` · `Settings.tsx:380` · `Planner.tsx:858` (clear-day) · `PlannerEntityCard.tsx:212` · `CategorySettings.tsx:63` · `Planner.tsx:590` `DeletePlanDialog`.
- **Do not remove** the existing edit-confirms at `TaskCard.tsx:283/288/294`. Over-confirmation, but removing them is a separate decision.
- `api.flightPlan.remove()` (`FlightPlan.tsx:132,192`, `Planner.tsx:829`) is unstaging, not deleting — out of scope.
- No soft-delete, trash bin, or undo. No server change.

## Pinned conventions

- **Guard shape:** `if (!confirm(\`…\`)) return;` as the **first statement**, before the `try`.
- **Copy style:** name the object, state the consequence. Existing: `TimeBlocksPanel.tsx:38` — ``Delete the "${t.name}" Time Block? Saved tasks won't come back.``
- **Error style:** `catch (err) { showToast((err as Error).message, 'error'); }` — unchanged.
- **`Tags.tsx` gotcha:** `run(p, ok)` takes an **already-constructed Promise** — `run(api.tags.remove(id), …)` fires the request eagerly. The guard **must** sit in `del` *before* the `run(...)` call; putting it inside `run` would confirm after deleting.
- **`Planner.tsx:845` gotcha:** only the `childCount === 0` branch is unguarded. The `childCount > 0` branch opens `DeletePlanDialog` — adding a prompt there would double-prompt.

## Before implementation

1. `server/src/services/patterns.ts:351-366` — the quick-task hard delete. This is why #4's copy matters most.
2. `server/src/services/tasks.ts:515-528` — `deleteTask` is a soft cancel.
3. `client/src/components/Planner.tsx:845-853` — the two branches of `requestDeletePlan`.
4. `client/src/views/Tags.tsx:25-37` — the eager `run` helper.
5. `client/src/components/TimeBlocksPanel.tsx:38` — the copy template.

## Files impacted

**Changed:**
- `client/src/components/TaskCard.tsx` — guard `remove()` (`:270`).
- `client/src/components/Planner.tsx` — guard the `childCount === 0` branch (`:847`); guard `del()` (`:902`).
- `client/src/components/RoutinesPanel.tsx` — guard `deletePattern()` (`:67`).
- `client/src/views/Tags.tsx` — guard `del()` (`:37`).

**New:** none. **Server:** untouched.

## Schema required

**None** — client-only.

## Definition of Done

- [ ] `TaskCard.remove()` prompts — e.g. ``Cancel "${title}"? It moves to the Archive.`` (must **not** promise restore).
- [ ] `Planner.requestDeletePlan()` prompts on the `childCount === 0` branch only — e.g. ``Delete "${plan.title}"?``
- [ ] `Planner.del()` prompts — e.g. ``Delete "${props.block.title}"?``
- [ ] `RoutinesPanel.deletePattern()` prompts and **names the irreversible consequence** — e.g. ``Delete the "${p.name}" routine? Its quick tasks are deleted permanently; other member tasks stay in your backlog.``
- [ ] `Tags.del()` prompts, with the guard **before** `run(...)` — e.g. ``Delete the "${tag.name}" tag?``
- [ ] Every guard is `if (!confirm(…)) return;` before the `try`.
- [ ] Declining leaves state untouched — no API call, no toast, no refetch.
- [ ] Accepting behaves exactly as today.
- [ ] `PlannerEntityCard.tsx:231` is **unchanged** (exempt).
- [ ] The 9 already-confirming sites are byte-unchanged.

## Tests

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter client test
```

- [ ] Tasks list → delete a task → prompt; Cancel → present, no toast; OK → cancelled + "Task cancelled" toast.
- [ ] Planner → delete a childless plan → prompt; Cancel → remains.
- [ ] Planner → delete a plan **with** children → `DeletePlanDialog` opens, **no** native prompt first.
- [ ] Planner → delete a someday block → prompt; Cancel → remains.
- [ ] Routines → delete a routine → prompt naming the quick-task loss; Cancel → routine + members intact.
- [ ] Tags → delete a tag → prompt; Cancel → **no request fired** (guards the eager-`run` trap).
- [ ] PlannerEntityCard → remove a task block → **no prompt**; task re-staged to the flight-plan (exemption holds).
- [ ] Grep proof: every `api.*.delete` / `api.tags.remove` site is either guarded, an intentional exemption, or a pre-existing dialog.

## Acceptance Criteria

- [ ] All 5 destructive paths confirm.
- [ ] The unschedule path stays one click.
- [ ] Copy matches verified semantics (cancel vs. hard delete vs. quick-task loss); nothing promises a restore that does not exist.
- [ ] No double-prompt on the container path.
- [ ] `tsc`, build, client tests clean. No new console errors.

## Subtasks

1. Guard `TaskCard.remove()` with cancel-accurate copy.
2. Guard the `childCount === 0` branch of `Planner.requestDeletePlan`.
3. Guard `Planner.del()`.
4. Guard `RoutinesPanel.deletePattern()`, naming the quick-task deletion.
5. Guard `Tags.del()` **before** the eager `run(...)`.
6. Confirm `PlannerEntityCard.tsx:231` is untouched and the container path does not double-prompt.
7. Re-grep every delete site; run tsc + build + tests.
