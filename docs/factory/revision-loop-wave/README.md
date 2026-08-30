# Revision-loop wave — the agent loop's write-only log — plan of record

Four tickets closing the `capture → batch → read` loop for the §A0 authoring
harness's revision log. Each `rev-N-*.md` in this folder is a full commit recipe.
**This file is the live status; update it as tickets land.**

Opened 2026-08-29.

## The gap

`agents/loop.ts` clause 5 promises an append-only revision log: every candidate the
generate→judge loop produces, with its defects, judge median and pass/fail reason,
is appended to `audit_log` via `writeAudit` (loop.ts:133). **Nothing reads it.**
`grep -rn "FROM audit_log" server/src` returns no matches, and `lib/audit.ts:14`
says so in prose: "`audit_log` is WRITE-ONLY in production."

So every smart-mode plan run pays for up to 3 generator calls and 9 judge samples,
records exactly the evidence needed to tell whether the ordering prompt and the 0.8
threshold are working — and discards it. There is no way to answer "did last month's
prompt edit help?" except anecdote.

Unlike the sibling loops (G-INT, N2 — **out of scope for this wave**, planned in
parallel worktrees), this one has no roadmap entry. The justification is below, and
it has to clear a high bar: migration `0095_drop_plan_outcomes` already dropped one
nightly rollup precisely because it was "written every night … read by NO production
code path". This wave differs in the one way that matters: the readout ticket (4) is
part of the definition of done, not a hoped-for follow-up. If 4 is ever cut, revert
1–3 rather than shipping a second `plan_outcomes`.

## Template

Two loops already close properly; this wave copies the nearer one:

| | template | this wave |
|---|---|---|
| evidence | `classification_log` | `plan_loop_runs` + `plan_revision_log` |
| measurement | `classification_accuracy` | `plan_loop_stats` |
| batch job | `calibrate_classification` (Mon 04:10) | `calibrate_plan_loop` (Mon 04:30) |
| read surface | `GET /api/classification/accuracy` | `GET /api/plan-loop/trend` |
| apply | `classificationHint()` → prompt | **none — deliberate; see below** |

The house pattern is law (`services/classification-learning.ts` header): durable
evidence, a deterministic batch pass, never online, never mid-request, no
learning-rate knob, evidence owner-scoped and never pooled. Every ticket is bound
by it. Note one asymmetry: this wave's batch pass needs **no Ollama at all** — it is
pure SQL aggregation over evidence the loop already paid for.

## Status

| # | Ticket | Type | Status | Blocked by |
|---|---|---|---|---|
| 1 | [evidence + stats schema](rev-1-plan-loop-evidence-schema.md) | DB Migration | ✅ committed (`67bfd190`) | — |
| 2 | [capture revision evidence](rev-2-capture-revision-evidence.md) | Backend | ✅ committed (`0555dc32`) | 1 |
| 3 | [calibrate batch + cron](rev-3-calibrate-plan-loop-batch.md) | Backend | ⬜ not started | 2 |
| 4 | [trend readout](rev-4-plan-loop-trend-readout.md) | Backend | ⬜ not started | 3 |

