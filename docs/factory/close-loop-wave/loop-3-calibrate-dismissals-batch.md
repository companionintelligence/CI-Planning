> **Type:** Backend
> **Phase:** Close-loop wave — dismissed suggestions
> **Branch:** `feat/calibrate-dismissals`
> **Commit style:** `feat(learning): weekly calibrate_dismissals batch over dismissal evidence`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 2 (there must be evidence to batch)

## Goal

Add the batch stage: a new `server/src/services/dismissal-learning.ts` with a
`calibrateDismissals()` that rebuilds one owner's exemplar rollup from settled evidence and
records one noise-rate reading, plus the `calibrate_dismissals` job kind and its weekly cron
row.

This is the deterministic pass the house pattern requires. Classification stays request-time;
the *learning* is batch by contract — never online, never mid-request — so a bad week of
dismissals can never bend a live extraction.

## Non-goals

- **No retrieval and no prompt.** `retrieveDismissals()` / `dismissalHint()` are ticket 4;
  the apply site is ticket 5. This ticket writes the index nobody reads yet.
- **No route and no client change.** The readout is ticket 6.
- **No learning-rate knob.** No `weight`, `decay`, `alpha`, or configurable strength, and no
  env var. The template has none, and the sanctioned response to weak learning is more or
  better evidence, not a hotter dial.
- **No suppression.** Nothing here filters, blocks or hides a suggestion.
- **No online learning.** Nothing in the request path may call into this service.
- **No cross-owner evidence.** Every read filters `owner_id`. Never aggregate across owners,
  not even to bootstrap a new one.
- **Do not prune `possible_outcome_log`.** The log is durable; only the rollup is rebuilt.
- **Do not write the rollup incrementally.** Delete-then-insert per owner, wholesale, so a
  run is reproducible and there is no drift between runs.
- **Do not add a second cron.** One job kind, one row, in migration `0158`.

## Pinned conventions

- **Named constants, exported, not configurable** (cited by tests and reviewers, exactly as
  `classification-learning.ts` does it):
  - `LEARNING_WINDOW_DAYS = 90` — evidence window, matching the template.
  - `PENDING_MS = 24 * 3_600_000` — a decision younger than this has not settled.
  - `DISMISSAL_FLOOR = 5` — **deliberately above** classification's `CORRECTION_FLOOR = 2`.
    A typed correction is an explicit label; a dismissal is one click, and the downside of
    over-learning here is a *hidden task* rather than a wrong tag. Document that reasoning
    in the constant's comment.
  - `MAX_EXEMPLARS = 200` — index cap per owner; also bounds retrieval cost.
  - `RETRIEVE_K = 3` — how many may ever reach a prompt (ticket 4 enforces it).
  - `MAX_PRIORS = 5` — most-frequent fallback when there is no embedder.
  - `EMBED_TIMEOUT_MS = 3_000` — per-call ceiling in a batch.
  - `RATE_PERIOD_DAYS = 7` — the noise-rate window.
- **Signature.** `calibrateDismissals(ownerId: string, now: Date, opts?: { embedFn?: EmbedFn })`.
  `now` and `embedFn` are injected so tests are deterministic — the
  `possibles.ts` / triality `embedFn` idiom, where `null` forces the no-embedder path.
- **Embedder gate.** `await ollama.embedReady()` before embedding; on false, write exemplars
  with `embedding = NULL` and carry on. Learning does not require the model; only *measuring*
  it does.
- **Job case.** Add `case 'calibrate_dismissals':` to the `execute()` switch in
  `server/src/jobs/index.ts`, immediately after `calibrate_classification`. Use
  `currentOwnerId()`, inject `new Date()`, and return the `JobOutcome` shape
  `{ itemsCreated, itemsUpdated, log }` — `itemsCreated: 0`, `itemsUpdated` = exemplars
  indexed, and a one-line `log` that states the under-the-floor case explicitly.
- **Owner scoping.** Add `'calibrate_dismissals'` to `OWNER_SCOPED_KINDS` (around line 505)
  with a comment saying evidence is never pooled across owners.
- **Cron.** Migration `0158_calibrate_dismissals_job.ts`, seeding with the exact 0150 form:
  `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)` and
  `newId()`. Use **`'20 4 * * 1'`** — Monday 04:20, clear of `calibrate_triality` (Mon
  03:50), `calibrate_classification` (Mon 04:10) and `advance_objectives` (Mon 05:00). It
  runs after `calibrate_classification` for the reason `0150` documents: serialising the
  weekly per-owner learning passes keeps one from timing out the other on a single-GPU box.
