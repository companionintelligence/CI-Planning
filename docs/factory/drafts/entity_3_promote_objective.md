> **Type:** feature · **Phase:** ENTITY · **Branch:** `feat/promote-task-to-objective` · **Commit style:** `feat(planner): promote a task to an objective` · **Design:** user feedback 2026-07-15 · **Dependencies:** none (ENTITY-4 depends on this)

## Goal

Add a **"Promote to objective"** action to the Planner's entity card, beside the existing **"Promote to habit"**. Promoting turns a task into a strategic unit the owner can hang subtasks off.

**The server already implements all of this.** `ensureTaskPromoted` (`server/src/services/task-promotion.ts:46`) creates a leaf Objective from a task, copies the title, and links the parent + its subtasks. It is already invoked whenever a task **gains a subtask** (`server/src/services/tasks.ts:193`). This ticket is a **client-only** manual trigger for machinery that exists.

### The shape of the promoted result (answers the owner's question)

The promoted task **stays a top-level task and keeps its subtasks below it**. It does **not** become a subtask of anything. The Objective is a *wrapper*: `objectives.source_task_id` points back at the task, and both the parent and its subtasks are linked to the Objective via the `objective_tasks` junction. There is no `tasks.objective_id` column — the `objective_id` on the task API payload is derived by `firstObjectiveByTaskIds` (`task-promotion.ts:145`).

### Why this creates a first subtask (owner decision, 2026-07-15)

`unpromoteIfEmpty` (`task-promotion.ts:107`) **deletes** a promoted Objective once the parent has no active subtasks left, provided the Objective is still *pristine* (top-level, no child objectives). So promoting a subtask-less task would produce an Objective that silently evaporates on the next subtask churn.

**Decision: manual promotion creates the objective by creating its first subtask.** This sidesteps the GC without a migration and needs no new column, endpoint, or service — because `createTask` already promotes the parent when `parent_id` is set.

**Therefore the whole action is:** `api.tasks.create({ title, parent_id })` → the server promotes the parent. That is the entire mechanism.

## Non-goals

- **No new server route.** Do **not** add `POST /api/tasks/:id/promote-objective`. `createTask` already calls `ensureTaskPromoted`.
- **No migration**, no new column, no change to `task-promotion.ts` or its GC rules.
- **Do not** promote into an *existing* Objective (no picker) — promotion always creates the task's own leaf Objective, keyed by `source_task_id`.
- **Do not** change task status, scheduling, or placement.
- Task-card (backlog) entry point is **ENTITY-4**, not this ticket.
- No change to `promoteHabit`.

## Pinned conventions

Branch `claude/local-backend-frontend-setup-77dae0`.

- **Insertion point:** `client/src/components/PlannerEntityCard.tsx:368-370` —
  ```tsx
  <Show when={task() && !task()!.is_habit && !isContainer()}>
    <button onClick={promoteHabit} class="btn-ghost text-xs px-2 py-1"><Repeat size={13} /> Promote to habit</button>
  </Show>
  ```
  Add the new button in the same action row, same `class="btn-ghost text-xs px-2 py-1"`.
- **Handler shape:** mirror `promoteHabit` (`PlannerEntityCard.tsx:146-150`):
  ```ts
  async function promoteHabit() {
    const t = task(); if (!t) return;
    try { await api.tasks.promoteHabit(t.id); showToast(`"${t.title}" is now a habit`, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  ```
- **API to call:** `api.tasks.create(body: TaskInput)` (`client/src/lib/api.ts:97`); `TaskInput.parent_id?: string`.
- **Icon:** `Target` from `lucide-solid` — the objective marker actually in use on this branch (`TaskCard.tsx:609`, `<Target size={15} />`, title *"Add to objective"* / *"In an objective — manage"*). Use it, do not invent a new glyph.
  > ⚠️ **Do not use `EightPointStar`.** `client/src/components/EightPointStar.tsx` exists but is **imported nowhere** — it is dead code from an earlier design (only `DayStarsRow.tsx:16` mentions it, in a comment contrasting the 5-point day star). An earlier revision of this draft pinned it, and pinned it as `.js`; both were wrong. Reviving it here would reintroduce a retired glyph and diverge from the task card.
- **Prompt style:** `prompt('…')?.trim()` then early-return on empty — matches `TaskCard.newRoutineWithTask` (`const name = prompt('New routine name')?.trim(); if (!name) return;`).
- **Refetch:** `refetchTasks()` / `refetchBlocks()` per the surrounding handlers.

