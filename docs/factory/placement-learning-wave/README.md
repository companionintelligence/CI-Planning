# Placement-learning wave — the scheduler learns from corrections — plan of record

Six tickets closing the `capture → batch → apply` loop for **where the scheduler puts
things**. Each `place-N-*.md` in this folder is a full commit recipe. **This file is the
live status; update it as tickets land.**

Opened 2026-08-29. Closes the placement half of `G-INT`, deferred since the Phase G
reconception (`docs/ROADMAP.md:73`, `:141`, `:252`).

## The gap

When the owner drags an auto-placed block, the block flips to manual and the reflow stops
touching it. That is correct *defence* — and it is the whole of the response. Where the
scheduler put it, where the owner moved it to, and what kind of work it was are all
discarded. Placement is the app's core intelligence and the only major surface with no
evidence trail: the estimate loop learns your bias, the classifier learns your vocabulary,
and the scheduler will propose 9am for a task you have moved to the evening thirty times.

Verified before designing: **no override, placement or rejected-slot table exists across
all 154 migrations**, and there is no `moved_from` column anywhere.

Two of the app's three learning loops already close properly. This wave copies the nearer
one rather than inventing a shape:

| | template | this wave |
|---|---|---|
| evidence | `classification_log` | `placement_log` |
| rollup | `classification_exemplars` | `placement_preferences` |
| measurement | `classification_accuracy` | `placement_survival` |
| batch job | `calibrate_classification` (Mon 04:10) | `calibrate_placement` (Mon 04:30) |
| apply | `classificationHint()` → prompt | `placementScorer()` → `pickGap` |

The house pattern is stated as law in `services/classification-learning.ts`: durable
evidence, a deterministic batch pass, bounded influence, **never online, never
mid-request**, no learning-rate knob, evidence never pooled across owners. Every ticket
below is bound by it.

## Status

| # | Ticket | Type | Status | Blocked by |
|---|---|---|---|---|
| 1 | [evidence schema](place-1-placement-evidence-schema.md) | DB Migration | ✅ done | — |
| 2 | [capture the menu](place-2-capture-placement-menu.md) | Backend | ✅ done | 1 |
| 3 | [capture the correction](place-3-capture-correction.md) | Backend | ✅ done | 2 |
| 4 | [calibrate batch](place-4-calibrate-placement-batch.md) | Backend + DB | ✅ done | 3 |
| 5 | [bias gap choice](place-5-bias-gap-choice.md) | Backend | ✅ done | 4 |
| 6 | [survival readout](place-6-survival-readout.md) | Backend | ✅ done | 4 |

Strictly ordered 1 → 2 → 3 → 4 → 5. Ticket 6 forks off 4 and can land in parallel with 5;
it is what makes the loop falsifiable, so do not drop it as "just reporting".

## Corrections to the brief that opened this wave

**`day-reflow.ts:227` is not the drag path.** That `UPDATE ... is_auto = 0` sits inside
`applyDayReflow`, which recomputes a proposal and applies it *after the owner confirmed
it* — the owner **agreeing** with the scheduler, not correcting it. Recording it as a
correction would teach the exact opposite of the truth.

There are exactly three `is_auto → 0` update sites, and a fourth mover that flips nothing:

| site | what it is | evidence? |
|---|---|---|
| `services/blocks.ts:653` (`updateBlock`) | the real drag / resize, via `PATCH /api/blocks/:id` | **yes — the correction** |
| `engine/day-reflow.ts:227` (`applyDayReflow`) | owner confirmed an agent proposal | no |
| `services/block-task-sync.ts:312` (`syncBlockFromTask`) | a task-side time edit mirrored onto its block | no — see below |
| `services/blocks.ts:762` (`moveBlockGroup`) | shifts a Plan and its members by a delta; never touches `is_auto` | no |

`updateBlock` is the **single** hook point, and the other three are excluded *by not
calling it* rather than by a filter — a structural exclusion, not one a later refactor can
silently erode. Ticket 3 pins that.

## Decisions of record

Eight calls a reviewer would otherwise have to reverse-engineer.

**Record the menu, not just the choice.** A correction alone is ambiguous: "moved 9am →
7pm" could mean *I prefer evenings* or *9am was already full and you should have known*.
`pickGap` already computes every free gap in the day and throws the list away
microseconds later. Ticket 2 persists it. Without the menu the batch cannot tell a
preference from a constraint, and the loop would plateau at a log. This is the highest-value
decision in the wave and the data already exists in memory.

