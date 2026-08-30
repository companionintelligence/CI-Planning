> **Type:** Backend
> **Phase:** Placement-learning wave — G-INT (timing intelligence)
> **Branch:** `feat/placement-capture-correction`
> **Commit style:** `feat(blocks): close the placement log when the owner moves an auto block`
> **Design:** [README.md](README.md)
> **Dependencies:** Ticket 2 (`logPlacement`)

## Goal

Close the open `placement_log` row when the owner drags or resizes a block, recording where
they actually put it. This is the other half of capture: ticket 2 records what the scheduler
chose and what it passed over; this records the owner's answer.

One new exported function, `recordPlacementMove`, and one call site — `updateBlock`.

## Non-goals

- **Do not hook `applyDayReflow`** (`engine/day-reflow.ts:227`). That `UPDATE ... is_auto=0`
  applies a proposal the owner **confirmed**, i.e. the owner agreeing with the scheduler.
  Logging it as a correction would teach the exact opposite of the truth. Do not touch
  `day-reflow.ts` at all.
- **Do not hook `syncBlockFromTask`** (`services/block-task-sync.ts:312`). That mirrors a
  *task-side* time edit onto its block; the owner expressed an intent about the task, and the
  block followed. Do not touch `block-task-sync.ts`.
- **Do not hook `moveBlockGroup`** (`services/blocks.ts:762`). It shifts a Plan and every
  member by one delta and deliberately never flips `is_auto`. One gesture about a container
  is not per-block placement evidence. Do not touch it.
- **Do not add a filter to exclude those three.** They are excluded *structurally* — none of
  them calls `updateBlock`. Assert that with a test rather than defending it with a
  condition a later refactor could erode.
- **Do not reopen or re-close a settled row.** A second drag of the same block is a no-op,
  mirroring `recordCorrection`, which no-ops on an already-settled row
  (`classification-learning.ts:232-250`). The first move away from the scheduler's slot is
  the correction; later fiddling is the owner arranging their own day.
- **Do not open a new row here.** `recordPlacementMove` only ever closes an existing one. A
  block with no `placement_log` row (manually created, pattern-placed, pre-dating this wave)
  produces nothing.
- **Do not filter on `is_auto`.** The evidence attaches to *the engine chose this slot*,
  which is what the log row means. A row exists only because ticket 2 wrote one.
- **Do not learn from resizes.** A resize is recorded truthfully (`moved_end_at` moves,
  `moved_hour` does not) but expresses no time-of-day opinion; how long work takes is the
  estimate loop's job (`services/calibration.ts`). Do not add duration columns or a second
  learned quantity.
- **Do not change `updateBlock`'s return type, its guards, or its `updatedKeys`.** No new
  discriminated error, no new field on `UpdateBlockResult`.
- **No migration, no route, no client change, no broadcast.**

## Pinned conventions

Verified against the tree — do not substitute.

- **Hook point.** In `updateBlock` (`services/blocks.ts:601`), immediately before the
  Phase-L `stampRow` call near the end of the success path, guarded by the same condition the
  REQ2 mirror uses one line above: `if (input.start_at !== undefined || input.end_at !== undefined)`.
  Read the new times from the **returned row** (`block.startAt` / `block.endAt`), never from
  `input` — a PATCH may set only one of the two, and the row is authoritative.
- **Service placement.** `recordPlacementMove` goes in
  `server/src/services/placement-learning.ts` beside `logPlacement`, not in `blocks.ts`.
- **Never throws.** Whole body in `try/catch`, warning via
  `logger.warn('placement-learning: could not record move', { err: (err as Error).message })`
  — the `recordCorrection` idiom. Returns `boolean` ("a row was closed") for tests, like
  `recordCorrection` does.
- **Open-row selection.** `SELECT id, chosen_start_at FROM placement_log WHERE block_id = ?
  AND owner_id = ? AND moved_at IS NULL ORDER BY placed_at DESC, id DESC LIMIT 1`. Owner
  scoped even though `block_id` is already unique — defence in depth, matching
  `SELECT_OPEN_ASSIGNMENT`. `ORDER BY ... , id DESC` because uuid7 ties are random within a
  millisecond, so `placed_at` alone is not a total order.
- **Close statement.** `UPDATE placement_log SET moved_start_at = ?, moved_end_at = ?,
  moved_hour = ?, moved_at = ? WHERE id = ? AND moved_at IS NULL` — the `moved_at IS NULL`
  in the WHERE makes the settle-once rule atomic rather than a read-then-write race.
- **No-change guard.** If the returned `block.startAt` equals the row's `chosen_start_at`
  **and** `block.endAt` equals `chosen_end_at`, write nothing and return `false`. The owner
  touched it and left it where it was; that is not a decision to settle, so the row stays
  open and can still settle as an acceptance in ticket 4.