### Promotability guards (verified in `task-promotion.ts:46-52` — do not guess)

`ensureTaskPromoted` **returns `null` and does nothing** when:
```ts
if (!parent || parent.subtype === 'quick' || parent.recurrence_parent_id) return null;
```
So the button **must be hidden** for `quick`-subtype tasks and recurrence instances, or the owner clicks it and silently gets a stray subtask with no Objective. Mirror the existing habit guard and extend it.

## Before implementation

1. `server/src/services/task-promotion.ts:1-91` — the promotion contract, especially the `:46-52` guards and the `source_task_id` idempotency.
2. `server/src/services/task-promotion.ts:107-119` — `unpromoteIfEmpty`, i.e. why the first subtask matters.
3. `server/src/services/tasks.ts:185-196` — `createTask`'s `if (parentId) ensureTaskPromoted(parentId, ownerId);`.
4. `client/src/components/PlannerEntityCard.tsx:140-160` and `:360-375` — handler + action-row conventions.
5. `client/src/lib/api.ts:97` + the `TaskInput` type — confirm `parent_id` round-trips.

## Files impacted

**Changed:**
- `client/src/components/PlannerEntityCard.tsx` — add `promoteObjective()` handler + its button; import `Target` from `lucide-solid`.

**New:** none. **Server:** untouched.

## Schema required

**None.** Uses `objectives` + `objective_tasks` as they exist (Phase N, migrations 0081/0086/0087). No new columns, no new indexes.

## Definition of Done

- [ ] `promoteObjective()` added to `PlannerEntityCard.tsx`, mirroring `promoteHabit`'s shape:
      prompt for the first subtask title → `api.tasks.create({ title, parent_id: t.id })` → `refetchTasks()` → success toast.
- [ ] Empty/cancelled prompt → no API call, no toast.
- [ ] Button rendered in the action row at `:368-370` with `<Target size={13} /> Promote to objective`.
- [ ] Button hidden when: the entity is a container, the task is a habit, `subtype === 'quick'`, or `recurrence_parent_id` is set (the `ensureTaskPromoted` no-op set).
- [ ] After promotion, the task’s objective marker (`Target`) reads as linked and the new Objective appears in **Tasks → Objectives** (`ObjectivesPanel`) titled with the task's title.
- [ ] The promoted task remains **top-level** (its `parent_id` is unchanged/null) with the new subtask **below** it.
- [ ] Promoting twice reuses the same Objective (`source_task_id` idempotency) — it does not create a second.
- [ ] Errors surface via `showToast((err as Error).message, 'error')`.
- [ ] `promoteHabit` and every other action-row button behave exactly as before.

## Tests

Verification commands (must pass):

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter client test
pnpm --filter server test
```

Cases:

- [ ] Planner → select a plain task block → "Promote to objective" is visible.
- [ ] Click → prompt → enter a subtask title → Objective created, task marked as in-an-objective, subtask nested under the task.
- [ ] Click → prompt → Cancel → nothing created, no toast.
- [ ] Objectives tab shows the new Objective with the parent + subtask linked.
- [ ] Promote the same task again → same Objective reused (count of objectives unchanged).
- [ ] Remove the only subtask → confirm the Objective survives **or** document the observed GC behavior; if it is GC'd, the first-subtask decision has failed and must be raised, not silently accepted.
- [ ] Button hidden for a habit task, a container, a `quick` task, and a recurrence instance.
- [ ] `promoteHabit` still works.

## Acceptance Criteria

- [ ] Manual promotion works end-to-end with **no server change**.
- [ ] Promoted task stays top-level with subtasks beneath it.
- [ ] Idempotent on repeat promotion.
- [ ] Button correctly hidden for the four non-promotable cases.
- [ ] `tsc`, client build, client + server tests clean.
- [ ] No new console errors.
- [ ] Screenshot proof: Planner action row, and the resulting Objective in the Objectives tab.

## Subtasks

1. Read `task-promotion.ts` and `services/tasks.ts:193` to internalize the contract.
2. Add `promoteObjective()` to `PlannerEntityCard.tsx` beside `promoteHabit` (`~:146`).
3. Add the button to the action row (`~:368`) with the promotability guard.
4. Import `Target` from `lucide-solid` (NOT `EightPointStar` — dead code, see Pinned conventions).
5. Verify idempotency + the four hidden cases by hand.
6. Verify the Objective appears in `ObjectivesPanel` and the task’s `Target` marker reads as linked.
7. Run tsc + builds + both test suites; capture screenshots.