**Bias, never enforce.** The learned band only re-ranks gaps `pickGap` had **already
accepted as fitting**, and only within a hard `MAX_FRAGMENT_COST_MS` (60 min) of the
best-fit's leftover. It never moves an existing block, never overrides a lock, a pin, a
deadline or an obstacle, and never touches the truncating fallback path. With no learned
row, `pickGap` returns byte-identically to today. This is deliberate: placement influence
is closer to enforcement than the other two loops, and the `N2` row
(`docs/recap_state_A-S.md:160`) gives "enforcement risks thrash" as the reason that
deferral stands.

**A deleted block is not evidence.** `reflow()` clears and re-places auto blocks
constantly, so a `placement_log` row's block routinely stops existing. A row whose block is
gone and which was never moved is **pending forever**, not accepted — the batch LEFT JOINs
`time_blocks` and drops it. Getting this wrong would score every reflow churn burst as the
scheduler being right.

**Acceptance settles at the block's start, not on a clock.** Classification's `PENDING_MS`
(24h untouched ⇒ weak positive) does not transfer: a block placed for next Tuesday is
untouched today and undecided, not accepted. The honest boundary is *the slot arrived and
you lived with it* — `chosen_start_at` in the past, never moved, block still present.

**Truncated placements express no preference.** When `pickGap` finds no gap that fits it
falls back to the largest remaining and truncates. That is a forced placement, not a
choice, so ticket 2 stamps `fit = 0` and the batch excludes those rows from both sides of
the ledger.

**The band is built from where work RESTS, not from where corrections land.** A row's
resting hour is the moved hour when corrected and the chosen hour when accepted. Building it
from corrections alone would let five moves to 19:00 outweigh two hundred untouched 09:00
placements and drag everything to the evening. The correction floor still gates whether a key
is learned at all — with no corrections there is nothing to learn, and the band would only
echo what the scheduler already does.

**A floor of 5, above classification's 2.** A typed category correction is an explicit
label; a drag is one gesture with many meanings (a meeting came up, a mood, a phone call).
The downside of over-learning is also worse — a worse schedule is more disruptive than a
wrong tag. Five corrections per key, and the band is a p25/p75 range rather than a point,
so the bias is neutral across a span instead of pulling everything to one hour.

**No backfill.** Nothing today records where the scheduler put a block or what it
considered. The corpus starts accruing the day ticket 2 merges, so merge 2 early even if
3–6 trail.

## The learned grain

`slot_key` is the task's **level-1 direction tag name** (`tags.kind = 'direction'` —
`work` / `home` / `community`), resolved through the existing `taskNestCoords` /
`taskDirectionNames` helper in `services/auto-nest.ts`, or the literal `'(none)'`.

Low cardinality, present without any AI model, and it is the thing an owner would actually
say out loud: *"deep work drifts later."* Per-task-title similarity was rejected — it needs
the Ollama embedder, and placement corrections are far rarer than classification ones, so
it would likely never reach its floor.

An owner who has not tagged directions gets one `'(none)'` bucket, i.e. a single global
drift. That is the blunt outcome, and it is the *correct* house response: when learning
underperforms the sanctioned fix is more or better evidence — here, tagging directions —
never a hotter dial.

## Scope fence

**Life-balance categories are out.** `taskNestCoords` returns `categories` alongside
`directions`, and adding it as a second coordinate is the obvious sharpening. It is
deliberately excluded: life-balance targets reaching the scheduler is the
**balance-targets wave** (N2, `docs/factory/balance-targets-wave/`, branch
`claude/sad-merkle-5aaa0c`), being planned in parallel, and its shape may change what a
category means to placement. Recorded as an open follow-up below, not planned here.

**Verified non-overlapping, not just assumed.** That wave's ticket 3
(`bal-3-candidate-bias.md`) touches `engine/autoplan.ts`, the same file as this wave's
tickets 2 and 5 — but a different function at a different pipeline stage:
`fillFlightPlanCandidates` (`autoplan.ts:758`, **step 1**, which tasks get proposed into
the flight plan) versus this wave's `placeIntoWindow` (`autoplan.ts:399`, **step 2**,
where an already-selected task's session lands — where `pickGap` is called). ~360 lines
apart, no shared local state, no shared import either wave adds. Both waves' tickets can
implement concurrently without a functional collision.

