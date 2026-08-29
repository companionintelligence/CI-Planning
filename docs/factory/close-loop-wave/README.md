# Close-loop wave — dismissed suggestions — plan of record

Six tickets closing the `capture → batch → apply` loop for dismissed email/event
suggestions. Each `loop-N-*.md` in this folder is a full commit recipe. **This file is the
live status; update it as tickets land.**

Opened 2026-08-28.

## The gap

`dismissPossible()` sets `status = 'dismissed'` on `possible_tasks` and writes an audit
row. Nothing reads dismissals back — there is no reader of that status outside the write
path. So `agents/extract.ts` keeps proposing the same categories of noise forever, and the
review queue never gets quieter with use.

Two of the app's three learning loops already close properly. This wave copies the nearer
one rather than inventing a shape:

| | template | this wave |
|---|---|---|
| evidence | `classification_log` | `possible_outcome_log` |
| rollup | `classification_exemplars` | `possible_dismissal_exemplars` |
| measurement | `classification_accuracy` | `possible_dismissal_rate` |
| batch job | `calibrate_classification` (Mon 04:10) | `calibrate_dismissals` (Mon 04:20) |
| apply | `classificationHint()` → prompt | `dismissalHint()` → `buildPrompt()` |

The house pattern is stated as law in `services/classification-learning.ts`: durable
evidence, a deterministic batch pass, bounded retrieval, **never online, never
mid-request**, no learning-rate knob, evidence never pooled across owners. Every ticket
below is bound by it.

## Status

| # | Ticket | Type | Status | Blocked by |
|---|---|---|---|---|
| 1 | [evidence schema](loop-1-dismissal-evidence-schema.md) | DB Migration | ✅ landed (`3280f01f`) | — |
| 2 | [capture outcomes](loop-2-capture-outcome-evidence.md) | Backend | ✅ landed (`84c6e211`) | 1 |
| 3 | [calibrate batch](loop-3-calibrate-dismissals-batch.md) | Backend | ✅ landed (`3aaf24b2`) | 2 |
| 4 | [hint renderer](loop-4-dismissal-hint-renderer.md) | Backend | ✅ landed (`6f2da90a`) | 3 |
| 5 | [apply at extraction](loop-5-extract-hint-apply.md) | Backend | ✅ landed (`a09e1164`) | 4 |
| 6 | [noise-rate readout](loop-6-noise-rate-readout.md) | Backend | ✅ landed (`f9bf9b30`) | 3 |

Strictly ordered 1 → 2 → 3 → 4 → 5. Ticket 6 forks off 3 and can land in parallel with
4–5; it is what proves the loop actually works, so do not drop it as "just reporting".

## Decisions of record

Four calls a reviewer would otherwise have to reverse-engineer.

**A new evidence log, not a `dismissed_at` column.** `possible_tasks` has `created_at`
(when the suggestion was *made*) and a `status`, but nothing records *when* it was
rejected. Adding `dismissed_at` would be the smaller diff and is the wrong shape: it
cannot hold a promote, it dies with the row, and it would break both
`schema-parity.test.ts` (the table *is* modelled, `schema.ts:110`) and the pinned
`GET /api/possible-tasks` snapshot, which serialises every column. The log is append-only
and outlives the suggestion, so pruning a possible never deletes what it taught.

**Influence, never suppression.** The loop biases what the extractor proposes by putting at
most `RETRIEVE_K` past dismissals into the prompt, phrased as history. It does not filter
the review queue. Nothing in this wave adds a `suppressed`, `blocklist` or `never_suggest`
column — a silent filter could hide a real task, and it would break the constraint both
working loops observe (estimate calibration is suggest-only; classification phrases
exemplars as past corrections, not rules).

**A floor above classification's.** `CORRECTION_FLOOR` is 2 there because a typed
correction is an explicit label. A dismissal is one click, and the downside of
over-learning is a hidden task rather than a wrong tag, so `DISMISSAL_FLOOR` sits higher
and dismissals must settle past `PENDING_MS` before they count. A dismiss the owner later
reverses by promoting is fenced out entirely.

**No backfill.** Existing `status = 'dismissed'` rows are untimestamped, which is the whole
reason `decided_at` exists. The corpus starts accruing the day ticket 2 merges — so merge
2 early even if 3–5 trail, because nothing else in the wave can recover that history.

## Corrections to the audit that opened this wave

The [Open Loops](../../..) assessment said the dismissal evidence was "already durable,
owner-scoped and timestamped". The first two hold; **the third was wrong** — there is no
decision timestamp anywhere today. That error is why ticket 1 exists and why it leads.

It also makes the "cheapest of the four to close" claim optimistic: the batch and apply
stages are genuinely a copy of a working template, but the capture stage needs new storage
first.

One more finding, load-bearing for ticket 5: **`possible_tasks.confidence` is written and
never read** — no threshold, no sort, server or client. Lowering a suggestion's confidence
would therefore have no observable effect at all today, so the apply stage has to reach the
prompt to do anything real. Making `confidence` mean something is a separate gap, not this
wave.

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
| `possible_tasks.confidence` is stored but never read — no threshold, no sort | found while pinning ticket 5 | open, out of scope for this wave |
| `theme-tokens.test.ts` fails twice on clean `main` (`--primary` canon teal) | found in the audit | open, unrelated |
