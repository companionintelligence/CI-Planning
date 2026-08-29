> **Type:** Backend
> **Phase:** Revision-loop wave — the agent loop's write-only log
> **Branch:** `feat/calibrate-plan-loop`
> **Commit style:** `feat(learning): weekly plan-loop stats batch + cron (0160)`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 2 (evidence must be accruing). Blocks 4.

## Goal

The deterministic BATCH pass: a weekly owner-scoped job that rolls the trailing
seven days of `plan_loop_runs` into one `plan_loop_stats` row per stage — pass
rate, first-try pass rate, escape count, average iterations. This is the number
that turns "the ordering prompt seems fine" into a measured trend.

## Non-goals

- **No Ollama anywhere.** Unlike `calibrate_classification`, this pass is pure SQL
  aggregation over evidence already paid for. It must run identically with and
  without a model installed — there is no degraded mode because there is nothing
  to degrade.
- **No apply stage, ever, in this wave.** The stats feed a human. Do not write
  anything that adjusts `passThreshold`, `maxIterations`, prompts, or any loop
  option from measured values — that is the forbidden learning-rate knob, and
  loop.ts clause 6's refusal to ship a best-failing candidate would be
  circumvented by an auto-loosened threshold.
- **No knobs.** Window (7 days) and schedule are named constants; no env var, no
  preference.
- **Do not read `audit_log`.** The corpus is `plan_loop_runs` only.
- **Do not pool owners.** Every query filters `owner_id`; the cron fans out
  per-owner via `OWNER_SCOPED_KINDS`.
- **Do not backfill** stats for weeks before ticket 2 merged.
- **Do not aggregate defect-rule frequencies** — noted follow-up in the README,
  out of scope here.

## Pinned conventions

- **Service function** in the ticket-2 module `server/src/services/plan-loop-learning.ts`:
  `calibratePlanLoop(ownerId: string, now: Date = new Date()): Promise<PlanLoopCalibrationResult>`
  where the result is `{ stages: { stage: string; runs: number; passed: number;
  escaped: number; firstTryPass: number; avgIterations: number | null;
  passRate: number | null }[] }`.
  - Named constant `export const STATS_WINDOW_DAYS = 7;` with a comment: cited by
    tests, not configurable (the classification-learning constants style).
  - `computed_date` = `localDateInTZ(now.toISOString(), await ownerTimezone(ownerId))`
    — imports from `../lib/tz.js` and `../engine/recurrence-generate.js`, exactly
    as `classification-learning.ts:2-4` does.
  - Window predicate: `at >= ?` with
    `new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000).toISOString()` —
    ISO strings compare lexicographically.
  - One aggregation per distinct `stage` present in the window
    (`SELECT stage, COUNT(*), SUM(passed), SUM(escaped),
    SUM(CASE WHEN passed = 1 AND iterations = 1 THEN 1 ELSE 0 END),
    AVG(iterations) ... GROUP BY stage`).
  - Write via UPSERT keyed on the PK:
    `INSERT INTO plan_loop_stats (...) VALUES (...) ON CONFLICT(owner_id, stage, computed_date) DO UPDATE SET ...`
    (re-running on the same day replaces, never duplicates — the
    `classification_accuracy` UPSERT posture).
  - A stage with zero runs in the window writes **no row** — absence is the gap.
    `avg_iterations`/`pass_rate` NULL never actually occurs on a written row
    (runs ≥ 1 by construction) but the columns stay nullable per ticket 1; do not
    coerce.
  - Deterministic given the same rows and clock: fixed window, fixed sorts, no
    sampling.