**Pattern and container placements are out.** `engine/patterns-place.ts` (`source_kind =
'pattern'`) and `engine/blocks-place.ts` (`source_kind = 'manual'`) also call `pickGap`.
Both are excluded from capture and from bias: routines already carry explicit
user-configured windows, and — load-bearing — **both files are being rewritten on the
unmerged branch `wip/patterns-place-pinning` (`8bad3350`, ~280 lines across the two)**,
which reroutes pattern placement through `mirrorEnginePlacement` and reshapes the window
model. Touching them here would collide. Ticket 5's `pickGap` signature change is purely
additive (an optional third parameter), so their two call sites compile unchanged on either
side of that merge.

**The agent-loop revision log is out** — the **revision-loop wave** (§A0,
`docs/factory/revision-loop-wave/`, branch `claude/silly-solomon-5ab111`, already landed
`0162` as a real migration). Nothing here reads or writes `daily_plan`, `plan_hints` or
`replan_suggestions`, and that wave never touches `engine/scheduler.ts`, `engine/autoplan.ts`
or `services/blocks.ts` — its footprint is `agents/loop.ts`, `agents/plan.ts` and its own
new service/route files. No functional collision.

**Shared touch-files, not shared logic — a merge-order note, not a design conflict.** Both
sibling waves add a migration import to `migrations/index.ts`, a `DELETE FROM` to
`resetDb()` in `helpers.ts`, and (revision-loop only) a `case` + `OWNER_SCOPED_KINDS` entry
to `jobs/index.ts` and a router registration to `routes/index.ts` — the same four files
tickets 1, 4 and 6 here touch. Every one of these is an append to a list (an import line,
a `DELETE FROM`, a `case`, an array entry), so a normal sequential merge resolves cleanly;
there is nothing to coordinate beyond not rebasing on a stale base. The one file worth
watching is `server/test/__snapshots__/baseline.characterization.test.ts.snap` — it
asserts every table/column in the live DB in one snapshot, so whichever wave's schema
ticket merges second must regenerate it (`... -u`) against the already-merged tables, not
just its own three. Confirm the regenerated diff is purely additive before committing.

## Reserved slots — renumbered once already; re-verify before implementing

This wave assumes **`0166`** (tables) and **`0167`** (cron seed), following the
`0149` → `0150` precedent of splitting tables and cron seed into two files.

**These are not the original numbers.** This README first claimed `0159`/`0160`, verified
at the time against `main` (head `0156`) and every branch and worktree then on disk, none
of which had a `0157+` file. That verification was correct and immediately went stale: two
sibling sessions were mid-flight on the exact same tree and independently claimed the same
pair. Re-sweeping on 2026-08-29 found:

