> **Type:** Backend + DB Migration
> **Phase:** Placement-learning wave — G-INT (timing intelligence)
> **Branch:** `feat/calibrate-placement`
> **Commit style:** `feat(jobs): weekly calibrate_placement batch over the placement log`
> **Design:** [README.md](README.md)
> **Dependencies:** Ticket 3 (corrections are being captured)

## Goal

The deterministic BATCH pass. Once a week, per owner, read `placement_log`, grade each row,
rebuild `placement_preferences` wholesale, and record one `placement_survival` reading.
Nothing reads the preferences yet — ticket 5 does that — so this ticket is safe to merge
alone and its output is inspectable before it can influence anything.

Also lands migration `0160`, seeding the `calibrate_placement` cron row.

## Non-goals

- **Do not read `placement_preferences` from any engine path.** Ticket 5 owns the apply
  stage. `engine/` is untouched by this ticket.
- **Do not call Ollama, an embedder, or any model.** This loop is pure SQL and arithmetic;
  its degradation contract is satisfied by construction. Do not import `mcp/ollama.js`.
- **No learning-rate knob, no env var, no pref.** No `PLACEMENT_LEARNING_RATE`,
  `placement_strength`, `decay`. Every bound below is a named exported constant, cited by
  tests, not configurable.
- **Do not pool across owners.** Every statement filters `owner_id = ?`;
  `calibrate_placement` goes in `OWNER_SCOPED_KINDS` so the cron fans out per owner.
- **Do not prune `placement_log`.** The window is applied at read time. The log is durable
  evidence and nothing in this wave deletes from it.
- **Do not refactor `services/calibration.ts`.** Its `quantile` (line 41) is module-private;
  copy the four-line index-quantile rather than exporting it — a change there touches the
  estimate loop, which is out of scope.
- **Do not write an `is_auto`, `is_locked` or `last_moved_at` value.** The batch writes only
  to `placement_preferences` and `placement_survival`.
- **Do not stamp owner attribution on the job's writes.** A cron/agent write deliberately
  does not (WHO rule, owner ruling 2026-07-16) — stated at `jobs/index.ts:376` and `:387`.
- **No route, no client change.** The readout is ticket 6.

## Pinned conventions

Verified against the tree — do not substitute.

- **Migration skeleton.** `0160_calibrate_placement_job.ts`, copying
  `0150_calibrate_classification_job.ts` exactly: `import type { Database } from 'better-sqlite3';`,
  `import { newId } from '../../lib/ids.js';`, `export const id = '0160_calibrate_placement_job';`,
  a block comment naming every neighbouring cron slot and why this one is clear, then
  ```ts
  db.prepare(`INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`)
    .run(newId(), 'calibrate_placement', 'calibrate_placement', '30 4 * * 1');
  ```
  Register in `migrations/index.ts` with a `.js` import in numeric order.
- **Cron slot.** `'30 4 * * 1'` — Monday 04:30. Live neighbours, verified against the seeds:
  `enrich_tasks` `'20 3 * * *'`, `calibrate_triality` `'50 3 * * 1'`,
  `calibrate_classification` `'10 4 * * 1'`, `advance_objectives` `'0 5 * * 1'`, and
  `calibrate_estimates` `'30 1 * * *'` — **nightly, not Sunday 04:00**:
  `0083_learning_loops.ts:42` seeds `'0 4 * * 0'` and `0107_calibration_scope.ts:67` moves
  it. Mon 04:20 is claimed on paper by the close-loop wave. Do not copy the slot list from
  `0150`'s comment; it names an `03:30 calibrate_estimates` that has never existed. Last of
  the weekly learning passes deliberately: this one never calls a model, so it must not sit
  ahead of the two that might on a single-GPU box.
- **Job wiring.** Add `case 'calibrate_placement':` to the `execute()` switch in
  `server/src/jobs/index.ts` (beside `calibrate_classification` at line 384), and
  `'calibrate_placement'` to `OWNER_SCOPED_KINDS` (line 485) with a `//` comment saying the
  evidence is per-owner by construction — matching the wording already there for
  `calibrate_triality` and `calibrate_classification`.
