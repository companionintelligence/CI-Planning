> **Type:** DB Migration
> **Phase:** Close-loop wave — dismissed suggestions
> **Branch:** `feat/dismissal-evidence-schema`
> **Commit style:** `feat(db): 0157 dismissal evidence log, exemplar rollup and noise-rate table`
> **Design:** [README.md](README.md)
> **Dependencies:** None — ticket 1 of 6

## Goal

Land the storage the loop needs, in one migration at slot `0157`, mirroring
`0149_classification_learning.ts` end to end. Three tables in the same three-role split the
house pattern uses (`classification_log` → `classification_exemplars` →
`classification_accuracy`):

1. **`possible_outcome_log`** — durable, append-only evidence. One row per decided
   suggestion. Carries `decided_at`, which is the load-bearing part: `possible_tasks` has
   **no `dismissed_at` today**, so nothing records when a suggestion was rejected, and the
   learning window, the settling fence and the rate period all hang off this stamp.
2. **`possible_dismissal_exemplars`** — regenerable rollup; the retrieval index the
   extraction prompt reads.
3. **`possible_dismissal_rate`** — measurement, so ticket 6 can show whether the loop
   actually reduces noise.

This ticket lands three empty tables and nothing else.

## Non-goals

- **No `possible_tasks` column.** Do not add `dismissed_at`. It would break
  `server/test/schema-parity.test.ts` (the table *is* modelled, `schema.ts:110`) and the
  pinned `GET /api/possible-tasks` snapshot in `baseline.characterization.test.ts.snap`,
  which serialises every column.
- **No `schema.ts` change.** These are raw-SQL-only tables, exactly like
  `classification_log` / `classification_exemplars` / `classification_accuracy` (0149),
  `triality_weights` (0142) and `calibration_history` (0138). Verified:
  `grep -c classification server/src/db/schema.ts` → `0`, and parity is green.
  `schema-parity.test.ts` iterates only what `schema.ts` exports, so a migration-only table
  is invisible to it.
- **No service, no reads, no writes.** Capture is ticket 2; the batch is ticket 3.
- **No cron row and no job kind.** The `calibrate_dismissals` seed is migration `0158` in
  ticket 3 — one concern per file, as `0149` → `0150` does. Do not touch
  `server/src/jobs/index.ts`, `OWNER_SCOPED_KINDS`, `README.md` or `ARCHITECTURE.md`.
- **No route and no client change.** The route is ticket 6; there is no client surface for
  this feature.
- **No suppression column and nothing that enables one** — no `suppressed`, `blocked`,
  `blocklist` or `never_suggest`. The rollup is a retrieval index, not a deny-list.
- **No learning-rate knob** — no `weight`, `decay`, `alpha` or tunable strength.
  `period_days` records what window a reading covered; nothing reads it back to change
  behaviour.
- **No CHECK constraints.** `outcome` and `source_kind` are bare `TEXT` with a `--`
  vocabulary comment (repo convention, stated in 0140, 0142, 0149, 0151).
- **No FK from the log to `possible_tasks`.** `resetDb()` clears `possible_tasks`
  wholesale, so a cascade would erase the corpus between test files.
- **No UNIQUE on `(possible_task_id, outcome)`** — matching `classification_log`, which has
  none. Double-logging is ticket 2's problem to solve in code.
- **No backfill.** Existing `status='dismissed'` rows are untimestamped, which is why
  `decided_at` exists.
- **No `manual = true`.** That flag exists only for CON-1 rebuilds that toggle
  `PRAGMA foreign_keys`. `CREATE TABLE IF NOT EXISTS` runs inside the runner's transaction.
- **Do not touch `server/src/lib/owners.ts`.** Verified: none of the three classification
  tables appear in `purgeOwnerData()` or `NON_PORTABLE_OWNER_TABLES`; the
  `ON DELETE CASCADE` sweeps them from `DELETE FROM owners`. Follow that precedent and say
  so in the PR description so the omission reads as deliberate.
