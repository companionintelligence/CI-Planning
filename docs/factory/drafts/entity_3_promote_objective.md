> **Type:** feature · **Phase:** ENTITY · **Branch:** `feat/promote-task-to-objective` · **Commit style:** `feat(planner): promote a task to an objective` · **Design:** user feedback 2026-07-15 · **Dependencies:** none (ENTITY-4 depends on this)

> ### ⚠️ Ticket revised 2026-07-15 — the original design was based on a wrong analysis
> The original said manual promotion must **create a first subtask**, because a subtask-less objective would be garbage-collected. **That was wrong, and it was backwards.**
>
> `unpromoteIfEmpty(P)` is only ever called with `P` = the parent of a task being **deleted** (`services/tasks.ts:524`) or **re-parented away** (`:432`). A task that never has subtasks **never triggers it** — its objective is durable. Its only death is `dropSourceObjective` when the task itself is cancelled (`:523`), which is correct.
>
> So creating a placeholder subtask does not protect the objective — it **arms** the trigger. Cancelling that placeholder is exactly what deletes the objective. Measured on a live DB:
>
> | Step | Objective |
> |---|---|
> | first subtask created | ✅ created |
> | subtask marked **done** | ✅ survives (`unpromoteIfEmpty` counts `status != 'cancelled'`) |
> | only subtask **cancelled** | ❌ **GC'd** |
>
> **Revised decision (owner, 2026-07-15): direct promotion + a small server route.** One click, no prompt, no placeholder. This reverses the original "no new server route" non-goal, which only existed to serve the wrong analysis.

## Goal

Add a **"Promote to objective"** action to the Planner's entity card, beside the existing **"Promote to habit"**. Promoting gives the task its own leaf Objective so the owner can hang subtasks off it.

The promotion **machinery already exists**: `ensureTaskPromoted` (`server/src/services/task-promotion.ts:46`) creates a leaf Objective from a task, copies the title, links the parent + any subtasks, broadcasts, and audits. It fires automatically when a task gains a subtask (`services/tasks.ts:193`). It is simply **not reachable manually** — that is the only gap this ticket closes.

### The shape of the promoted result (answers the owner's question)

The promoted task **stays a top-level task and keeps its subtasks below it**. It does **not** become a subtask. The Objective is a *wrapper*: `objectives.source_task_id` points back at the task, and the parent + its subtasks link via the `objective_tasks` junction. There is no `tasks.objective_id` column — the `objective_id` on the task payload is derived (`task-promotion.ts:145`).

## Non-goals

- **No migration**, no new column, **no change to `task-promotion.ts` or its GC rules**. The route only exposes the existing service.
- **Do not** prompt for, or auto-create, a first subtask (see the revision note).
- **Do not** promote into an *existing* Objective (no picker) — promotion always creates the task's own leaf, keyed by `source_task_id`.
- **Do not** change task status, scheduling, or placement.
- Task-card (backlog) entry point is **ENTITY-4**.
- No change to `promoteHabit`.

## Pinned conventions

Verified against `origin/main`.

- **Route to mirror** — `POST /api/tasks/:id/promote-habit` (`server/src/routes/tasks.ts:278-288`): resolve `id` + `currentOwnerId()`, call the service, map failure to a status, set `ctx.body`.
- **Ownership-check idiom** — `routes/tasks.ts:323`:
  `if (!sqlite.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, owner)) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }`
- **`sqlite`** is already imported in `routes/tasks.ts:4`; `task-promotion.js` is already imported at `:18` (add `ensureTaskPromoted` to it).
- **No broadcast/audit in the route** — `ensureTaskPromoted` already emits `objective:created|updated`, `objective_task:updated`, `task:updated`, and `writeAudit`.
- **Client method** — mirror `api.ts:122` `promoteHabit: (id) => request<{task: Task}>('POST', \`/tasks/${id}/promote-habit\`, {})`.
- **Handler shape** — mirror `PlannerEntityCard.tsx:146-150` `promoteHabit()`: `const t = task(); if (!t) return;` → try/await → `showToast(..., 'success')` / `catch → showToast(msg, 'error')`.
- **Button row** — `PlannerEntityCard.tsx:368-370`, class `btn-ghost text-xs px-2 py-1`.
- **Icon** — `Target` from `lucide-solid`, the objective marker in use (`TaskCard.tsx:609`).
  > ⚠️ **Not `EightPointStar`** — `EightPointStar.tsx` exists but is imported nowhere (dead code from an earlier design).
