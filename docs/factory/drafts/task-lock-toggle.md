> **Type:** Backend + Frontend
> **Phase:** Follow-up — balance-targets wave (owner request 2026-08-29)
> **Branch:** `feat/task-lock-toggle`
> **Commit style:** `feat(tasks): lock/unlock toggle on the task modal`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Surface a lock toggle on the **task** tab of the edit modal, mirroring the one that
already exists on the **timeblock** tab (`ElementWizard.tsx:1503-1508`). Toggling it
locks or unlocks the task's current active placed block, so the owner can protect a
specific instance of a task from auto-reflow the same way they can for a standalone
time block — without opening the block separately or knowing it exists.

`time_blocks.is_locked` and everything that honors it (obstacles, reflow, clear-range,
review sweep, `reconcilePriorPlacement`) already exist and are untouched by this
ticket. `services/blocks.ts:updateBlock` already accepts `is_locked` in its input and
`PATCH /api/blocks/:id` already wires it through. The gap is purely: the task modal has
no way to reach that field when a task — not a block — is what's open.

## Non-goals

- **Do not add lock semantics to the `tasks` table.** Locking stays a property of the
  placed `time_block`, exactly as today. A task with no active block has nothing to
  lock — the toggle is absent, not disabled-and-clickable, in that case.
- **Do not expose or manage multiple blocks per task.** "The task's active block" is
  singular — the same one `reconcilePriorPlacement` (`engine/autoplan.ts:472-489`)
  and `auto-defense.ts:268` already resolve to: the newest non-terminal
  `block_kind='task'` row for that `task_id`. If a task has more than one (a rare
  multi-session case), the toggle acts on that single row only; do not build a picker.
- **Do not touch the I10 inbound-mirror rule.** `updateBlock` already rejects
  unlocking (never locking) a synced-inbound block with `inbound_readonly`
  (`services/blocks.ts:618-624`). Surface that error to the toggle (see DoD) rather
  than special-casing it client-side.
- **Do not change `reconcilePriorPlacement`, obstacle/reflow logic, or any engine
  file.** This ticket is a read (does the task have an active block, is it locked)
  plus one existing write (`PATCH /api/blocks/:id`), both already built.
- **No schema change.** `is_locked` exists (`schema.ts:153`).
- **No new REST endpoint.** Reuse `PATCH /api/blocks/:id` exactly as the timeblock
  tab does today.

## Pinned conventions

- **Server: active-block lookup**, mirroring the exact query shape
  `reconcilePriorPlacement`'s `sameDay`/`lockedElsewhere` branches already use:
  ```sql
  SELECT id, is_locked FROM time_blocks
   WHERE task_id = ? AND owner_id = ? AND block_kind = 'task'
     AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
   ORDER BY start_at DESC LIMIT 1
  ```
  (`TERMINAL_BLOCK_STATUS_SQL` from `services/block-task-sync.ts:41`; newest-first —
  the toggle should reflect the block the owner is currently looking at in Today/
  Planner, which is the most recent placement, not the oldest stale one.)
- **New helper**, same file and shape as the existing `peopleFor` helper it sits
  beside: `server/src/routes/tasks.ts` — add
  `async function activeBlockFor(taskId: string): Promise<{ active_block_id: string | null; active_block_locked: boolean }>`
  right after `peopleFor` (line 48), same owner-scoping via `currentOwnerId()`.
- **Wire it at every `peopleFor(...)` call site in `routes/tasks.ts`** (lines 171,
  309, 357, 390, 457, 505, 530, 556, 607, 630, 670 — verify against current line
  numbers at implementation time, the file may have shifted) by spreading
  `...(await activeBlockFor(task.id))` alongside the existing
  `...(await peopleFor(task.id))`. Same enrichment tier, same reasoning: a GET/PATCH
  response for a task should carry both in one round trip.
- **Client `Task` type** (`client/src/lib/api.ts:55-83`): add
  `active_block_id?: string | null; active_block_locked?: boolean;` next to the
  existing `blocked?: boolean` field.
- **Wizard state**: extend the existing `locked`/`setLocked` signal
  (`ElementWizard.tsx:171`) to also seed from a task load — today it is only seeded
  at line 410 (`setLocked(!!b.is_locked)`) inside the timeblock-load branch. Add the
  task-load equivalent: `setLocked(!!t.active_block_locked)` wherever the task's
  fields are seeded into signals on edit-open (same function, task branch).
