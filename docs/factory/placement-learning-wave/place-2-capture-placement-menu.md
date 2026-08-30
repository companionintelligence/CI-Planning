> **Type:** Backend
> **Phase:** Placement-learning wave — G-INT (timing intelligence)
> **Branch:** `feat/placement-capture-menu`
> **Commit style:** `feat(engine): record what the scheduler chose and what it passed over`
> **Design:** [README.md](README.md)
> **Dependencies:** Ticket 1 (`0166_placement_evidence`)

## Goal

Open a `placement_log` row every time the Auto engine places a task block, recording **the
slot it chose and the menu of free gaps it passed over**. This is the capture half the loop
has never had: the correction in ticket 3 is meaningless without knowing what was available
when the choice was made.

New service `server/src/services/placement-learning.ts` (the peer of
`services/classification-learning.ts`), plus one hook in the Auto placement loop.

## Non-goals

- **Do not capture pattern or container placements.** `engine/patterns-place.ts`
  (`source_kind='pattern'`) and `engine/blocks-place.ts` (`source_kind='manual'`) also call
  `pickGap`. Both are out: routines carry explicit user-configured windows, and **both files
  are being rewritten on the unmerged branch `wip/patterns-place-pinning` (`8bad3350`)**.
  Do not import this service into either file.
- **Do not capture the stated-time path.** `autoplan.ts:1308` inserts an `is_auto=1,
  source_kind='agent'` block at a time the *owner stated*. The scheduler made no choice, so
  there is nothing to learn. Only the `pickGap` call site is hooked.
- **Do not capture `applyDayReflow` or `syncBlockFromTask` moves.** Those are covered in
  ticket 3's non-goals; this ticket touches neither file.
- **Do not read `placement_preferences`.** Nothing biases anything yet — that is ticket 5.
- **Do not change placement behaviour.** Which gap wins, in what order, with what break
  spacing, must be byte-identical before and after this ticket. The only permitted change to
  the INSERT is adding `RETURNING id`.
- **Do not add a flag, pref or env var to disable capture.** No `PLACEMENT_LEARNING`,
  `learning_enabled`, `capture_placements`. The house pattern has no dials; capture is
  unconditional and degrades by writing nothing when the table is unreachable.
- **Do not write to `time_blocks`, `tasks`, `daily_plan` or `flight_plan`.**
  `docs/archive/K-auto-defense.md` warns that "the reflow writes blocks, which could
  re-trigger task/block listeners" — a scheduling-table write from inside the placement loop
  is exactly that hazard. `placement_log` only.
- **Do not prune, cap or expire the log.** It is append-only durable evidence, like
  `classification_log` and `triality_log`. The 90-day window is applied at *read* time in
  ticket 4.
- **No new migration.** Ticket 1 landed the table.
- **No route, no client, no broadcast.** Nothing renders this yet.

## Pinned conventions

Verified against the tree — do not substitute.

- **Service shape.** Mirror `services/classification-learning.ts`: a block-comment header
  stating the contract, then exported named constants with a `/** why */` above each, then
  module-level SQL string constants, then the functions. SQL is declared at module level and
  `store().prepare(...)` is called *inside* the function — a module-level `store()` call
  throws when the module loads before `db/index` installs the backend
  (`calibrate-estimates.ts:18-20` states this explicitly).
- **Never throws.** `logPlacement` wraps its whole body in `try/catch` and logs
  `logger.warn('placement-learning: could not log placement', { err: (err as Error).message })`
  — byte-for-byte the `logAssignment` idiom (`classification-learning.ts:206-222`). A
  learning write must never be able to fail a placement.
- **Ids.** `newId()` from `../lib/ids.js`.
- **Timestamps.** `now.toISOString()`; `local_date` via `localDateInTZ(iso, tz)` from
  `../lib/tz.js`; `tz` via `ownerTimezone(owner)` from `../engine/recurrence-generate.js` —
  the exact trio `logAssignment` uses.
- **Local hour.** `utcToZonedWallTime(iso, tz)` (`lib/tz.ts:68`) returns `'HH:MM'`; the hour
  is `Number(wall.slice(0, 2))`. Whole hours only — a 20-minute nudge is not a time-of-day
  opinion.
- **Block id from the INSERT.** `autoplan.ts:351` currently uses `.run()` on
  `INSERT INTO time_blocks (...) VALUES (uuid7(), ...)`. Change it to append `RETURNING id`
  and read it with `ins.get<{ id: string }>(...)`, exactly as `blocks-place.ts:88-91`
  already does for the same table. Do not switch to a JS-side `newId()`.
- **Slot key.** `taskNestCoords(owner, taskId)` from `services/auto-nest.ts:214` — already
  imported by `autoplan.ts:37`, so no new import and no export change. Take
  `[...coords.directions].sort()[0] ?? '(none)'`: sorted for determinism (the underlying
  query has no `ORDER BY`), and the literal string `'(none)'` for an untagged task.
- **Menu snapshot timing.** `Gap.cursor` **mutates** as sessions pack in
  (`autoplan.ts:444`, `pick.gap.cursor = endMs + breakMs`). Snapshot `gaps` immediately
  *before* the `pickGap` call for that session, never after.
- **Owner scoping.** Every write carries `owner_id`; nothing reads across owners, ever.

## Before implementation

