> **Type:** DB Migration
> **Phase:** Revision-loop wave — the agent loop's write-only log
> **Branch:** `feat/plan-loop-evidence-schema`
> **Commit style:** `feat(learning): plan-loop evidence + stats tables (0162)`
> **Design:** [README.md](README.md)
> **Dependencies:** None. Blocks tickets 2–4.

## Goal

Create the durable, owner-scoped storage for the §A0 authoring loop's evidence:
one table for loop runs, one for the per-iteration revisions inside them, and one
for the weekly measured rollup. This is the capture→batch→read loop's foundation —
today the only sink is a truncated JSON blob in `audit_log.entity` that nothing can
parse back.

## Non-goals

- **Do not touch `audit_log`** — no new columns, no readers, no index changes, no
  edits to `server/src/lib/audit.ts` or to `schema.ts:800`. Its append-only forensic
  contract is load-bearing (`routes/backup.ts:129`, `lib/owners.ts:306`).
- **Do not model the new tables in `server/src/db/schema.ts`.** Learning tables are
  raw-SQL-only by convention (see `0149_classification_learning.ts:23-25` citing
  `calibration_history` and `triality_weights`). `schema-parity.test.ts` iterates
  only what schema.ts exports, so omission is safe by construction.
- **Do not write any code that inserts rows** — that is ticket 2 (capture) and
  ticket 3 (stats). This ticket is schema + test-reset plumbing only.
- **Do not add CHECK constraints.** Enums (`stage`, `reason`, `escape_reason`) are
  bare TEXT enforced in code — repo convention.
- **Do not seed a cron row** — that is ticket 3's migration (0163), following the
  0149→0150 table/seed split.
- **Do not add pruning.** Append-only like `calibration_history`; volume is ≤ ~4
  rows per owner per day.

## Pinned conventions

- **File:** `server/src/db/migrations/0162_plan_loop_learning.ts`. Line 1 is
  `import type { Database } from 'better-sqlite3';`, then
  `export const id = '0162_plan_loop_learning';`, then a block comment explaining
  WHY (the write-only-log gap; cite that `grep -rn "FROM audit_log" server/src` is
  empty), then `export function up(db: Database): void` containing one `db.exec`
  template literal. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
  EXISTS`), forward-only, **no `down`**, no `manual` flag (plain DDL).
- **Register** in `server/src/db/migrations/index.ts`: add
  `import * as m0162 from './0162_plan_loop_learning.js';` (note the `.js`
  extension) in numeric order, and append `m0162` to the END of the `MIGRATIONS`
  array.
- **Ids:** TEXT primary keys minted in code via `newId()` (UUIDv7) — the migration
  itself mints nothing.
- **Timestamps:** `at TEXT NOT NULL` with **no DB default** — stamped in code with
  `new Date().toISOString()` (the 0131 convention: code-stamped ISO-8601, NOT
  `CURRENT_TIMESTAMP`). `computed_date` is `'YYYY-MM-DD'` in the owner's local
  timezone, computed by the job (ticket 3).
- **Owner FK:** `owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE`
  on all three tables (the learning-table norm — deliberately unlike `audit_log`,
  which has no CASCADE and is hand-purged).
- **Index names:** `ix_<table>_<cols>`, each with a `--` comment naming the read it
  serves.
- ⚠️ **Slot collision:** 0157–0158 are reserved by the close-loop wave; the G-INT
  and N2 waves are planned in parallel. Before branching, run
  `ls server/src/db/migrations | tail -3` — if 0162 is taken, renumber this file,
  ticket 3's 0163, and both tickets' texts.

## Before implementation

Read `server/src/db/migrations/0149_classification_learning.ts` in full (the shape
this copies: evidence + measurement tables, comment style, no-FK-to-content
rationale), `0138`'s and `0140`'s comments in `server/test/helpers.ts:66-73` (why
append-only tables must be cleared in resetDb), and `server/src/agents/loop.ts:48-71`
(the `Revision` and `LoopResult` shapes these columns mirror).

## Files impacted

**New:**
- `server/src/db/migrations/0162_plan_loop_learning.ts`

**Changed:**
- `server/src/db/migrations/index.ts` — import + append `m0162`
- `server/test/helpers.ts` — three `DELETE FROM` lines in `resetDb()` (see below)

## Schema required

```sql
-- One row per runLoop() invocation: the outcome. Written by agents/plan.ts AFTER
-- the loop returns (ticket 2). id doubles as the run_id its revisions carry.
CREATE TABLE IF NOT EXISTS plan_loop_runs (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,              -- 'order' today; code-enforced enum
  passed        INTEGER NOT NULL,           -- 0 | 1 (LoopResult.passed)
  escaped       INTEGER NOT NULL,           -- 0 | 1 (LoopResult.escaped)
  escape_reason TEXT,                       -- 'plateau'|'max-iterations'|'budget'; NULL when passed
  score         REAL NOT NULL,              -- LoopResult.score (best judge median; -1 if none cleared checks)
  iterations    INTEGER NOT NULL,
  at            TEXT NOT NULL               -- ISO-8601, stamped in code
);
-- The batch pass scans one owner's recent runs (ticket 3).
CREATE INDEX IF NOT EXISTS ix_plan_loop_runs_owner_at ON plan_loop_runs(owner_id, at);

