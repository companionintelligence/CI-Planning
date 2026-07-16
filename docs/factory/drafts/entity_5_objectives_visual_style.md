> **Type:** spike · **Phase:** ENTITY · **Branch:** `spike/objectives-in-planner` · **Commit style:** `docs(planner): decide how objectives render as block groupings` · **Design:** user feedback 2026-07-15 · **Dependencies:** none

## Why this is a spike and not a commit recipe

The owner asked: *"Objectives happen across multiple sessions. They are similar to timeblocks. Represent Objectives in the same way as a Time Block"*, and chose: **render an Objective as a container that groups its tasks' blocks in the Planner**, with the span derived from those child blocks so no new time fields are needed.

That is a coherent goal, but it **cannot be written as an executable recipe today** — four verified facts block it. Writing a fake recipe here would just push the guessing onto the implementing model.

### Verified blockers (branch `claude/local-backend-frontend-setup-77dae0`)

1. **Objectives have no time.** `server/src/db/schema.ts:648-669` — `objectives` has `target_date`, `horizon`, `cadence`, `status`, but **no `start_at` / `end_at`**. Only `blocks` carry those (`schema.ts:134-135`). There is nothing to place on a time axis.
2. **The Planner has never heard of objectives.** `grep -i objective client/src/components/Planner.tsx` → **zero matches**. There is also **no objectives store**: `client/src/stores/index.ts` exports none, and `ObjectivesPanel` fetches its own via `createResource(() => api.objectives.list())` (`ObjectivesPanel.tsx:51`). A data path into the Planner does not exist.
3. **The tree API returns no block linkage.** `GET /objectives` attaches `ObjectiveTaskSummary` per leaf (`api.ts:1066-1075`): `id, title, status, priority, due_at, scheduled_for, parent_id, completed_at`. It gives **task** ids and a `scheduled_for` **date** — never block ids or clock times. Mapping objective → blocks needs a client-side join against `blocks()` on `task_id`, or an API change.
4. **"Container" is already taken, and it is a real block.** In the Planner a container is a **block** with `block_kind === 'timeblock'`; children attach via `parent_block_id` (`Planner.tsx:61-131`, `lib/group-move.ts` → `resolveGroup` / `containerAt` / `clampGroupDelta`). Its geometry assumes one contiguous box owning its children.

### The design problem the spike must actually answer

An Objective's tasks' blocks are **arbitrary and non-contiguous** — 09:00 and 17:00 with unrelated work between. So a derived min→max span:

- swallows every unrelated block in between;
- **interleaves** with other Objectives' spans, which cannot nest;
- **collides** with `parent_block_id` containment — a task block already inside a Time Block container would sit inside two overlapping groupings at once.

Deriving a span is easy. Making it legible next to the existing container geometry is the hard part, and it is a **design** call, not an implementation detail.

## Goal

Produce a **decision** — with a throwaway prototype as evidence — for how Objectives read as groupings on the Planner day board, and emit a follow-up implementation ticket that *can* be written as a recipe.

## Non-goals

- **Ship no production behavior.** Any prototype code is throwaway and must not merge to `main`.
- **No migration**, no new columns on `objectives`, no time fields. If the chosen design needs them, that is the spike's *finding* — raise it, do not build it.
- Do not change `ObjectivesPanel`, the AF-6 picker, or the objectives tree API.
- Do not change `parent_block_id` container geometry or `lib/group-move.ts`.
- Not a styling refresh of the Objectives tab (that was the rejected alternative).

## Pinned conventions

- **Container geometry (read, do not modify):** `Planner.tsx:61-131` — the Plan-as-container model, the clamping rules, and the comment *"container box. Child task chips render in the task region to the right of it."* (`:84`).
- **Grouping helpers:** `client/src/lib/group-move.ts` — `resolveGroup`, `containerAt`, `clampGroupDelta`.
- **Objective→task data:** `api.objectives.list()` → `Objective.tasks: ObjectiveTaskSummary[]` on leaves (`api.ts:1065-1075`).
- **Task→block join:** `blocks()` rows carry `task_id` (`api.ts:418-420`) — the only available bridge from an Objective's tasks to placed blocks.
- **Leaf rule:** tasks link only to **leaf** objectives; the server rejects non-leaf links `422 non_leaf`. So only leaves can ever have blocks to group.

## Before implementation

1. `client/src/components/Planner.tsx:55-135` — the container model + clamping contract.
2. `client/src/lib/group-move.ts` — grouping/containment helpers in full.
3. `client/src/components/ObjectivesPanel.tsx:40-110` — how objectives + their tasks are fetched and rendered today.
4. `client/src/lib/api.ts:1058-1100` — `Objective`, `ObjectiveTaskSummary`, `ObjectiveNextAction`.
5. `server/src/db/schema.ts:648-690` — `objectives` + `objective_tasks`; confirm for yourself that no time columns exist.

## Files impacted

**New:**
- `docs/objectives-in-planner.md` — the decision record (the actual deliverable).

**Changed:** none in production code. Prototype work stays on the spike branch and is reverted or discarded before close.

## Schema required

**None** — the spike is explicitly forbidden from adding schema. If the chosen option requires it, that requirement is a **finding to report**, and the follow-up ticket owns the migration.

## Definition of Done

- [ ] `docs/objectives-in-planner.md` exists and evaluates **at least three** options against the four blockers, e.g.:
      **(a)** an all-day lane above the grid, one row per Objective with its tasks' blocks ticked along it;
      **(b)** a derived min→max spanning bar rendered *behind* the grid as a tinted band;
      **(c)** a non-geometric affordance — accent/badge on member blocks + hover-highlight of siblings — no box at all.
- [ ] Each option states: how the span is derived; what happens with **non-contiguous** blocks; what happens when two Objectives **interleave**; and how it coexists with `parent_block_id` containers.
- [ ] A **recommendation** with reasoning, plus a screenshot of the throwaway prototype for the recommended option.
- [ ] An explicit statement of whether the recommendation needs **schema or API changes** (and which).
- [ ] A statement of what happens for an Objective whose tasks have **no blocks on the viewed day** (the common case).
- [ ] A **follow-up implementation ticket** drafted under `docs/factory/drafts/` that *is* a commit recipe: real files, real line numbers, real DoD.
- [ ] Prototype code is **not** merged; `git diff main -- client/ server/` is empty at close.

## Tests

**N/A** — no production code ships. The prototype need not be tested; if a branch is left for reference it must not break:

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
```

## Acceptance Criteria

- [ ] The decision record answers all four blockers explicitly.
- [ ] A recommendation is made, evidenced by a prototype screenshot.
- [ ] Schema/API impact is stated plainly.
- [ ] A follow-up recipe-grade ticket is drafted.
- [ ] No production diff.

## Subtasks

1. Read the container geometry + grouping helpers; write down the containment contract in your own words.
2. Build the objective→task→block join client-side against `blocks()` and **measure the real data**: how often are an Objective's blocks non-contiguous? How often do two Objectives interleave on one day?
3. Prototype the two or three most promising options behind a throwaway flag.
4. Screenshot each; evaluate against the four blockers.
5. Write `docs/objectives-in-planner.md` with the recommendation.
6. Draft the follow-up implementation ticket.
7. Revert the prototype; confirm an empty production diff.