Read `services/classification-learning.ts` lines 1–60 (the contract header) and 206–222
(`logAssignment`), `engine/autoplan.ts` lines 351–355 (`insBlock`) and 415–455 (the
placement loop), `engine/scheduler.ts` lines 16–21 and 44–67 (`Gap`, `pickGap`),
`engine/blocks-place.ts` lines 88–92 (the `RETURNING id` precedent), and
`services/auto-nest.ts` lines 197–219 (`taskDirectionNames` / `taskNestCoords`).

## Files impacted

**New:**
- `server/src/services/placement-learning.ts`
- `server/test/placement-capture.test.ts`

**Changed:**
- `server/src/engine/autoplan.ts` — `insBlock` gains `RETURNING id`; the placement loop
  snapshots `gaps`, resolves the slot key, and calls `logPlacement` after each insert

## Schema required

None — ticket 1 landed `placement_log`. This ticket writes to it and to nothing else.

## Definition of Done

- [ ] `services/placement-learning.ts` exports `logPlacement`, `slotKeyFor`,
      `MAX_CANDIDATES_LOGGED` and `PLACEMENT_WINDOW_DAYS`
- [ ] `MAX_CANDIDATES_LOGGED = 12`, with a comment: it bounds one row's JSON, and a day with
      more than twelve free gaps is fragmented past the point where a preference is legible
- [ ] `logPlacement(owner, { blockId, taskId, slotKey, autoRunId, chosenStartAt,
      chosenEndAt, fit, candidates }, now?)` writes exactly one `placement_log` row with
      `moved_*` and `moved_at` NULL
- [ ] `candidates` is `JSON.stringify` of at most `MAX_CANDIDATES_LOGGED` entries shaped
      `{ s, e, c }` (epoch ms: gap start, gap end, gap cursor), in day order, snapshotted
      before the pick
- [ ] `fit` is `1` when `pick.len === want`, else `0`
- [ ] `slotKeyFor` resolves one task's key with a per-run `Map` cache, so a run placing N
      tasks issues at most N coordinate reads and never N per session
- [ ] `autoplan.ts` placement output is unchanged: same blocks, same times, same order
- [ ] `logPlacement` never throws; a dropped `placement_log` table logs a warning and the
      placement still succeeds

## Tests

New `server/test/placement-capture.test.ts`, modelled on
`server/test/classification-capture.test.ts` (including its
`ALTER TABLE ... RENAME TO ..._hidden` trick at lines 99–108 for the degradation test):

- [ ] An Auto run that places one task writes exactly one `placement_log` row, with
      `chosen_start_at` / `chosen_end_at` equal to the created block's times and `block_id`
      equal to its id
- [ ] `chosen_hour` is the OWNER-LOCAL hour — assert it under a non-UTC
      `scheduling_prefs.timezone`, not just UTC
- [ ] `candidates` parses to an array whose entries all have numeric `s`, `e`, `c`, and
      whose first entry's `c` equals the chosen start for a first-gap placement
- [ ] A day with more than 12 gaps writes exactly 12 candidate entries
- [ ] A task with a level-1 `direction` tag gets that name as `slot_key`; an untagged task
      gets `'(none)'`; a task with two directions gets the alphabetically first
- [ ] A placement that truncates (a task larger than every gap) writes `fit = 0`
- [ ] Two sessions of one split task write two rows, and the second row's `candidates`
      reflects the first session's advanced cursor
- [ ] With `placement_log` renamed away, `placeFlightPlan` still places blocks and does not
      throw
- [ ] `auto-placement.test.ts`, `auto-defense.test.ts`, `auto-overlap.test.ts`,
      `auto-nest.test.ts`, `reflow-wipe.test.ts` and `auto-undo.test.ts` all pass unchanged
      — the proof that placement behaviour did not move

```bash
pnpm --filter server exec vitest run test/placement-capture.test.ts
pnpm --filter server exec vitest run test/auto-placement.test.ts
pnpm --filter server exec vitest run test/auto-defense.test.ts
pnpm --filter server exec vitest run test/reflow-wipe.test.ts
pnpm --filter server exec vitest run test/auto-undo.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner with a staged task and a free day, when Auto places it, then one
      `placement_log` row exists whose `candidates` lists every gap the scheduler weighed
- [ ] Given the same fixtures, when Auto runs before and after this change, then the created
      `time_blocks` rows are identical in id-free comparison (times, tag, parent, status)
- [ ] Given a placement, then no row is written to `time_blocks`, `tasks`, `daily_plan` or
      `flight_plan` by the capture path
- [ ] Given `placement_log` is unwritable, when Auto runs, then placement succeeds and one
      warning is logged
- [ ] `git diff --stat` touches no file outside the four listed under **Files impacted**

## Subtasks

1. [ ] Read the six sources listed under **Before implementation**
2. [ ] Write `services/placement-learning.ts`: header contract comment, `MAX_CANDIDATES_LOGGED`,
       `PLACEMENT_WINDOW_DAYS = 90`, `slotKeyFor`, `logPlacement`, module-level `INSERT_LOG`
3. [ ] Add `RETURNING id` to `insBlock` and switch its call to `ins.get<{ id: string }>(...)`
4. [ ] In the placement loop: build a `Map` slot-key cache per run; snapshot `gaps` before
       each `pickGap`; call `logPlacement` after each successful insert
5. [ ] Write `placement-capture.test.ts` covering every case above
6. [ ] Run the six verification commands; confirm the five existing Auto suites are untouched