Strictly ordered 1 → 2 → 3 → 4. Merge 2 early even if 3–4 trail: the corpus starts
accruing the day 2 merges and nothing can recover history from before it (see "No
backfill"). Ticket 4 is what makes the loop falsifiable — do not drop it as "just
reporting"; it is the reason this wave is not `plan_outcomes` again.

## Decisions of record

**A dedicated evidence table, not reads over `audit_log`.** The fork this wave was
opened on. Three findings settle it:

1. `writeAudit` has no payload column; the default sink crams the whole revision
   into the TEXT `entity` column and does `.slice(0, 4000)` (loop.ts:146). A
   truncated row is invalid JSON — silently unparseable, undetectable after the
   fact. The existing rows are forensic breadcrumbs, not a corpus.
2. `audit_log`'s writes are deliberately fire-and-forget and allowed to fail
   silently, and `lib/audit.ts:8-19` defends at length why that must never change.
   Measurement storage with different needs should not be welded to it.
3. The house already made this call twice: estimate calibration and classification
   learning each got their own evidence tables rather than mining the audit trail,
   and `routes/backup.ts:129` + `lib/owners.ts:306` treat `audit_log` as a pure
   forensic/audit spine (non-portable, hand-purged, no CASCADE).

**The audit trail is untouched, byte for byte.** The loop's default sink still
writes the same compact `plan_revision` audit row it writes today — ticket 2's new
sink *adds* evidence rows, it does not replace or reshape the audit write. Nothing
in this wave adds a reader, an UPDATE, or a DELETE against `audit_log`. As an audit
trail, write-only is correct and stays.

**The terminus is a human reading a trend — there is deliberately no "apply"
stage.** The obvious apply (auto-tuning `passThreshold` or the prompts from measured
scores) is exactly the learning-rate knob the house pattern forbids, and loop.ts
clause 6 already refuses to ship a best-failing candidate — an auto-loosened
threshold would be that refusal's back door. The sanctioned terminus is the same as
the calibration trend's: a number a human looks at before editing a prompt. This
also means **no reset endpoint**: unlike `classification_exemplars`, nothing here
influences behaviour, so there is nothing to reset.

**No backfill.** The existing `plan_revision` audit rows are unowned-format JSON in
a 4000-char column, truncated at random. Parsing them would launder corrupt data
into the corpus. The trend starts the week after ticket 2 merges.

**One stage today, columns for more tomorrow.** `runLoop` has exactly ONE production
caller — `agents/plan.ts:747`, `stage: 'order'` — despite the loop.ts header
naming four stages. Every table carries `stage TEXT` so A3/A4/B4 plug in when they
exist, but this wave measures the ordering stage only and claims nothing else.

**Migration slots 0162 + 0163; cron Mon 04:30.** Originally planned as 0159/0160,
renumbered 2026-08-29 after checking every worktree: `0159`/`0160` turned out to be
**triple-claimed** — `placement-learning-wave` (G-INT, `0159_placement_evidence.ts` /
`0160_calibrate_placement_job.ts`) and `balance-targets-wave` (N2,
`0159_balance_bias_pref.ts` / `0160_balance_week_log.ts`) both planned the identical
pair independently, and this wave would have been a third. The highest slot actually
materialized as a file anywhere (any worktree) was `0161` (an unrelated feature) plus
`0157`/`0158` (close-loop-wave's dismissal tables, already implemented in one
worktree). `0162`/`0163` were free of all three at check time. ⚠️ **This does not
retire the risk, only this wave's contribution to it:** G-INT and N2 still collide
with each other on 0159/0160, and whichever of the three waves actually merges first
still forces the other two to renumber on rebase — re-run the worktree sweep before
merging. 04:30 Monday runs after `calibrate_classification` (04:10) for the same
reason 0150 documents — even though THIS job makes no model calls, keeping the
weekly learning passes serialized in one block keeps the schedule legible. Clear of:
03:20 enrich, 03:50 triality, 04:00 Sun estimates, 04:10 classification, 05:00
advance_objectives.

## Corrections to the brief that opened this wave

- "Every AI authoring stage runs through this one runner" (loop.ts:6) is
  aspirational — only A1 ordering does. The corpus is one stage wide on day one.
- The cron inventory was incomplete: `enrich_tasks` (daily 03:20),
  `prune_sync_events` (daily 03:00) and others also occupy the window. Full list
  verified from the migration seeds before picking 04:30.

## Corrections found while implementing ticket 1

- **The verification command form stated in the original brief was wrong.**
  `pnpm --filter server exec vitest run server/test/<file>.test.ts` fails with "No
  test files found" — `--filter server exec` already sets cwd to `server/`, so
  repeating `server/` in the path doubles it. The corrected form, `pnpm --filter
  server exec vitest run test/<file>.test.ts`, is what every ticket in this wave
  now specifies. Reproduced identically on a clean `main` checkout, so this isn't
  worktree-specific.
- **Ticket 1 as originally drafted omitted the golden schema-shape snapshot.**
  `server/test/baseline.characterization.test.ts` asserts every table/column name
  against a stored snapshot and already tracks migration 0149's tables — any
  migration adding tables must regenerate it in the same commit or the suite fails
  with an "unexplained diff." Ticket 1 now names the snapshot file, the `-u`
  regeneration command, and a check that the diff is purely additive.
- Confirmed unrelated to this wave: `test/triality-metrics.test.ts` ("calibration
  reaches the wire with the field names the client reads") fails identically on a
  clean `main` checkout with no plan-loop changes present — pre-existing, not
  caused by ticket 1.

## Corrections found while implementing ticket 2

- **A verification agent used bare `git stash -u` / `git stash pop` to test
  whether a failure was pre-existing, and got away with it.** This repo's stash
  stack is shared across every concurrent worktree, and this box had 25+ peer
  Claude sessions active at the time — a bare pop can lift a different session's
  entry than the one just pushed. The round-trip happened to land cleanly here
  (verified after the fact: working tree diff intact, stash list held only two
  pre-existing entries from unrelated branches), but it was a real risk that
  should never have been taken, not a safe technique that happened to work.
  Ticket 1 had already established the correct way to answer "is this
  pre-existing" — run the single failing test against a clean checkout of `main`
  in a *different* directory, never touch this worktree's own stash. Tickets 3–4
  reuse that method exclusively; do not delegate a "verify via git stash" step to
  any agent in this wave again.

## Verification

Every ticket carries its own commands. Wave-level, from the repo root:

```bash
pnpm typecheck && pnpm test
```

`pnpm --filter server vitest run` is broken (`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`);
the working form, used throughout these tickets, is:

```bash
pnpm --filter server exec vitest run test/<file>.test.ts
```

## Open follow-ups this wave will produce

| Item | Origin | Status |
|---|---|---|
| Defect-rule frequency ("which rubric rules fire most") — the revisions table holds it; the batch doesn't aggregate it yet | scoped out of ticket 3 | open |
| Jobs-view client chart over `GET /api/plan-loop/trend` | ticket 4 ends at the API, matching the close-loop-wave precedent | open |
| Evidence retention: `plan_revision_log` is append-only with no pruning (same posture as `calibration_history`; ≤ ~4 rows/day/owner, revisit if that changes) | ticket 1 | open |
| loop.ts header claims four stages run through `runLoop`; only A1 does | found while pinning ticket 2 | open, unrelated |