-- One row per revision inside a run: the evidence. run_id is indexed TEXT, NOT a
-- foreign key: revisions are written DURING the run, before the runs row exists,
-- and evidence must not vanish if the run row never lands (crash mid-loop).
CREATE TABLE IF NOT EXISTS plan_revision_log (
  id        TEXT PRIMARY KEY,
  owner_id  TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  run_id    TEXT NOT NULL,
  stage     TEXT NOT NULL,
  iter      INTEGER NOT NULL,               -- 1-based (Revision.iter)
  score     REAL NOT NULL,                  -- judge median in [0,1]; 0 on deterministic-fail
  reason    TEXT NOT NULL,                  -- 'deterministic-fail'|'judged'|'passed-no-judge'
  defects   TEXT NOT NULL,                  -- JSON array of rule codes, e.g. '["priority_inversion"]'; '[]' when clean
  critique  TEXT NOT NULL,                  -- judge critique, capped in code; '' when none
  candidate TEXT,                           -- JSON of Revision.candidate; NULL if serialized form exceeds the code cap
  at        TEXT NOT NULL
);
-- Drill-down: all revisions of one run, in order.
CREATE INDEX IF NOT EXISTS ix_plan_revision_log_run ON plan_revision_log(run_id, iter);
-- Owner-window scans (batch + any future defect-frequency rollup).
CREATE INDEX IF NOT EXISTS ix_plan_revision_log_owner_at ON plan_revision_log(owner_id, at);

-- The measurement: one row per (owner, stage, run-date) written by the weekly
-- calibrate_plan_loop job over its trailing window. Rates are stored, not derived,
-- so "no runs that week" is NULL — a trend must draw a gap, never a 0 (the
-- classification_accuracy rationale, 0149:72-73).
CREATE TABLE IF NOT EXISTS plan_loop_stats (
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL,
  computed_date  TEXT NOT NULL,             -- 'YYYY-MM-DD', owner-local day of the run
  period_days    INTEGER NOT NULL,          -- always 7 today; stored so the window is self-describing
  runs           INTEGER NOT NULL,
  passed         INTEGER NOT NULL,
  escaped        INTEGER NOT NULL,
  first_try_pass INTEGER NOT NULL,          -- passed with iterations = 1
  avg_iterations REAL,                      -- NULL when runs = 0
  pass_rate      REAL,                      -- passed/runs; NULL when runs = 0
  PRIMARY KEY (owner_id, stage, computed_date)
);
```

## Definition of Done

- [ ] Migration 0162 exists, matches the conventions above, and is registered last
      in `MIGRATIONS`
- [ ] A fresh DB migrates cleanly; re-running the migration is a no-op
- [ ] `resetDb()` in `server/test/helpers.ts` deletes from all three tables (add
      after the `planning_sessions` line, with a one-line comment noting
      `plan_revision_log`/`plan_loop_runs` are append-only by design — the
      `calibration_history` contamination argument at helpers.ts:66)
- [ ] None of the three tables appears in `server/src/db/schema.ts`
- [ ] `pnpm typecheck` and the full suite pass

## Tests

No new test file — schema-only migrations are covered by the migration runner and
the suite booting against the migrated DB (the 0149 precedent adds none either).

- [ ] Full suite green (proves resetDb's new DELETEs name real tables and the
      migration applies in every test boot)
- [ ] `server/test/schema-parity.test.ts` still green (proves nothing was modelled)

```bash
pnpm --filter server exec vitest run server/test/schema-parity.test.ts
pnpm typecheck
pnpm test
```

## Acceptance Criteria

- [ ] Given a fresh install, when the server boots, then all three tables exist
      with the exact columns, defaults and index names above
- [ ] Given an owner is deleted via the account-deletion primitive, then their rows
      in all three tables are gone (CASCADE — no edit to `lib/owners.ts` needed)
- [ ] Given the migration runs twice, the second run changes nothing

## Subtasks

1. [ ] Check `ls server/src/db/migrations | tail -3` for slot collisions; renumber if needed
2. [ ] Write `0162_plan_loop_learning.ts` (header comment: the gap, the no-FK-on-run_id rationale, the NULL-vs-0 rationale)
3. [ ] Register `m0162` in `migrations/index.ts`
4. [ ] Add the three `DELETE FROM` lines + comment to `resetDb()`
5. [ ] Run the verification commands