- **Local hour.** `moved_hour = Number(utcToZonedWallTime(block.startAt, tz).slice(0, 2))`,
  with `tz` from `ownerTimezone(ownerId)` — identical to ticket 2's `chosen_hour`.
- **Ordering vs. `syncTaskFromBlock`.** Place the call *after* the REQ2 mirror so a failing
  learning write can never be mistaken for a sync failure, and so `writeAudit` still runs
  last, unchanged.

## Before implementation

Read `services/blocks.ts` lines 601–748 (the whole of `updateBlock`, especially the REQ2
mirror and `stampRow` at the end), `services/classification-learning.ts` lines 232–250
(`recordCorrection` — the settle-once template), `services/placement-learning.ts` from
ticket 2, and `engine/day-reflow.ts` lines 219–255 plus `services/block-task-sync.ts` lines
276–322 to confirm for yourself that neither calls `updateBlock`.

## Files impacted

**Changed:**
- `server/src/services/placement-learning.ts` — add `recordPlacementMove` + its two SQL
  constants
- `server/src/services/blocks.ts` — one guarded call in `updateBlock`
- `server/test/placement-capture.test.ts` — the correction half

## Schema required

None — ticket 1 landed `placement_log` with `moved_start_at`, `moved_end_at`, `moved_hour`
and `moved_at` already nullable.

## Definition of Done

- [ ] `recordPlacementMove(ownerId, blockId, startAt, endAt, now?)` is exported and returns
      `Promise<boolean>`
- [ ] A `PATCH /api/blocks/:id` with a new `start_at` closes the block's open row with
      `moved_start_at`, `moved_end_at`, `moved_hour` and `moved_at` set
- [ ] A second `PATCH` on the same block changes nothing
- [ ] A `PATCH` that sets the same times leaves the row open and returns `false`
- [ ] A `PATCH` touching only `title` / `status` / `tag` writes nothing
- [ ] `updateBlock` behaviour, return shape and audit row are otherwise unchanged
- [ ] `recordPlacementMove` never throws

## Tests

Extend `server/test/placement-capture.test.ts`:

- [ ] Auto-place a task, then `updateBlock` its `start_at` to a different hour → the row is
      closed with the new hour
- [ ] The same, under a non-UTC `scheduling_prefs.timezone` → `moved_hour` is owner-local
- [ ] Move within the same hour (09:00 → 09:30) → the row closes and `moved_hour ===
      chosen_hour` (ticket 4 grades this an acceptance; this ticket only records it)
- [ ] Resize only (`end_at` changes, `start_at` does not) → the row closes with
      `moved_hour === chosen_hour`
- [ ] Two consecutive moves → exactly one closed row, holding the FIRST move's times
- [ ] A `PATCH` with identical times → row still open, `moved_at IS NULL`
- [ ] A title-only `PATCH` → row untouched
- [ ] A block with no `placement_log` row → `PATCH` succeeds, nothing written, nothing thrown
- [ ] **Structural exclusion:** `applyDayReflow` moving an auto block leaves its row open
- [ ] **Structural exclusion:** `syncBlockFromTask` (via a task time edit) leaves its row open
- [ ] **Structural exclusion:** `moveBlockGroup` leaves every member row open
- [ ] With `placement_log` renamed away, a `PATCH` still succeeds and does not throw
- [ ] `blocks-service.test.ts`, `blocks-place.test.ts` and `jobs-autoschedule-move.test.ts`
      pass unchanged

```bash
pnpm --filter server exec vitest run test/placement-capture.test.ts
pnpm --filter server exec vitest run test/blocks-service.test.ts
pnpm --filter server exec vitest run test/reflow-wipe.test.ts
pnpm --filter server exec vitest run test/jobs-autoschedule-move.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an auto-placed block at 09:00 and an owner who drags it to 19:00, when the PATCH
      completes, then its `placement_log` row holds `chosen_hour = 9` and `moved_hour = 19`
- [ ] Given the owner confirms a day reflow that moves the same block, then its row stays open
- [ ] Given a task's `task_time` is edited so its block follows, then its row stays open
- [ ] Given `placement_log` is unwritable, when a block is patched, then the PATCH returns
      200 and one warning is logged
- [ ] `git diff --stat` touches no file outside the three listed under **Files impacted**

## Subtasks

1. [ ] Read the four sources under **Before implementation**; confirm the three exclusions
       hold structurally
2. [ ] Add `SELECT_OPEN_PLACEMENT` and `CLOSE_PLACEMENT` SQL constants plus
       `recordPlacementMove` to `services/placement-learning.ts`
3. [ ] Add the one guarded call in `updateBlock`, after the REQ2 mirror and before `stampRow`
4. [ ] Extend `placement-capture.test.ts` with the thirteen cases above
5. [ ] Run the five verification commands