- **Job registration** in `server/src/jobs/index.ts`:
  - `case 'calibrate_plan_loop':` in the `execute()` switch, placed next to the
    other `calibrate_*` cases. Body: call
    `calibratePlanLoop(currentOwnerId(), new Date())`, return
    `{ itemsCreated: 0, itemsUpdated: <stats rows written>, log: 'Plan-loop stats — <per-stage summary>' }`
    with a per-stage label like
    `order: 5 run(s), 80% pass, 1 escape(s), avg 1.4 iteration(s)` and
    `no runs in the last 7 days — nothing to measure` when empty (the
    calibrate_classification label style, jobs/index.ts:394-401).
  - Add `'calibrate_plan_loop'` to `OWNER_SCOPED_KINDS` (jobs/index.ts:485) with a
    one-line comment: evidence is per-owner by construction, never pooled.
  - A comment on the case noting the WHO rule: cron/agent write ⇒ no owner
    attribution (matches the neighbouring cases' comments, owner ruling 2026-07-16).
- **Cron seed migration:** `server/src/db/migrations/0160_calibrate_plan_loop_job.ts`
  — the 0149→0150 table/seed split. Same file skeleton as
  `0150_calibrate_classification_job.ts` including `import { newId } from
  '../../lib/ids.js';`. Seed:
  `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, 'calibrate_plan_loop', 'calibrate_plan_loop', '30 4 * * 1')`.
  Block comment: Monday 04:30 — after `calibrate_classification` (04:10 Mon),
  before `advance_objectives` (05:00 Mon); this job makes NO model calls, but the
  weekly learning passes stay serialized in one block so the schedule reads as one
  unit; clear of daily 03:00 prune_sync_events / 03:20 enrich_tasks and Sunday
  04:00 calibrate_estimates. Register `m0160` in `migrations/index.ts` after
  `m0159`.
- ⚠️ **Slot collision:** same warning as ticket 1 — verify 0160 is free before
  branching; renumber if a sibling wave took it.

## Before implementation

Read `server/src/services/classification-learning.ts:464-540`
(`calibrateClassification` — the batch shape being copied, minus embeddings and
scoring), `server/src/jobs/index.ts:373-410` (the three `calibrate_*` cases and
their return labels) and `:485-509` (`OWNER_SCOPED_KINDS` + fan-out), and
`server/src/db/migrations/0150_calibrate_classification_job.ts` in full (the seed
skeleton and slot-picking comment).

## Files impacted

**New:**
- `server/src/db/migrations/0160_calibrate_plan_loop_job.ts`
- `server/test/plan-loop-calibrate.test.ts`

**Changed:**
- `server/src/services/plan-loop-learning.ts` — add `STATS_WINDOW_DAYS`,
  `calibratePlanLoop`
- `server/src/jobs/index.ts` — switch case + `OWNER_SCOPED_KINDS` entry
- `server/src/db/migrations/index.ts` — import + append `m0160`

## Schema required

None — ticket 1 created `plan_loop_stats`; this ticket only seeds a
`scheduled_jobs` row (0160).

## Definition of Done

- [ ] `calibratePlanLoop` writes one UPSERTed stats row per (stage, owner-local
      run date) covering the trailing 7 days
- [ ] Running it twice on the same day leaves exactly one row per stage
- [ ] An owner with no runs in the window gets zero rows and a "nothing to
      measure" job log
- [ ] The job is registered, owner-scoped, and seeded at Monday 04:30
- [ ] The seed migration is idempotent (`INSERT OR IGNORE`)
- [ ] No code path in this ticket touches Ollama or `audit_log`

## Tests

New `server/test/plan-loop-calibrate.test.ts`, seeding `plan_loop_runs` rows
directly (fixed ISO timestamps — mind the memory note that uuid7 ties within one
millisecond order randomly; give rows distinct `at` values):

- [ ] Five runs (4 passed, 1 escaped, 3 first-try) → one 'order' row with
      `runs=5, passed=4, escaped=1, first_try_pass=3, pass_rate=0.8`,
      `avg_iterations` correct to a tolerance
- [ ] A run dated 8 days ago is excluded; one dated 6 days ago is included
- [ ] Same-day re-run UPSERTs: still one row, values replaced
- [ ] Two owners' runs produce independent rows; owner A's calibration never reads
      owner B's runs
- [ ] Zero runs in the window → zero stats rows (assert absence, not NULLs)
- [ ] Two distinct stages in the window → two rows, one per stage
- [ ] Job-level: `execute` for kind `calibrate_plan_loop` returns
      `itemsUpdated` = rows written and a log naming each stage (drive it the way
      existing job tests drive the switch)

```bash
pnpm --filter server exec vitest run server/test/plan-loop-calibrate.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given a week of smart-mode planning, when Monday 04:30 fires, then each
      owner gains at most one stats row per stage, computed only from their own
      runs
- [ ] Given the job runs on a box with no Ollama, then the result is identical to
      a box with Ollama
- [ ] Given the seed migration re-runs, then `scheduled_jobs` still holds exactly
      one `calibrate_plan_loop` row

## Subtasks

1. [ ] Verify slot 0160 is free; write and register the seed migration
2. [ ] Add `STATS_WINDOW_DAYS` + `calibratePlanLoop` to the service
3. [ ] Add the switch case + `OWNER_SCOPED_KINDS` entry
4. [ ] Write `plan-loop-calibrate.test.ts` (seven cases above)
5. [ ] Run the verification commands, then the full suite
