import type { Database } from 'better-sqlite3';

export const id = '0162_plan_loop_learning';

/**
 * Phase M §A0 authoring loop — the durable evidence store `agents/loop.ts` never
 * got. Clause 5 of the loop's contract (loop.ts:6-18) promises an append-only
 * revision log, but the default sink is `writeAudit` (loop.ts:133), and
 * `grep -rn "FROM audit_log" server/src` returns no matches — the row lands in the
 * write-only `audit_log.entity` TEXT column, truncated at 4000 chars, and nothing
 * ever reads it back. Three tables, in the shape `classification_log` /
 * `classification_accuracy` already established (0149_classification_learning.ts):
 *
 *  - `plan_loop_runs` is one row per `runLoop()` invocation — the outcome
 *    (`LoopResult` minus `revisions`/`candidate`). Its `id` doubles as the
 *    `run_id` its revisions carry.
 *  - `plan_revision_log` is DURABLE EVIDENCE — one row per candidate the loop
 *    scored (`Revision`), append-only, never pruned. `run_id` is an indexed TEXT
 *    column, deliberately NOT a foreign key to `plan_loop_runs`: revisions are
 *    written DURING the run, before the run's own row exists, and a crash between
 *    the last revision and the final `plan_loop_runs` insert must not take the
 *    evidence down with it.
 *  - `plan_loop_stats` is the MEASUREMENT — one row per (owner, stage,
 *    computed_date) written by the weekly `calibrate_plan_loop` job over its
 *    trailing window. Rates are stored, not derived: a week with zero runs must
 *    leave `avg_iterations`/`pass_rate` NULL rather than 0, so a trend draws a gap
 *    instead of a false floor (the `classification_accuracy` rationale,
 *    0149_classification_learning.ts:72-73).
 *
 * `stage` ('order' today), `reason` and `escape_reason` are bare TEXT enforced in
 * code, not CHECK constraints (repo convention). None of these three are mirrored
 * in schema.ts: like `calibration_history` (0138) and `classification_log` (0149),
 * they are read and written through raw SQL only.
 */
export function up(db: Database): void {
  db.exec(`
    -- One row per runLoop() invocation: the outcome. Written by agents/plan.ts AFTER
    -- the loop returns (ticket 2). id doubles as the run_id its revisions carry.
    CREATE TABLE IF NOT EXISTS plan_loop_runs (
      id            TEXT PRIMARY KEY,
      owner_id      TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      stage         TEXT NOT NULL,              -- 'order' today; code-enforced enum
      passed        INTEGER NOT NULL,           -- 0 | 1 (LoopResult.passed)
      escaped       INTEGER NOT NULL,           -- 0 | 1 (LoopResult.escaped)
      escape_reason TEXT,                       -- 'plateau'|'max-iterations'|'budget'; NULL when passed
      score         REAL NOT NULL,              -- LoopResult.score (best judge median in [0,1]; 0 when every candidate failed a deterministic check)
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
  `);
}
