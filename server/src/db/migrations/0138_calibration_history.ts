import type { Database } from 'better-sqlite3';

export const id = '0138_calibration_history';

/**
 * Append-only calibration history (owner request 2026-07-28: "do not recompute the
 * calibration history").
 *
 * `estimate_calibration` is a REGENERABLE rollup: the nightly job replaces the owner's
 * rows wholesale, which is what makes a scope whose samples vanished (tag deleted, tasks
 * purged) disappear instead of serving stale bias forever. That delete-then-insert is
 * correct for "what is my bias right now" — and fatal for "is my estimating getting
 * better", because every prior reading is destroyed on each run.
 *
 * So: keep the rollup exactly as it is, and accumulate history HERE. One row per
 * (owner, scope, DAY) — keyed by date rather than timestamp so a manual re-run (or a
 * cron retry) overwrites the day's reading instead of stacking duplicates that would
 * weight one day more heavily in any trend line.
 *
 * Nothing prunes this table. A row is ~60 bytes and the job writes at most a few dozen
 * scopes a day; a decade of daily readings is still a rounding error against the task
 * rows themselves, and silently dropping the early history would defeat the whole point.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_history (
      owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      scope_kind    TEXT    NOT NULL,
      scope_ref     TEXT    NOT NULL DEFAULT '',
      computed_date TEXT    NOT NULL,           -- 'YYYY-MM-DD' (owner-local day of the run)
      sample_count  INTEGER NOT NULL DEFAULT 0,
      bias_ratio    REAL,
      p25           REAL,
      p50           REAL,
      p75           REAL,
      PRIMARY KEY (owner_id, scope_kind, scope_ref, computed_date)
    );
    -- The trend read: one scope's readings over time, oldest→newest.
    CREATE INDEX IF NOT EXISTS ix_calibration_history_scope
      ON calibration_history(owner_id, scope_kind, scope_ref, computed_date);
  `);
}