| wave | what happened |
|---|---|
| close-loop wave | `0157`/`0158` — **merged to `main`** (`aade3a64` → `main` via #586/#587). No longer "on paper"; these are real. |
| *(unrelated)* `close-ritual` 1–5 score | `0161` — merged to `main` (#588), landed **after** a gap at 0159/0160, for reasons unrelated to any of these three waves. |
| revision-loop wave (§A0 log, the sibling this brief fenced out) | Planned `0159`/`0160` for the same reason this wave did, **found the triple-claim first**, and moved to `0162`/`0163` — its own commit says: *"0159/0160 turned out to be triple-claimed: placement-learning-wave (G-INT) and balance-targets-wave (N2) both independently planned the identical pair."* Slot `0162` is now a real file (`docs/factory/revision-loop-wave/`, branch `claude/silly-solomon-5ab111`); `0163` is claimed on paper for its second migration. |
| balance-targets wave (N2, the life-balance sibling this brief also fenced out) | Was still stating `0159`/`0160` in `docs/factory/balance-targets-wave/README.md` (branch `claude/sad-merkle-5aaa0c`), **unimplemented** — assigned `0164`/`0165`, below. |

**Resolved by explicit ordering, not by re-sweeping to whatever's clear.** Three waves
converging on the same sweep-and-claim convention is what produced the triple-claim in the
first place — a fourth independent sweep would just as easily re-collide with a fifth wave.
So instead of each wave picking its own "next free" pair, the three in-flight claimants were
put in one order and the owner assigned the ranges directly:

1. **Revision-loop wave keeps `0162`/`0163`** — it landed first (`0162` is a real,
   already-implemented file) and re-litigating a merged migration's number is real churn a
   still-unimplemented plan's number is not.
2. **Balance-targets wave (N2) is assigned `0164`/`0165`** — immediately after
   revision-loop's pair. Communicated directly to that session
   (`claude/sad-merkle-5aaa0c`); its README should update from `0159`/`0160` to `0164`
   (ticket 2, `bal-2-balance-bias-pref.md`) / `0165` (ticket 6, `bal-6-week-log.md`).
3. **This wave takes `0166`/`0167`** — immediately after balance-targets'. Both siblings
   were notified.

Nothing else in this wave's tickets references the old numbers; the rename touched only the
four files that named a slot.

**Re-verify before implementing anyway.** Two renumbers in one afternoon is the base rate
on this tree, not an anomaly — sweep again immediately before ticket 1 lands:

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes | grep -v 'HEAD$'); do
  git ls-tree -r "$b" --name-only 2>/dev/null | grep -E 'migrations/016[4-9]_'
done
```

Cron slot **Monday 04:30**. Verified against the seeds rather than inherited: the brief's
"`calibrate_estimates` Sun 04:00" is its **pre-0107** value — `0083_learning_loops.ts:42`
seeds `'0 4 * * 0'` and `0107_calibration_scope.ts:67` moves it to nightly `'30 1 * * *'`,
so on any current DB it runs at **01:30 daily**. Live neighbours: `enrich_tasks` 03:20
nightly, `calibrate_triality` Mon 03:50, `calibrate_classification` Mon 04:10,
`advance_objectives` Mon 05:00, and the now-merged close-loop wave's `calibrate_dismissals`
at Mon 04:20 (`0158_calibrate_dismissals_job.ts`, confirmed on `main`). `04:30` is clear,
verified against the real seed rows on `main`, not the planning doc. Running last of the
weekly per-owner learning passes keeps this pure-SQL job from contending with the two that
may call a model on a single-GPU box.

## Re-entrancy

`docs/archive/K-auto-defense.md` warns that "the reflow writes blocks, which could
re-trigger task/block listeners". Every write in this wave lands in `placement_log`,
`placement_preferences` or `placement_survival` — **never in `time_blocks` or `tasks`** —
so no capture path can re-enter reflow. Ticket 2's write is inside the placement loop but
touches no scheduling table, and ticket 3's is inside `updateBlock` after the block UPDATE
has already returned.

## Verification

Every ticket carries its own commands. Wave-level, from the repo root:

```bash
pnpm typecheck && pnpm test
```

Note the factory-template bug documented in the LLM wave: `pnpm --filter server vitest run`
fails with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`. The working form, used throughout these
tickets, is:

```bash
pnpm --filter server exec vitest run server/test/<file>.test.ts
```

## Open follow-ups this wave will produce

| Item | Origin | Status |
|---|---|---|
| Life-balance **category** as a second `slot_key` coordinate | fenced off as sibling-wave surface | open, deliberate |
| Pattern / container placements (`patterns-place.ts`, `blocks-place.ts`) never learn | blocked on `wip/patterns-place-pinning` merging | open, out of scope |
| `moveBlockGroup` shifts a whole Plan and records nothing | found while pinning ticket 3 | open — a group shift is one gesture about the container, not per-block placement evidence |
| The three classification tables (0149) are absent from `resetDb()`; their two test files clear them by hand instead | found while pinning ticket 1 | open, pre-existing — this wave adds its own `DELETE FROM`s and does not change theirs |
| Duration corrections (resizes) are recorded but never learned from | decided, ticket 3 | open by design — how long work takes is the estimate loop's job |
| Hour percentiles are linear, so a band that wraps midnight is not learnable | found while pinning ticket 4 | open — fenced by `MAX_BAND_HOURS = 6`, which writes no row rather than a wrong one |
| `0150_calibrate_classification_job.ts`'s comment names "03:30 calibrate_estimates" — a slot that matches neither the 0083 seed nor the 0107 move | found while verifying cron slots | open, cosmetic — do not fix in this wave |
