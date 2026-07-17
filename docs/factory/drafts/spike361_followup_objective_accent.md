> **Type:** feature · **Phase:** ENTITY · **Branch:** `feat/planner-objective-accent` · **Commit style:** `feat(planner): mark which objective a block serves` · **Design:** [`docs/objectives-in-planner.md`](../../objectives-in-planner.md) (spike [#361](https://github.com/companionintelligence/Companion-Planning/issues/361)) · **Dependencies:** none

## Goal

Make it visible, on the Planner day grid, **which Objective a task block serves** — by tinting the
member chip's left edge with a per-objective colour. Nothing else.

This is step 1 of the two-step path the #361 spike recommends (**option (c)**). It is deliberately
the *non-geometric* half: no box, no band, no rail, no span. The spike measured a derived
min→max span at **25–29% density**, **swallowing other objectives' blocks**, and **interleaving**
so that two spans cannot nest — see [`docs/objectives-in-planner.md`](../../objectives-in-planner.md) §3.
**Do not draw a span in this ticket.**

## Non-goals

- **No spanning band, no rail, no box, no grouping geometry.** `geometryAdded` must stay 0. The
  focused rail is a *later, separate* ticket, and only after this is in front of the owner.
- **No migration, no schema.** `objectives` gets no `start_at`/`end_at`. The spike proved none is
  needed.
- **No API change.** `GET /objectives` + the existing `blocks()` store are sufficient; the join is
  client-side on `task_id`.
- **Do not touch** `ObjectivesPanel`, the AF-6 picker, the objectives tree API,
  `lib/group-move.ts`, or `parent_block_id` container geometry.
- Do not add an empty-state stub for objectives with no blocks today — they must render **nothing**
  (see DoD).

## Pinned conventions

All line numbers are on `main` @ `e9939b0` (migration head 0131), re-verified after rebase.
⚠️ They drift: the plan-week work (#337–#341) moved `ObjectiveTaskSummary` by 27 lines between the
spike and this rebase. **Re-grep before trusting any anchor below** — a stale citation is exactly
what made the parent ticket's blockers hard to act on.

- **The join, proven by the spike's prototype:** the tree gives **task ids** per leaf
  (`ObjectiveTaskSummary`, [`client/src/lib/api.ts:1105`](../../../client/src/lib/api.ts#L1105) —
  `id, title, status, priority, due_at, scheduled_for, parent_id, completed_at`; **no block ids,
  no clock times**). `blocks()` rows carry `task_id`. Join in memory; that is the only bridge.
- **The leaf rule:** tasks link only to **leaf** objectives — the server rejects a non-leaf link
  with `422 non_leaf` ([`server/src/services/objectives.ts:868`](../../../server/src/services/objectives.ts#L868)).
  So only leaves can have blocks; walk the tree to leaves.
- **⭐ The store to mirror exactly** — `concepts`, [`client/src/stores/index.ts:81-86`](../../../client/src/stores/index.ts#L81):
  ```ts
  export const [concepts, { refetch: refetchConcepts }] = createResource(() =>
    api.blocks.listConcepts().then((r) => r.blocks)
  );
  on('block:created', () => refetchConcepts());
  on('block:updated', () => refetchConcepts());
  on('block:deleted', () => refetchConcepts());
  ```
- **The list call:** `api.objectives.list()` → `{ objectives: Objective[] }`
  ([`api.ts:460`](../../../client/src/lib/api.ts#L460)). It returns the **live tree only** —
  archived rows never appear (archive is an `archived_at` **column**, per #366), so **do not add an
  archive filter**, and never test `status === 'archived'`.
- **The events to refetch on:** the server already broadcasts `objective:created` /
  `objective:updated` / `objective:deleted`, and link/unlink broadcast `objective:updated`
  ([`server/src/routes/objectives.ts:124,134`](../../../server/src/routes/objectives.ts#L124)).
  `on()` takes a plain `string` ([`client/src/lib/sse.ts:83`](../../../client/src/lib/sse.ts#L83)) —
  no type union to extend.
- **⭐ The exact insertion point for the accent** — [`client/src/components/Planner.tsx:506`](../../../client/src/components/Planner.tsx#L506),
  inside `PlannerChip`'s inline `style`:
  ```tsx
  ...(completed() ? doneHatchStyle(tag()) : {}),
  ...(glow() ? { '--done-glow': `color-mix(in srgb, ${color()} 55%, transparent)` } : {}),
  ```
  Append one more spread after these. The chip already draws `border-l-[3px] border-l-primary`
  via `classList` (`:495-496`) — **the accent must not fight it**; use `box-shadow: inset` (what
  the prototype used) or explicitly override the left border, and check both the `isNextUp` and
  non-`isNextUp` cases.
- **Colour tokens:** `--chart-1`…`--chart-5` (`client/src/index.css:35-39`, dark overrides at
  `:107+`). ⚠️ `--chart-1` is `#58ebbf` in dark — the **same mint** the P3 chip and the TaskCard
  footer already use. Cycling a palette that starts at `chart-1` will collide with that meaning;
  pick the cycle order (or a dedicated token set) with that in mind and call it out in the PR.

## Before implementation

1. [`docs/objectives-in-planner.md`](../../objectives-in-planner.md) — the decision record, in
   full. §3 is why there is no band.
2. `client/src/components/Planner.tsx:51-79` (the Plan-as-container contract) and `:490-510`
   (`PlannerChip`'s classList + style).
3. `client/src/stores/index.ts:81-96` — the resource + SSE-refetch idiom.
4. `client/src/lib/api.ts:1105-1150` — `ObjectiveTaskSummary` / `Objective`.
5. The archived prototype (spike session scratchpad, `Spike361ObjectiveOverlay.tsx.reference`) —
   the join + accent already exist there in working form; lift the logic, drop the band/rail.

## Files impacted

**Changed:**
- `client/src/stores/index.ts` — new shared `objectives` resource + `objectiveOfBlock` memo.
- `client/src/components/Planner.tsx` — one style spread in `PlannerChip` (+ import).

**New:**
- `client/src/lib/objective-accent.ts` — pure: `objectiveOfBlock(objectives, blocks)` →
  `Map<blockId, {id, title, colourIndex}>`, and the stable id→index hash. Pure so it is unit-
  testable without the DOM (mirrors `lib/group-move.ts`'s "pure, unit-tested in isolation" rule).

**Explicitly NOT changed:** `ObjectivesPanel.tsx` (it keeps its own local `createResource` for now
— migrating it to the shared store is a separate cleanup), `lib/group-move.ts`, any server file,
any migration.

## Schema required

**None.**

## Definition of Done

- [ ] A shared `objectives` resource exists in `client/src/stores/index.ts`, refetching on
      `objective:created` / `objective:updated` / `objective:deleted`.
- [ ] A task block whose task is linked to a leaf objective renders that objective's accent.
- [ ] **Two blocks of the same objective carry the same accent even when non-contiguous** (09:00
      and 15:00 → identical colour).
- [ ] **A block nested in a Plan container (`parent_block_id` set) still shows its accent** — the
      spike's double-containment case; identity and containment must not fight.
- [ ] A block with no objective (and a block with no `task_id` at all — break/buffer) renders
      **unchanged**.
- [ ] **An objective with no blocks on the viewed day renders nothing** — no stub, no lane, no
      placeholder. (At time of writing this is the *only* case in real data: **zero**
      objective↔task links exist in any local DB — see the decision record §2.)
- [ ] **No geometry is added**: no element is introduced for an objective; the accent is a property
      of an existing chip. Assert `document.querySelectorAll('[data-objective-band],[data-objective-rail]').length === 0` is trivially true because no such thing is built.
- [ ] The accent does not break the `isNextUp` ring or the `completed()` hatch.
- [ ] `git diff main -- server/` is empty.

## Tests

Unit (`client/test/objective-accent.test.ts` — pure, no DOM):

- [ ] `objectiveOfBlock` maps a block to its objective via `task_id` → `objective.tasks[].id`.
- [ ] **Non-contiguous members map to the same objective** (the 09:00/15:00 pair).
- [ ] A block whose task serves **two** objectives (the M:N `objective_tasks` case — a task *may*
      serve multiple objectives, per `0081_objectives.ts:11`) resolves **deterministically**, not
      by array order. ⚠️ Decide and pin this: the spike's prototype used first-match, which is a
      latent bug. Lowest-id or an explicit "multiple → no accent" are both defensible; pick one and
      test it.
- [ ] A block with `task_id: null` → no entry.
- [ ] Only **leaf** objectives contribute (a parent with children carries no tasks).
- [ ] The id→colour hash is **stable** across calls and independent of tree order.

Suites to keep green:

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] Which objective a block serves is readable at a glance on the Planner.
- [ ] No span, band, rail, or box exists anywhere in the diff.
- [ ] No migration; no server diff; no API change.
- [ ] The multi-objective tie-break is pinned and tested.

## Subtasks

1. Add the shared `objectives` store (mirror the `concepts` idiom exactly).
2. Write `lib/objective-accent.ts` pure + its unit tests **first** (the tie-break decision lands here).
3. Wire one style spread into `PlannerChip`; reconcile with the existing `border-l-[3px]`.
4. Verify against the spike's scenario: non-contiguous pair, a nested-in-Plan member, an unrelated
   block, and an objective with no blocks today.
5. Screenshot the result on the PR (real UI this time — the spike committed no images on purpose).