- **Return shape.** `{ itemsCreated: 0, itemsUpdated: <keys written>, log: '...' }`, matching
  the two neighbouring cases.
- **Percentiles.** Copy `calibration.ts:41-45` verbatim as a module-private `hourQuantile`,
  including its comment that it is the index-quantile Phase N used (0083), so placement bands
  stay comparable with estimate bands.
- **Wholesale replacement, atomically.** `DELETE FROM placement_preferences WHERE owner_id = ?`
  then insert, inside one `store().transaction(async () => { ... })` — the
  `calibrateClassification` / `calibrate_estimates` delete-then-insert. The DELETE is
  load-bearing: a key that aged out of the window must STOP biasing, and absence is the only
  honest representation of "back to the stock scheduler".
- **Determinism.** Same rows plus same clock ⇒ same output. Every sort is total: order by
  `(local_date, id)`, never `local_date` alone — uuid7 ties are random within a millisecond.

## The grading rule

`placementOutcome(row, now, blockExists)` → `'corrected' | 'accepted' | null`. `null` means
*not evidence* and is excluded from both the maths and the counts.

| condition | outcome | why |
|---|---|---|
| `fit = 0` | `null` | truncated fallback — a forced placement, not a choice |
| moved, `moved_hour !== chosen_hour` | `corrected` | a time-of-day disagreement |
| moved, `moved_hour === chosen_hour` | `accepted` | nudged within the hour, or resized; not a disagreement — the twin of classification's "corrected to the same value is an acceptance" |
| not moved, block no longer exists | `null` | `reflow()` deletes and re-places auto blocks constantly; a vanished block was never lived with, so it is pending forever |
| not moved, `chosen_start_at` in the future | `null` | the slot has not arrived — undecided |
| not moved, `chosen_start_at` in the past | `accepted` | the slot arrived and the owner lived with it |

`blockExists` comes from a `LEFT JOIN time_blocks tb ON tb.id = pl.block_id AND tb.owner_id = pl.owner_id`
in the window read — one query, not N.

**The band is built from RESTING hours, not correction destinations.** A row's resting hour
is `moved_hour` when corrected and `chosen_hour` when accepted: *where this kind of work
actually ends up*. Corrections-only would let five moves to 19:00 outweigh two hundred
untouched 09:00 placements and bias everything to the evening. `CORRECTION_FLOOR` still
gates whether a key is learned at all — with no corrections there is nothing to learn, and
the band would only echo what the scheduler already does.

## Before implementation

Read `services/classification-learning.ts` lines 260–310 (`rowOutcome` / `decidedRows`) and
464–545 (`calibrateClassification` — the structure to mirror), `services/calibration.ts`
lines 38–66 (`quantile` / `robustStats`), `jobs/index.ts` lines 373–410 and 485–508,
`server/src/db/migrations/0150_calibrate_classification_job.ts`, and
`jobs/calibrate-estimates.ts`.

## Files impacted

**New:**
- `server/src/db/migrations/0160_calibrate_placement_job.ts`
- `server/test/placement-learning.test.ts`

**Changed:**
- `server/src/services/placement-learning.ts` — grading, window read, band, batch
- `server/src/db/migrations/index.ts` — import + `MIGRATIONS` entry
- `server/src/jobs/index.ts` — one `case`, one `OWNER_SCOPED_KINDS` entry

## Schema required

None beyond ticket 1's tables. Migration `0160` inserts **one row** into the existing
`scheduled_jobs` table and creates nothing.

## Definition of Done

- [ ] Named exported constants, each with a `/** why */`:
      `PLACEMENT_WINDOW_DAYS = 90` (matches `LEARNING_WINDOW_DAYS`),
      `CORRECTION_FLOOR = 5` (above classification's 2 — a drag is one gesture with many
      meanings, and a worse schedule is more disruptive than a wrong tag),
      `MAX_PREFERENCE_KEYS = 50`,
      `MAX_BAND_HOURS = 6`,
      `SURVIVAL_PERIOD_DAYS = 28`
- [ ] `placementOutcome` implements the table above exactly
- [ ] `calibratePlacement(ownerId, now?)` returns
      `{ keys: [{ slotKey, decided, corrections, p25, p50, p75, written }], floor, survival }`
