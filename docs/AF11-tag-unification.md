# AF-11 — Tag-model unification (tasks · timeblocks · routines)

**Status: PLANNED (scoped 2026-07-12 by read-only audit of merged main @ ee4e467). BUILD GATE: do not start until AF-CU2 and AF-10 are merged — they hold `client/src/lib/element.ts` and `client/src/components/TaskCard.tsx`.**

## Owner model (stated 2026-07-12)

- **Task**: one primary **direction** tag (level 1) + N **intention** tags (level 2).
- **Timeblock**: same model as tasks (AF-9 already ships this shape; parity gaps verified in Slice 2b).
- **Routine**: authors **no tags of its own** — it **inherits the union of its member tasks' tags**, and may carry **multiple direction tags** (members can span directions). Categories are unchanged (separate `category_id` axis, coexisting per AF-4).

## Why this is not cosmetic (scoping headlines)

1. **The server task write path is already done**: `POST/PATCH /api/tasks` accepts `secondary_tags` and levels it exactly like blocks (`applyTaskTagLevels`, services/tasks.ts:78-86). The server never classifies by tag kind — level is 100% which client array a name arrives in. The flat task shape is purely a client artifact (`element.ts` sends `tags: [primary, ...intentions]`).
2. **Live readers key on level 1**: `?tag=` filtering (routes/tasks.ts:76-78), autoplan Pass-1 Plan matching (autoplan.ts:743/664), NL hint windows (autoplan.ts:540), and LLM/deterministic day-authoring (agents/plan.ts theme/NL/clustering). Moving intentions to level 2 without compensation silently breaks intention-driven filtering, Plan matching, and authoring.
3. **A latent bug gets fixed**: category-Plan matching for tasks (`categoryCandidates`, autoplan.ts:191-199) reads level >1 and has **never matched a task** because intentions sit at level 1 — the code even comments the level-2 assumption. Unification makes Pass 1.5 work for tasks.
4. **All existing task data has intentions at level 1** (0033 backfill + the flat write path; no code ever wrote a task intention at level 2). A mixed old/new state is split-brain for scheduling and filters → **migration required**, not normalize-on-edit (AF-9's normalize-on-edit precedent was display-only; this isn't).
5. **Routine tags are denormalized display metadata**: written to `patterns.tag` + mirrored to `entity_tags(entity_kind='routine', level=1)` + stamped onto free-place container blocks (patterns-place.ts:262). Read load-bearing in ONE place (RoutinesPanel chip, RoutinesPanel.tsx:223). Routine *placement* matches on the Plan's tag and member tasks via `pattern_tasks` — never the routine's own tag. Promoted/habit routines are already created tag-less (routes/patterns.ts:197-202, patterns.ts:392-395).

## Decisions

| # | Decision | State |
|---|---|---|
| D1 | **Plan-matching semantics after the level move**: should an intention tag still pull a task into a same-named tagged Plan container (and into day-authoring clusters / NL matches)? **Recommended: yes — preserve behavior** by matching tasks on level 1 ∪ level 2 in the compensated readers (autoplan Pass 1 + hint windows + agents/plan.ts), with the existing `planTagWeights` dilution keeping directions dominant in ordering. Alternative: direction-only matching (behavior change: intentions only match category Plans). | **PENDING OWNER** — recommended default is preserve (L1 ∪ L2) |
| D2 | Routine inherited tags: **derived at read time** (batched 3-table union over `pattern_tasks ⋈ entity_tags ⋈ tags`), not stored — avoids the task-tag-edit → all-owning-routines fan-out hook. Precedent: `scheduledByTaskId` derived memo, `taskTagNamesByIds` batching. | DECIDED (scoping recommendation; owner model says "inherit", mechanism is implementation) |
| D3 | Legacy routine-authored tags: one-shot cleanup migration (`UPDATE patterns SET tag=NULL` + `DELETE FROM entity_tags WHERE entity_kind='routine'`) rather than leaving stale authored rows. Non-load-bearing post-Slice-4. | DECIDED (cleanliness; scoping option b) |

## Slices (each = one PR; 1–3 must ship together or behind one merge window)

### Slice 1 — Server reader compensation
**Goal:** intention-driven behavior survives the level move.
- `GET /api/tasks?tag=` matches level 1 ∪ `secondary_tags` (routes/tasks.ts:76-78).
- Per D1 (if preserve): task-side match set in autoplan Pass 1 (`tagsOf`/`staged.tags` consumers at :664/:743), `placeHintWindows` (:540), and agents/plan.ts (theme match, NL term match, clustering `groupKey`) becomes L1 ∪ L2 — keep `tags[0]`-style primary reads on L1 only.
**Tests:** `?tag=<intention>` finds L2-intention tasks; Plan with intention tag still receives matching staged task post-migration; direction windows (Pass 2a) and `placeStartAnchoredTask` unchanged (L1-direction only); category candidates unchanged.
**Files:** server/src/routes/tasks.ts, server/src/engine/autoplan.ts, server/src/agents/plan.ts, server tests.

