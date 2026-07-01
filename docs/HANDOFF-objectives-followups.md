# Handoff — two objectives-layer follow-ups (from PR #189)

Self-contained brief for completing the two deferred, non-blocking items from the
task-list / strategic-layer work ([PR #189](https://github.com/companionintelligence/Companion-Planning/pull/189)).
Both are small and independent; do them in either order.

## Context you need

- **Objectives model** (Phase N + PR #189): one self-nesting `objectives` table.
  `level` is **derived server-side from tree height**, never stored by the client:
  a leaf that holds tasks = `objective`, a node whose children are objectives =
  `project`, a node whose children are projects = `goal`. Computed by
  `heightBelow(id)` → `levelFromHeight(h)` and re-stamped for the node **and its
  ancestors** on every create/re-parent/delete (`restampLevels`). All in
  [`server/src/routes/objectives.ts`](../server/src/routes/objectives.ts).
- **Containment rule** (already enforced server-side): tasks link only to leaf
  objectives (`POST /api/objectives/:id/tasks` rejects with 422 if
  `heightBelow(objId) > 0`); a node can't be re-parented under a **task-bearing**
  node (`PATCH` rejects 422). This is why the UI item below matters — the client
  can't currently tell which parents are legal, so it's trial-and-error.
- **Objective payload**: `GET /api/objectives` returns the tree via `buildTree()`;
  each node currently exposes `next_action`, `effective_target`, `pace_expected`,
  `children` — but **not** any leaf/height/task-bearing flag. The `Objective` TS
  interface is [`client/src/lib/api.ts`](../client/src/lib/api.ts) (~line 733).
- **Sync (Phase L)**: field-level LWW over an op-log. The allowlist +
  monotonic-guard live in [`server/src/sync/apply.ts`](../server/src/sync/apply.ts)
  (`TASK_FIELDS`, `BLOCK_FIELDS`, `applyMonotonic`, `stampRow`). Only `task` and
  `block` entities are synced today.

---

## Follow-up 1 — Parent-picker option-disabling (UX)

**Problem.** [`ObjectiveModal.tsx`](../client/src/components/ObjectiveModal.tsx)'s
Parent `<select>` (`parentOptions()`, ~line 60; the `<For>` ~line 143) offers
*every* other objective (minus self + its subtree). But the backend rejects
parents that are **task-bearing** (a leaf that already holds tasks — nesting under
it would create a "task-bearing non-leaf", forbidden). Today the user only finds
out via a 422 toast on Save → trial-and-error.

**Goal.** Make ineligible parents visibly un-selectable (disabled, with a reason),
so the hierarchy is legible up front.

**Recommended approach**
1. **Server** — expose the signal on the objective payload. In
   `buildTree()` ([objectives.ts](../server/src/routes/objectives.ts)) add per node:
   - `has_tasks: boolean` — `SELECT 1 FROM objective_tasks WHERE objective_id = ? LIMIT 1`
     (or reuse the count you already compute for progress), **and/or**
   - `height_below: number` — you already have `heightBelow(id)`; call it per node
     (bounded by tree size, same pattern as the existing per-node next_action loop).
   A parent is **eligible** iff it is not task-bearing (`!has_tasks`). (Height alone
   isn't sufficient — an empty leaf *is* a valid parent since nesting under it just
   makes it a project.)
2. **Client type** — add the field(s) to the `Objective` interface (`api.ts` ~733).
3. **Client UI** — in `ObjectiveModal.parentOptions()`, keep listing all non-self/
   non-descendant nodes but mark task-bearing ones: render the `<option>` with
   `disabled` and a suffix, e.g. `{title} · {level} — has tasks`. Solid renders
   `<option disabled>` fine.
4. **Belt-and-suspenders** — also translate the backend 422 into a human message in
   the modal's `save()` catch (currently it shows the raw error) — e.g. "Can't nest
   under 'X' because it already has tasks linked to it."

**Test.** Extend [`server/test/objectives.test.ts`](../server/test/objectives.test.ts):
assert `buildTree` marks a task-bearing objective with `has_tasks: true` and an
empty node `false`. (The 422 path is already covered.)

**Gotcha.** Don't disable *empty leaf* objectives — they're valid parents (nesting
promotes them to `project`). Only task-bearing nodes are illegal parents.

---

## Follow-up 2 — Objectives in the sync allowlist (multi-device)

**Problem.** `objectives` + `objective_tasks` are **not** synced. The 8-pointed
star + objective tree are server-derived and delivered via `GET` responses, so an
*online* device is correct, but: (a) an offline device that replays queued task ops
won't reconstruct objectives locally / won't get `objective:*` SSE; and (b) the new
`open⇄scheduled` task transitions are **not** monotonic-guarded
([apply.ts](../server/src/sync/apply.ts) `applyMonotonic` only pins `done`), so a
stale offline op carrying `status:'open'` can revert a server `scheduled` via
ordinary field-LWW.

**Decision needed first.** Objectives are largely a **server-derived read surface**
(auto-promotion, height-leveling, progress, GC all run server-side). Two viable
directions — pick based on how important true offline objective editing is:
- **(A) Minimal (recommended for v1):** don't sync the objective *tables*. Just
  harden the task-status LWW so placement isn't lost: in `applyMonotonic`, treat
  `scheduled` as protected against a regression to `open` **unless** the incoming
  op is newer AND explicitly reverting (mirror how `done` is handled). Document that
  objectives are online-derived. Smallest, safest change.
- **(B) Full sync:** add `objective` + `objective_task` to the sync entity types
  (`Op.entity`), allowlists, and `stampRow` maps in `apply.ts`; add `version`/
  `field_ts` columns to `objectives` (new migration, mirror
  [`0076_sync_versioning`](../server/src/db/migrations/0076_sync_versioning.ts));
  emit ops from `ensureTaskPromoted`/objective routes; teach the client op-log +
  IndexedDB about the new entity. Significantly larger; only worth it if users edit
  objectives offline.

**Where things live**
- Sync engine: [`server/src/sync/apply.ts`](../server/src/sync/apply.ts) (allowlist,
  `applyMonotonic`, `stampRow`), `server/src/agents/sync.ts` (op emission), the
  `sync_events` table (migs 0076–0079), client op-log/IndexedDB in `client/src/lib/`
  (grep `op-log` / `outbox`).
- Status writes that need protecting: `applyTaskPlacementStatus` /
  `revertTaskPlacementStatus` / `mirrorBlockStatusToTask` in
  [`server/src/services/block-task-sync.ts`](../server/src/services/block-task-sync.ts)
  (they already call `stampRow(...,['status'])`).

**Test.** Add a sync-merge test: a queued `{status:'open'}` op with a client
timestamp older than the server's `scheduled` stamp must NOT revert it (option A);
or a full round-trip objective op (option B), alongside the existing sync tests.

**Recommendation.** Ship **(A)** now (a few lines + one test) and leave (B) as a
future phase unless offline objective editing becomes a real requirement.

---

## Ground rules for this repo (so the handoff runs clean)
- Tests run **sequentially against a shared SQLite DB**; migrations run on import.
  Reproduce CI-only failures with `TZ=UTC`. Pin dates in tests (no `Date.now()`
  time-bombs). See prior test-harness notes.
- Verify with: `pnpm --filter server test`, `pnpm --filter client test`,
  `pnpm typecheck`. Migration head is **0086**; add new migrations at the end of
  [`server/src/db/migrations/index.ts`](../server/src/db/migrations/index.ts).
- Both migrations on this branch are **forward-only**; a data-reinterpretation
  migration (like 0085) warrants a release note.