- [ ] A key with fewer than `CORRECTION_FLOOR` corrected rows writes **no** preference row
- [ ] A key whose band is wider than `MAX_BAND_HOURS` (`p75 - p25 > 6`) writes **no** row —
      a six-hour-plus spread is "any time", not a preference, and biasing on it would buy
      fragmentation for noise. This also fences the midnight-wrap case, where linear
      percentiles over hours are meaningless
- [ ] Keys are capped at `MAX_PREFERENCE_KEYS`, ordered by `sample_count` descending then
      `slot_key` ascending (total order)
- [ ] One `placement_survival` row per run, upserted on `(owner_id, computed_date)`;
      `survival_rate` is `NULL` when `decided = 0`
- [ ] `biased` is `1` iff the owner had `placement_preferences` rows **before** this run's
      DELETE — read the count first
- [ ] `calibrate_placement` runs per owner and logs a human sentence, e.g.
      `Placement calibration — work: 31 decided, 8 correction(s), band 17-20h; home: 4 correction(s), under the 5 floor — stock scheduler stands`

## Tests

New `server/test/placement-learning.test.ts`, modelled on
`server/test/classification-learning.test.ts`:

- [ ] Each of the six `placementOutcome` rows, as its own case
- [ ] A block deleted after placement and never moved grades `null`, not `accepted` — the
      reflow-churn guard
- [ ] Below the floor → no preference row; and an existing row for that key is **deleted**,
      not left stale
- [ ] At the floor → a row whose `p50_hour` is the median resting hour
- [ ] Resting-hour rule: 20 accepted at 09 + 5 corrected to 19 → band centred near 09, not 19
- [ ] A spread wider than `MAX_BAND_HOURS` → no row
- [ ] More than `MAX_PREFERENCE_KEYS` keys → exactly 50 rows, the highest `sample_count` kept
- [ ] Rows older than `PLACEMENT_WINDOW_DAYS` are ignored, and a key that ages out entirely
      loses its row
- [ ] Two owners with different evidence get different bands and never see each other's rows
- [ ] Running the batch twice with the same clock is idempotent (same rows, one survival row)
- [ ] `survival_rate` is `NULL` for an owner with no decided rows
- [ ] `biased` is 0 on the first ever run and 1 on the second
- [ ] `migrate.test.ts` passes; `scheduled_jobs` has exactly one `calibrate_placement` row
      after running migrations twice
- [ ] `jobs.test.ts` and `jobs-multiowner.test.ts` pass with the new kind registered

```bash
pnpm --filter server exec vitest run server/test/placement-learning.test.ts
pnpm --filter server exec vitest run server/test/placement-capture.test.ts
pnpm --filter server exec vitest run server/test/migrate.test.ts
pnpm --filter server exec vitest run server/test/learning-loops.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner who has moved `work` blocks to the evening five times, when
      `calibrate_placement` runs, then one `placement_preferences` row exists for `work` with
      an evening band
- [ ] Given the same owner with four such moves, then no row exists
- [ ] Given an owner whose corrections all age past 90 days, when the batch reruns, then
      their row is gone
- [ ] Given no Ollama on the box, then the batch runs and writes identically — it never
      touches a model
- [ ] Given the batch runs, then no `time_blocks` or `tasks` row changes
- [ ] `git diff --stat` touches no file outside the five listed under **Files impacted**

## Subtasks

1. [ ] Read the five sources under **Before implementation**
2. [ ] Add the five constants and `placementOutcome` to `services/placement-learning.ts`
3. [ ] Add the windowed read with the `LEFT JOIN time_blocks` existence check
4. [ ] Add `hourQuantile` and the band builder with the floor and `MAX_BAND_HOURS` guards
5. [ ] Add `calibratePlacement` with the transactional delete-then-insert and the survival upsert
6. [ ] Write `0160_calibrate_placement_job.ts`; register it in `migrations/index.ts`
7. [ ] Add the `case` to `execute()` and the entry to `OWNER_SCOPED_KINDS`
8. [ ] Write `placement-learning.test.ts`
9. [ ] Run the five verification commands