- **Do not add these to `OWNER_SCOPED_TABLES` in `server/test/owner-delete.test.ts`.** That
  list is asserted to have rows *before* the delete, so an entry without a `populate()` seed
  fails. `classification_log` is deliberately absent there despite the same cascade.
- **Do not "fix" `server/src/scripts/check-schema-drift.ts`.** Its prose hardcodes a table
  count these three will change. Verified it is not wired into CI (it is the manual
  `pnpm --filter server db:check-drift`), so nothing fails.

## Pinned conventions

Verified against the tree — do not substitute.

- **File skeleton.** Line 1 is exactly `import type { Database } from 'better-sqlite3';`
  (type-only). Then `export const id = '0157_dismissal_evidence';`, a block comment
  explaining *why*, then `export function up(db: Database): void`. All 154 numbered
  migrations follow this with zero exceptions.
- **Registration.** `server/src/db/migrations/index.ts` — add
  `import * as m0157 from './0157_dismissal_evidence.js';` in numeric order and append
  `m0157` to the exported `MIGRATIONS` array. The `.js` extension is required (ESM).
- **Idempotent, forward-only, additive.** `CREATE TABLE IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS` throughout; no `down`.
- **Owner column.** `owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE`.
  (Note `possible_tasks` itself uses `proposed_owner_id` — the log does **not** copy that
  name; it is a normal owner-scoped table.)
- **Timestamps.** ISO-8601 `TEXT`, stamped in code via `new Date().toISOString()`. Never a
  SQL `CURRENT_TIMESTAMP` default on a decision stamp.
- **Enums are TEXT enforced in code**, documented by a trailing `--` comment.
- **Index naming.** `ix_<table>_<cols>`, each with a `--` comment naming the read it
  serves. No index redundant with a PK prefix.
- **Rollup shape.** `classification_exemplars` has a composite PK, no surrogate `id` and no
  index — every read is a PK-prefix scan on `owner_id`. Mirror that.
- **`resetDb()`** lives in `server/test/helpers.ts`; add one `DELETE FROM` per new table
  with a `-- 0157:` justification comment. The rollup is read by a production path, so a
  leftover row would silently bend another test file's prompt.

## Before implementation

Read, in order: `server/src/db/migrations/0149_classification_learning.ts` (the template),
`0156_capacity_hours_per_week.ts` (the latest slot and current house style),
`server/src/db/migrations/index.ts`, `server/test/helpers.ts` (`resetDb`), and
`server/test/schema-parity.test.ts` (to confirm why no `schema.ts` change is needed).

## Files impacted

**New:**
- `server/src/db/migrations/0157_dismissal_evidence.ts`

**Changed:**
- `server/src/db/migrations/index.ts` — import + `MIGRATIONS` entry
- `server/test/helpers.ts` — three `DELETE FROM`s in `resetDb()`
- the baseline characterization snapshot, if regenerating changes it

## Schema required

