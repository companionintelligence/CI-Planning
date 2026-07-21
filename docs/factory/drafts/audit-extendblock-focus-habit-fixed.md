> **Type:** Backend
> **Phase:** Post-audit hardening (2026-07-20 handoff)
> **Branch:** `fix/extend-block-focus-habit-fixed`
> **Commit style:** `fix(engine): treat focus/habit blocks as fixed obstacles in extend-block`
> **Design:** this ticket is the spec (flagged in `#392` dead-surface comments + `docs/HANDOFF-2026-07-20-audit-followups.md` "Repo facts worth carrying")
> **Dependencies:** None

## Goal

`block_kind` is free-form TEXT on the write path by design (`block.graphql`), so an API
caller can create `focus` / `habit` / `break` / `buffer` blocks today even though no UI
produces them. `extendBlock`'s `isFixed()` predicate
(`server/src/engine/extend-block.ts:75`) only recognizes `meeting` / `timeblock` /
locked / running / `in_progress`, so a "Keep working" extension would **silently push a
`focus` or `habit` session** — a reachable correctness edge. Make `focus` and `habit`
blocks count as fixed obstacles (never silently displaced; the extension escalates to
`blockedBy` instead), and include them in the obstacle query so they actually surface.

## Non-goals

- Do **not** change `block_kind` to an enum or add a `CHECK` constraint — free-form TEXT
  is the deliberate design (`block.graphql:11-15`). This is a runtime-predicate fix only.
- Do **not** add UI to create focus/habit blocks, or change how the client builds blocks.
- Do **not** change move-group / container semantics, `break`/`buffer` handling, or the
  reflow engine. Scope is `extendBlock` obstacle detection only.
- Do **not** add a migration or touch schema.
- Decide `break` / `buffer` explicitly: they are **loose** (movable) and stay movable —
  do not add them to the fixed set. Only `focus` and `habit` become fixed.

## Pinned conventions

- `isFixed(r: Row)` at `server/src/engine/extend-block.ts:75-83` returns true for
  `block_kind === 'meeting' || block_kind === 'timeblock' || is_locked === 1 ||
  is_running === 1 || status === 'in_progress'`. Add `block_kind === 'focus'` and
  `block_kind === 'habit'` to that OR-chain.
- The obstacle query (`subsequent`, `extend-block.ts:120-135`) only selects rows where
  `is_locked = 1 OR block_kind = 'meeting' OR block_kind = 'task' OR (block_kind =
  'timeblock' AND block_type = 'scheduled')`. A `focus`/`habit` block that isn't matched
  here never enters the loop, so `isFixed` alone is insufficient — **also add
  `OR block_kind = 'focus' OR block_kind = 'habit'`** to this WHERE so they surface as
  obstacles. Keep the existing `status NOT IN ('completed','skipped','cancelled')` and
  `parent_block_id IS NULL` filters unchanged.
- Full block_kind vocabulary (per `block.graphql:13`): `task/meeting/habit/focus/break/
  buffer/timeblock`.
- Update the `⚠️ Reachable edge (see #392)` comment block above `isFixed`
  (`extend-block.ts:71-74`) to state the edge is now closed for focus/habit, and note
  break/buffer remain intentionally movable.

## Before implementation

- Read `server/src/engine/extend-block.ts` in full — the doc comment (56–70), the
  `#392` warning (71–74), `isFixed` (75–83), and the `subsequent` obstacle query
  (120–135) are all in scope.
- Find the existing extend-block test file (grep `extend-block` / `extendBlock` under
  `server/src`) and match its harness for seeding `time_blocks` rows.

## Files impacted

- **Changed:** `server/src/engine/extend-block.ts` — `isFixed()` OR-chain (+focus/habit);
  the `subsequent` obstacle-query WHERE (+focus/habit); the `#392` comment.
- **Changed:** the extend-block test file (add cases below).

## Schema required

None.

## Definition of Done

- [ ] `isFixed()` returns true for `block_kind === 'focus'` and `block_kind === 'habit'`.
- [ ] The `subsequent` obstacle query includes `focus` and `habit` blocks so they enter
      the cascade loop and are seen by `isFixed`.
- [ ] Extending a block into a following `focus` (or `habit`) block sets `blockedBy` to
      that block and does **not** move it (`fits === false`, empty `movedSet` past it).
- [ ] `break` and `buffer` blocks remain movable (regression-guarded).
- [ ] The `#392` comment is updated to reflect the closed edge.
- [ ] `pnpm --filter server typecheck` and `pnpm --filter server test` pass.

## Tests

- [ ] Extending a task block whose end runs into a later `focus` block → result has
      `blockedBy = { block_id, title, start_at }` of the focus block, `fits === false`,
      and the focus block is not in `movedSet`.
- [ ] Same for a later `habit` block.
- [ ] Control: a later loose `task` block with a gap is still pushed (no regression to the
      normal cascade).
- [ ] Control: `break`/`buffer` are treated as loose (not added to the fixed set) — or, if
      unreachable via the query, document why; the point is they are NOT falsely fixed.

```
pnpm --filter server typecheck
pnpm --filter server test
```

## Acceptance Criteria

- [ ] Given a `focus` block starting inside the extension window, When `extendBlock` runs,
      Then it reports `blockedBy` that block and leaves it in place.
- [ ] Given a `habit` block in the same position, Then the same blocking behavior.
- [ ] Given a loose `task` block, Then existing push/cascade behavior is unchanged.

## Subtasks

1. [ ] Add `focus`/`habit` to the `subsequent` obstacle-query WHERE clause.
2. [ ] Add `focus`/`habit` to the `isFixed()` OR-chain.
3. [ ] Update the `#392` warning comment (edge closed; break/buffer intentionally loose).
4. [ ] Add the focus + habit blocking tests and the task-cascade regression control.
5. [ ] Run server typecheck + test.