### Slice 2 — Client task/habit split shape
**Goal:** wizard task/habit saves send `tags: [primary]` + `secondary_tags: [...intentions]` (reuse the `timeblockTagPayload` pattern, element.ts:95-105; task branch today at :190/:202).
- Also align the sibling flat-writers so they stop minting L1 intentions: `AllTasks.autoTagUntagged` (AllTasks.tsx:151) and quick-add enrichment (routes/tasks.ts:171 — direction-only or split).
- Verify edit-clear parity with blocks: clearing the direction on a task edit must empty L1 (blocks send `tag:null`; tasks use array semantics — assert, don't assume).
**Tests:** POST body shape; TaskCard renders intentions as ghost badges (TaskCard.tsx:502); Planner `createBlockAt` inherits the direction (Planner.tsx:797); edit-clear empties L1.
**Files:** client/src/lib/element.ts(+test), client/src/views/AllTasks.tsx, server/src/routes/tasks.ts (quick-add), client tests.

### Slice 2b — Timeblock parity check (verify-only, likely no-op)
Assert a block and a task with identical authored tags produce identical `entity_tags` level rows; block vs task direction-clear parity. **Files:** tests only, unless a gap surfaces.

### Slice 3 — Data migration (pair with Slice 2)
`UPDATE entity_tags SET level=2 WHERE entity_kind='task' AND level=1 AND tag_id IN (SELECT id FROM tags WHERE kind='intention')` — PK-safe (level not in key), owner-safe (tag ids owner-unique). Precedent for kind-aware reclassification: 0036. Next free migration number at build time (0118 taken by AF-3; check head).
**Tests:** idempotency; intention → L2, direction stays L1; `taskTagNames` unchanged for directions; post-migration autoplan Pass 1.5 matches a task by category via its L2 intention (the latent-bug fix, R4).

### Slice 4 — Routine inheritance (derived, per D2)
**Goal:** routines stop authoring tags; UI shows the derived union (multiple directions legal).
- Remove authored-tag writes: wizard routine comma-join (element.ts:238/:242), RoutinesPanel `#tag` input path (RoutinesPanel.tsx:433, :121-127); server `createPattern`/`updatePattern` stop mirroring to entity_tags (patterns.ts:281/:324) — accept-and-ignore `tag` input for API compat or reject, pick one and document.
- Add batched derived read (union query over pattern_tasks ⋈ entity_tags ⋈ tags, kind-classified: `directions[]` + `intentions[]`) exposed on the routine list/read API.
- Update the two readers: RoutinesPanel chip (:223) → multi-chip union; free-place container stamp (patterns-place.ts:262) → union or drop (decide in PR; container stamp is cosmetic).
**Tests:** union = distinct member directions (assert MULTIPLE); membership change updates it; tag-less promoted routine surfaces members' union; placement byte-identical (routine placement never read the routine tag — regression-assert a free-place and Plan-scoped place).
**Files:** client element.ts/RoutinesPanel.tsx, server patterns.ts/routes/patterns.ts/patterns-place.ts, tests.

### Slice 5 — Multi-direction rendering hardening
Single-atomic-string tag sites that a multi-direction union would break: `Planner.tsx:40`, `PlannerEntityCard.tsx:103/189/201` (incl. `t.tag === b.tag` equality filter), `Today.tsx:58`, `FlightPlan.tsx:304`; and guard `inheritContainerDirection` (tags.ts:213-226) which resolves the container tag to ONE direction — iterate names and inherit each known direction, or skip on multi. Calendar overlay already tolerates multiple directions if fed a proper list (overlay.ts:39-95) — the fix is upstream shape, not the overlay.
**Tests:** two-direction routine/container renders two chips; equality-filter sites behave; inheritContainerDirection with a two-direction container inherits both (or documented skip).

### Slice 6 — Legacy routine-tag cleanup migration (per D3)
`UPDATE patterns SET tag=NULL` + `DELETE FROM entity_tags WHERE entity_kind='routine'`.
**Tests:** post-migration a routine still shows the correct union (proves display is derived, not the nulled column).

## Sequencing & risks

- Build after AF-CU2 + AF-10 merge (file overlap on element.ts / TaskCard.tsx).
- Slices 1–3 are one atomic behavior change: **never ship Slice 2 without 1 + 3** (R1: intention filter dies; R2: intention Plan-matching/authoring dies; R3: split-brain old/new tasks).
- Slices 4–6 are independent of 1–3 and low-risk (one load-bearing reader), but Slice 5 gates Slice 4's multi-direction display from looking broken — land 5 with or before 4.
- Known positive behavior change to announce: category Plans start matching tasks (R4).
- Naming caution: do NOT rename `patternTagList`/related identifiers here — naming consolidation is a separate unsettled phase.