```sql
CREATE TABLE IF NOT EXISTS possible_outcome_log (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  -- Nullable and deliberately NOT a foreign key: the evidence outlives the suggestion.
  -- That the owner threw this away is a fact about what they consider noise, and pruning
  -- the possible must not delete what it taught. (resetDb() clears possible_tasks
  -- wholesale, so a cascade here would erase the corpus between test files.)
  possible_task_id TEXT,
  source_kind      TEXT,          -- 'gmail' | 'gcal' | 'text'; NULL when the possible had none
  input_text       TEXT NOT NULL, -- what the extractor proposed (raw_title [+ raw_summary])
  outcome          TEXT NOT NULL, -- 'dismissed' | 'promoted'
  -- No SQL default, by design: the service stamps this at the moment of the click.
  -- NOTE the format differs from possible_tasks.created_at (CURRENT_TIMESTAMP,
  -- space-separated) — never compare the two as strings.
  decided_at       TEXT NOT NULL,
  local_date       TEXT NOT NULL  -- 'YYYY-MM-DD', owner-local day it was decided
);
-- The learning read: one owner's decided rows over a date window.
CREATE INDEX IF NOT EXISTS ix_possible_outcome_log_owner_date
  ON possible_outcome_log(owner_id, local_date);
-- The reversal/dedupe read: every outcome recorded for one suggestion — so a dismissal
-- later reversed by a promote can be fenced out, and a repeated dismiss collapsed.
CREATE INDEX IF NOT EXISTS ix_possible_outcome_log_possible
  ON possible_outcome_log(possible_task_id);

CREATE TABLE IF NOT EXISTS possible_dismissal_exemplars (
  owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  log_id        TEXT    NOT NULL,       -- the possible_outcome_log row it came from
  input_text    TEXT    NOT NULL,
  source_kind   TEXT,
  -- Float32 little-endian, as sqlite-vec wants it. NULL when the run had no embedder:
  -- still a usable exemplar for the priors line, just not retrievable by similarity.
  embedding     BLOB,
  computed_date TEXT    NOT NULL,
  PRIMARY KEY (owner_id, log_id)
);

CREATE TABLE IF NOT EXISTS possible_dismissal_rate (
  owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  computed_date TEXT    NOT NULL,       -- 'YYYY-MM-DD', owner-local day of the run
  -- A recorded PARAMETER of the reading (the peer of classification_accuracy.held_out),
  -- not a tunable: nothing reads it back to change behaviour.
  period_days   INTEGER NOT NULL,
  created       INTEGER NOT NULL,       -- suggestions produced in the period
  decided       INTEGER NOT NULL,       -- dismissed + promoted in the period
  dismissed     INTEGER NOT NULL,
  -- Stored rather than derived, and NULL when decided = 0, so an unmeasured period is
  -- distinguishable from one that scored 0%. The trend must never plot unknown as zero.
  rate          REAL,
  exemplars     INTEGER NOT NULL,       -- rollup size at the end of the run
  hinted        INTEGER NOT NULL,       -- 0 | 1: was the extractor hinted during the period
  PRIMARY KEY (owner_id, computed_date)
);
```

## Definition of Done

- [ ] `0157_dismissal_evidence.ts` exists, matches the pinned skeleton, and is registered in
      `migrations/index.ts` in numeric order
- [ ] All three tables and both indexes are created, idempotently
- [ ] `resetDb()` clears all three, each with a `-- 0157:` comment
- [ ] `schema.ts` is unchanged and `schema-parity.test.ts` still passes
- [ ] `possible_tasks` is unchanged and the characterization snapshot is unaffected
- [ ] Running the migration twice is a no-op

## Tests

- [ ] `migrations.test.ts` (or the existing equivalent) still passes with 155 migrations
- [ ] A test asserting all three tables exist after `runMigrations`, via
      `SELECT name FROM sqlite_master WHERE type='table'`
- [ ] A test asserting both indexes exist, via
      `SELECT name FROM sqlite_master WHERE type='index'`
- [ ] Re-running `up()` on an already-migrated DB throws nothing
- [ ] `schema-parity.test.ts` passes unchanged
- [ ] `baseline.characterization.test.ts` passes with no snapshot churn

```bash
pnpm --filter server exec vitest run server/test/schema-parity.test.ts
pnpm --filter server exec vitest run server/test/baseline.characterization.test.ts
pnpm --filter server exec vitest run server/test/migrations.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given a fresh DB, when migrations run, then `possible_outcome_log`,
      `possible_dismissal_exemplars` and `possible_dismissal_rate` all exist
- [ ] Given an already-migrated DB, when migrations run again, then nothing changes and
      nothing throws
- [ ] Given an owner is deleted, then their rows in all three tables are removed by cascade
- [ ] `git diff --stat` touches no file outside the four listed under **Files impacted**

## Subtasks

1. [ ] Read `0149_classification_learning.ts` and `0156_capacity_hours_per_week.ts`
2. [ ] Write `0157_dismissal_evidence.ts` with the DDL above and a block comment saying why
       the evidence log exists (no `dismissed_at` today) and why there is no FK to
       `possible_tasks`
3. [ ] Register it in `migrations/index.ts`
4. [ ] Add the three `DELETE FROM`s to `resetDb()`
5. [ ] Add the table/index existence and idempotency tests
6. [ ] Run the four verification commands; confirm no snapshot churn
