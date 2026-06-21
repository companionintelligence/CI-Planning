# CON-2d — Remove the ConceptLane (handoff brief)

> **Self-contained brief for a fresh session.** Remove the separate Concept
> horizon lane; someday Time Blocks render on their goal day in the Planner header
> lane. Canon: [GLOSSARY.md](GLOSSARY.md). Plan: [consolidation-plan.md](consolidation-plan.md).
>
> **SEQUENCING: run last, after CON-2b + CON-2c.** Branch off the *latest*
> `claude/con-2-vocab` HEAD. Shares `Planner.tsx`/`Today.tsx` with the other
> sub-tasks — not parallel-safe.

## Where things stand
- CON-2a (block_type → scheduled/someday), CON-2b (vocab relabels), CON-2c (subtype) are in.
- Someday Time Blocks are `block_type='someday'`; fetched via `api.blocks.listConcepts()` (`GET /blocks?state=someday`) into the `concepts` store.
- Server tests need **Node 26.3.0**: `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT`.

## Scope
1. **Remove `ConceptLane` from the cockpit**: `client/src/views/Today.tsx` — drop the `import { ConceptLane }` and the `<ConceptLane />` render.
2. **Someday blocks on their goal day in the Planner header lane**: `client/src/components/Planner.tsx` already renders `todayConcepts()` (someday blocks whose `goal_start_date === day()`) as `HeaderChip … concept` in the header lane. Confirm that remains the surface; no new component needed.
3. **Delete** `client/src/components/ConceptLane.tsx` (now unused) and any dangling imports/exports.
4. Keep the `concepts` store + `listConcepts` API (still used by the header lane).

## ⚠️ Known transient (flag, don't fix here)
The Planner is **today-only** until #71 Phase 1 adds day navigation. So after removing ConceptLane, someday blocks are visible **only on today's** header lane (their goal day) until day-nav lands; future-day someday blocks aren't browsable in the interim. This is accepted per the consolidation plan (ConceptLane removal here, day-nav + the click→popover in #71 Phase 4). If the user would rather avoid the transient, **defer CON-2d until #71 Phase 1** — call this out in your report and confirm before proceeding.

## Out of scope
- The click→lightweight-popover on a someday chip — that's **#71 Phase 4**, not here.
- Day navigation — **#71 Phase 1**.
- Any data/schema/`block_type`/subtype change.

## The gate
- **Behavior baseline `.snap` stays byte-identical** — this is a client layout change; it touches no serialized API data. Do NOT run `vitest -u`.
- `pnpm -C client exec tsc --noEmit` clean; `pnpm -C client exec vitest run` green (drop/adjust any test that referenced `ConceptLane` — there may be none).
- `pnpm -C server exec tsc --noEmit` clean + suite **253** green (server untouched).

## Deliverable
- Commit on `claude/con-2-vocab` (`feat(con-2d): remove ConceptLane; someday Time Blocks live on the Planner header lane`). End with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- This is the **last CON-2 sub-task** — once it's in, CON-2 is complete: open the **CON-2 PR** (base `main` if CON-1 has merged there, else `claude/consolidation`) summarizing 2a–2d, and note which baseline snapshots intentionally changed (block_type values in 2a; added `subtype` field in 2c) and that everything else stayed byte-identical.