- **`refetchTasks`** is already imported in `PlannerEntityCard.tsx`.

### Promotability guards (verified — do not guess)

`ensureTaskPromoted` returns `null` and does nothing when:
```ts
if (!parent || parent.subtype === 'quick' || parent.recurrence_parent_id) return null;
```
So the route returns **422 `not_promotable`** for those, and the button must be **hidden** for them — otherwise the owner clicks and nothing happens. Client `Task` carries `subtype?: 'standard'|'habit'|'quick'` and `recurrence_parent_id?`.

## Before implementation

1. `server/src/services/task-promotion.ts:41-91` — `ensureTaskPromoted`: guards, `source_task_id` idempotency, broadcasts.
2. `server/src/services/task-promotion.ts:93-131` — `isPristine` / `unpromoteIfEmpty` / `dropSourceObjective` — why direct promotion is durable.
3. `server/src/services/tasks.ts:432, 523-524` — the **only** GC call sites.
4. `server/src/routes/tasks.ts:274-290` and `:318-332` — the route + ownership idiom.
5. `client/src/components/PlannerEntityCard.tsx:140-160`, `:360-375`.

## Files impacted

**Changed:**
- `server/src/routes/tasks.ts` — add `POST /api/tasks/:id/promote-objective`; extend the task-promotion import.
- `client/src/lib/api.ts` — add `api.tasks.promoteObjective`.
- `client/src/components/PlannerEntityCard.tsx` — `promoteObjective()` + `promotable()` + the button; import `Target`.
- `server/test/task-promotion.test.ts` — route coverage.

**New:** none.

## Schema required

**None.** Uses `objectives` + `objective_tasks` as-is (Phase N, 0081/0086/0087).

## Definition of Done

- [ ] `POST /api/tasks/:id/promote-objective` returns `{ objective }` (200); **404** unknown/other-owner; **422 `not_promotable`** for quick / recurrence instances.
- [ ] Idempotent — promoting twice reuses the objective (`source_task_id`), never creates a second.
- [ ] The promoted task stays **top-level**; its subtasks stay below it.
- [ ] Button in the Planner action row with `<Target size={13} /> Promote to objective`, hidden when not promotable (container, habit, quick, recurrence instance).
- [ ] Success toast; errors via `showToast((err as Error).message, 'error')`.
- [ ] `promoteHabit` and the rest of the action row unchanged.
- [ ] No migration; `task-promotion.ts` untouched.

## Tests

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter server exec tsc --noEmit
pnpm --filter client build
pnpm --filter client test
pnpm --filter server test
```

- [ ] Promotes a subtask-less task to a leaf objective titled after it, with `source_task_id` set.
- [ ] Idempotent on repeat promotion.
- [ ] Promoted task stays top-level and keeps subtasks below it.
- [ ] Objective survives its only subtask being **completed**; documents that it is GC'd once the last subtask is **cancelled**.
- [ ] 422 for a `quick` task; 404 for an unknown id.
- [ ] Owner-scoped: another owner's task → 404, no objective created.
- [ ] Browser: button appears in the Planner card, click promotes, toast shows, objective appears in the tree; button hidden for a habit.

## Acceptance Criteria

- [ ] Manual promotion works end-to-end and is durable (no placeholder subtask).
- [ ] Button hidden for every case the server refuses.
- [ ] Both suites + both typechecks + build clean. No new console errors.

## Subtasks

1. Read `task-promotion.ts` and the two GC call sites; confirm the durability claim.
2. Add the route mirroring `promote-habit`; extend the import.
3. Add `api.tasks.promoteObjective`.
4. Add `promoteObjective()` + `promotable()` + the button; import `Target`.
5. Extend `server/test/task-promotion.test.ts` (200 / idempotent / top-level / GC / 422 / 404 / owner-scope).
6. Browser-verify the Planner card; run both suites.
