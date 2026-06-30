import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0083_learning_loops';

/**
 * Phase N4 — estimate calibration + plan outcomes.
 *
 * estimate_calibration: one row per owner with the latest computed bias stats.
 *   bias_ratio = median(actual_minutes / estimated_minutes) across completed tasks
 *   that have both fields filled in. A ratio of 1.3 means "takes 30% longer".
 *   p25/p50/p75 are the quartiles of that ratio distribution.
 *
 * plan_outcomes: one row per (owner, date) recording how many scheduled task-
 *   blocks were completed that day. Populated by the nightly aggregate_plan_outcomes
 *   job (runs at 01:30 for the day that just closed).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS estimate_calibration (
      owner_id   TEXT NOT NULL PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
      computed_at TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      bias_ratio  REAL,
      p25         REAL,
      p50         REAL,
      p75         REAL
    );

    CREATE TABLE IF NOT EXISTS plan_outcomes (
      owner_id  TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      planned   INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_id, date)
    );
  `);

  // Seed calibrate_estimates: weekly Sunday 04:00 — after the week's work is done.
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'calibrate_estimates', 'calibrate_estimates', '0 4 * * 0');

  // Seed aggregate_plan_outcomes: nightly 01:30 — after review_day at 01:00.
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`,
  ).run(newId(), 'aggregate_plan_outcomes', 'aggregate_plan_outcomes', '30 1 * * *');
}