- **Chip visibility**: change the existing
  `<Show when={tab() === 'timeblock'}>` wrapper around the Lock button
  (`ElementWizard.tsx:1502`) to
  `<Show when={tab() === 'timeblock' || (tab() === 'task' && !!m().editTarget?.active_block_id)}>`
  — i.e. show on the task tab only in edit mode with a resolved active block; a
  new/unplaced task shows no toggle (nothing exists yet to lock).
- **Save path**: wherever the task-tab save currently calls the task update API
  (`api.tasks.update` — locate the call in the same save function referenced by
  `isBlock` at `ElementWizard.tsx:504`), add, only when `tab() === 'task'` AND an
  `active_block_id` is present AND `locked()` differs from the seeded value:
  `await api.blocks.update(activeBlockId, { is_locked: locked() })` (client method
  already defined at `api.ts:444-445`) as a second call after the task save
  succeeds — do not fold it into the task PATCH body; blocks and tasks are separate
  resources and separate endpoints today, and this ticket doesn't change that.
- **Error surface**: an `inbound_readonly` failure from that PATCH (only reachable
  by attempting to *unlock* a synced block) shows the same inline error treatment
  the timeblock tab already uses for that response — find and reuse it rather than
  inventing new copy.

## Before implementation

Read `ElementWizard.tsx:1502-1512` (existing Lock chip), `:395-415` (task/block load
seeding), `:504` and its save-function context, `services/blocks.ts:601-660`
(`updateBlock`, esp. the I10 guard), `engine/autoplan.ts:472-505`
(`reconcilePriorPlacement`, the query pattern to copy), `routes/tasks.ts:48`
(`peopleFor`, the sibling-helper pattern), and `services/block-task-sync.ts:39-41`
(`TERMINAL_BLOCK_STATUS_SQL`).

## Files impacted

**Changed:**
- `server/src/routes/tasks.ts` — `activeBlockFor` helper + spread at every
  `peopleFor` call site
- `client/src/lib/api.ts` — `Task` type fields
- `client/src/components/ElementWizard.tsx` — chip visibility, load-seed, save path

**New:**
- `server/test/task-active-block.test.ts`

## Schema required

None — `time_blocks.is_locked` already exists.

## Definition of Done

- [ ] A task with a currently-placed, non-terminal block shows the Lock chip on its
      edit modal; a task with none does not
- [ ] Toggling and saving locks/unlocks that task's active block via the existing
      `PATCH /api/blocks/:id`; reopening the task shows the persisted state
- [ ] A locked task's active block is skipped by reflow/auto-clear exactly as any
      other locked block already is today (no new engine behavior — verified via
      existing coverage, not re-implemented)
- [ ] Attempting to unlock a synced-inbound task's block surfaces the existing
      `inbound_readonly` error inline; the toggle does not silently revert without
      explanation
- [ ] Every `peopleFor` call site in `routes/tasks.ts` also spreads
      `activeBlockFor` — no response shape drifts from another

## Tests

- [ ] `activeBlockFor`: task with one open non-terminal block ⇒ correct id + lock state
- [ ] `activeBlockFor`: task with only terminal (completed/cancelled/skipped/missed)
      blocks ⇒ `active_block_id: null`
- [ ] `activeBlockFor`: task with no blocks ⇒ `active_block_id: null`
- [ ] `activeBlockFor`: multiple non-terminal blocks ⇒ resolves to the newest
      (`start_at DESC`)
- [ ] Owner isolation
- [ ] Route-level: GET a task response includes both `active_block_id` and
      `active_block_locked`
- [ ] Route-level: PATCHing a task's title does not touch its block's lock state
      (the two writes stay independent)

```bash
pnpm --filter server exec vitest run server/test/task-active-block.test.ts
pnpm typecheck && pnpm test
```

## Acceptance Criteria

- [ ] Given a task placed on today's calendar, when the owner opens its edit modal
      and toggles Lock, then the underlying time block's `is_locked` flips and
      survives the next auto-reflow run
- [ ] Given a task with no placement yet, when the owner opens its edit modal, then
      no Lock chip is shown

## Subtasks

1. [ ] `activeBlockFor` helper in `routes/tasks.ts`, mirroring `peopleFor`
2. [ ] Spread it at every `peopleFor` call site
3. [ ] Extend the client `Task` type
4. [ ] Extend chip visibility + load-seeding in `ElementWizard.tsx`
5. [ ] Wire the save-path second PATCH + inbound-readonly error surface
6. [ ] Seven tests; run verification
