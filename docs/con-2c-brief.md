# CON-2c — `tasks.subtype` + Habit dual-shape (handoff brief)

> **Self-contained brief for a fresh session.** Add a canonical `subtype` to tasks
> and resolve the Habit dual-shape — **ADDITIVE approach (decided with the user)**.
> Canon: [GLOSSARY.md](GLOSSARY.md). Plan: [consolidation-plan.md](consolidation-plan.md).
>
> **SEQUENCING: run after CON-2b.** Branch off the *latest* `claude/con-2-vocab`
> HEAD (must already contain CON-2a + CON-2b). Do not run in parallel with 2b/2d —
> shared files (`PlannerDrawer`, `Patterns`, `api.ts`) will conflict.

## The decision (locked): ADDITIVE, not full-drop
- **Add `tasks.subtype`** (`'standard' | 'habit' | 'quick'`, mutually exclusive, default `'standard'`) as the **canonical** field at the UI/API layer.
- **Keep `is_habit` / `is_fast_task` columns** as **in-sync runtime aliases** — the recurrence generation, streaks, and skip logic continue to read `is_habit` **untouched**. Do NOT rewire the engine. Fully deleting the booleans is a later contract step, explicitly out of scope here.
- Result: Habit is a **Task subtype** (surfaced under Routines), not a "pattern type" — but the engine behavior is unchanged because `is_habit` stays accurate.

## Where things stand
- Entity ids are TEXT UUIDv7 (CON-1) — treat ids as opaque strings.
- `block_type` values are `scheduled`/`someday` (CON-2a); vocabulary relabeled (CON-2b).
- Server tests need **Node 26.3.0**: `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT`.

## Scope
1. **Migration `0032_task_subtype`** (additive + idempotent): `ALTER TABLE tasks ADD COLUMN subtype TEXT DEFAULT 'standard'` (guard with `pragma_table_info`); backfill `UPDATE tasks SET subtype='habit' WHERE is_habit=1; UPDATE tasks SET subtype='quick' WHERE is_fast_task=1 AND (is_habit IS NULL OR is_habit=0)` (habit wins ties). Register in `db/migrations/index.ts`.
2. **`schema.ts`**: add `subtype: text('subtype').default('standard')` to `tasks`. Keep `isHabit`/`isFastTask`.
3. **Keep in sync on every write path** (so `is_habit`/`is_fast_task` stay accurate for the engine):
   - `routes/tasks.ts` create/update: accept `subtype`; when set, derive `is_habit = subtype==='habit'`, `is_fast_task = subtype==='quick'`. When a caller passes `is_habit: true` (legacy), set `subtype='habit'` too.
   - `routes/tasks.ts` **promote-to-habit** endpoint: set `subtype='habit'` alongside `is_habit=1`.
   - `routes/patterns.ts` fast-task create (`is_fast_task=1`): set `subtype='quick'`.
4. **Serialize** `subtype` in task API responses (it flows through `toApi` automatically once it's a schema column — verify it appears).
5. **Client** `lib/api.ts`: add `subtype?: 'standard' | 'habit' | 'quick'` to the `Task` interface. UI readers can keep using `is_habit` (still accurate) — minimal change. The Routines view's "Habits" section already lists habit tasks; leave it (it stays correct).

## Out of scope (do NOT touch)
- The recurrence/streak/skip engine (`recurrence-generate.ts`, `recurrence-ops.ts`, `services/patterns.ts`) — it keeps reading `is_habit`. No behavior change.
- Dropping `is_habit`/`is_fast_task` (later contract step).
- `block_type`, vocab labels (done in 2a/2b), ConceptLane (CON-2d).

## The gate
- **Intentional baseline change:** the GET /api/tasks (and `?status=done`) snapshots gain a `subtype` field per task (the habit fixture task → `subtype:'habit'`). Run the baseline **without `-u` first**, confirm the *only* diff is the added `subtype` field, then `-u` to regenerate, then confirm green. **No other snapshot may move** — engine output, blocks, patterns, flight-plan must stay byte-identical (proof the engine is untouched).
- `recurrence-ops.test.ts`, `generate.test.ts`, `habit-patterns.test.ts` must pass **unchanged** (the engine-untouched proof).
- `pnpm -C server exec tsc --noEmit` clean + suite **253** green; `pnpm -C client exec tsc --noEmit` clean + tests green.

## Deliverable
- Commit on `claude/con-2-vocab` (`feat(con-2c): add tasks.subtype (additive); is_habit/is_fast_task kept as runtime aliases`). End with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push + report; show the baseline diff is only the added `subtype` field.
- **This is the last CON-2 code sub-task** (CON-2d is deferred until #71's day-nav). **Do NOT open the PR yourself** — report back. CON-1 was *squash*-merged into `main`, so the orchestrator will `git rebase --onto main <CON-1-tip> claude/con-2-vocab` (drop the already-merged CON-1 commits) to produce a clean CON-2-only diff, then open the CON-2 PR (base `main`).