- **Never throws.** The job no-ops harmlessly for an owner below the floor or with no
  Ollama, so seeding it is safe on any deployment.

## Before implementation

Read `server/src/services/classification-learning.ts` in full — it is the template, and
`calibrateClassification()` (around line 464) is the function being mirrored. Then
`server/src/jobs/index.ts` (the `calibrate_classification` case around line 384, and
`OWNER_SCOPED_KINDS` around line 505), and
`server/src/db/migrations/0150_calibrate_classification_job.ts` for the cron seed.

## Files impacted

**New:**
- `server/src/services/dismissal-learning.ts`
- `server/src/db/migrations/0158_calibrate_dismissals_job.ts`
- `server/test/dismissal-learning.test.ts`

**Changed:**
- `server/src/jobs/index.ts` — the new `case` and the `OWNER_SCOPED_KINDS` entry
- `server/src/db/migrations/index.ts` — register `0158`
- `README.md` and `ARCHITECTURE.md` — add the cron row to the scheduled-jobs tables

## Schema required

None — ticket 1 created the tables. Migration `0158` inserts a `scheduled_jobs` row only.

## Definition of Done

- [ ] `dismissal-learning.ts` exports every constant above plus `calibrateDismissals`
- [ ] The rollup is rebuilt wholesale per owner, capped at `MAX_EXEMPLARS`
- [ ] Evidence is only counted when: older than `PENDING_MS`, inside
      `LEARNING_WINDOW_DAYS`, and the latest outcome for that possible is still `dismissed`
- [ ] Below `DISMISSAL_FLOOR`, no exemplars are written at all
- [ ] One `possible_dismissal_rate` row per run, covering only the trailing
      `RATE_PERIOD_DAYS`, with `rate` NULL when `decided = 0`
- [ ] `hinted` is sampled **before** the rebuild (the rebuild destroys the pre-run state)
- [ ] The job kind runs per owner and appears in `OWNER_SCOPED_KINDS`
- [ ] `0158` seeds the cron idempotently

## Tests

Run on a frozen `now` with an injected `embedFn`.

- [ ] A dismissal younger than `PENDING_MS` is ignored (the mis-click fence)
- [ ] A dismissal later reversed by a promote on the same possible is excluded
- [ ] An owner below `DISMISSAL_FLOOR` gets zero exemplar rows
- [ ] The cap is enforced, asserted against the exported `MAX_EXEMPLARS` rather than a
      literal
- [ ] Evidence is not pooled: a second owner's dismissals never appear in the first's rollup
- [ ] Running twice on unchanged evidence produces an identical rollup
- [ ] `embedFn: null` still writes exemplars, with `embedding` NULL
- [ ] `rate` is NULL when nothing was decided in the period, and correct when something was
- [ ] With the log table renamed away, the job finishes `done` and does not throw
- [ ] An owner with zero dismissals finishes `done` with the under-the-floor message — not a
      red Jobs row
- [ ] Fan-out writes one `job_run` per owner

```bash
pnpm --filter server exec vitest run server/test/dismissal-learning.test.ts
pnpm --filter server exec vitest run server/test/jobs.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner with enough settled dismissals, when the job runs, then their rollup is
      rebuilt and one rate row is written
- [ ] Given an owner below the floor, when the job runs, then no exemplars exist and the job
      still reports success
- [ ] Given two owners, when the job runs, then neither rollup contains the other's evidence
- [ ] Given no Ollama, when the job runs, then exemplars are still written without vectors

## Subtasks

1. [ ] Read `classification-learning.ts` end to end
2. [ ] Write `dismissal-learning.ts`: constants, the settled-evidence read, the wholesale
       rebuild, the rate reading (sampling `hinted` first)
3. [ ] Add the `case` to `jobs/index.ts` and the `OWNER_SCOPED_KINDS` entry
4. [ ] Write `0158_calibrate_dismissals_job.ts` and register it
5. [ ] Add the cron row to `README.md` and `ARCHITECTURE.md`
6. [ ] Write `dismissal-learning.test.ts` covering all eleven cases
7. [ ] Run the verification commands
