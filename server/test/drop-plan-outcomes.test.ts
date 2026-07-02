import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0095 from '../src/db/migrations/0095_drop_plan_outcomes.js';

// Isolated in-memory DBs — never touch the shared file DB.
const fresh = () => {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
};
const tableExists = (db: Database, name: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

describe('0095 drop plan_outcomes', () => {
  it('removes the plan_outcomes table and its aggregate_plan_outcomes cron', () => {
    const db = fresh();
    runMigrations(db); // 0083 creates+seeds; 0095 drops both

    // Table is gone (0083 created it, 0095 dropped it).
    expect(tableExists(db, 'plan_outcomes')).toBe(false);

    // The seeded scheduled_jobs row is gone, so the cron runner won't fire a
    // job whose table + handler no longer exist.
    const cron = db
      .prepare(`SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = 'aggregate_plan_outcomes'`)
      .get() as { n: number };
    expect(cron.n).toBe(0);

    // The sibling from 0083 (calibrate_estimates) is untouched.
    expect(tableExists(db, 'estimate_calibration')).toBe(true);
    const calib = db
      .prepare(`SELECT COUNT(*) AS n FROM scheduled_jobs WHERE kind = 'calibrate_estimates'`)
      .get() as { n: number };
    expect(calib.n).toBe(1);

    db.close();
  });

  it('leaves the schema sound (integrity + foreign_key checks clean)', () => {
    const db = fresh();
    runMigrations(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('is idempotent — the runner skips it AND its up() re-runs cleanly', () => {
    const db = fresh();
    runMigrations(db);
    expect(runMigrations(db).applied).toEqual([]);

    // Simulate an existing DB where the retired job had already produced job_runs.
    db.prepare(
      `INSERT INTO scheduled_jobs (id, name, kind, cron)
       VALUES ('job_aggregate_plan_outcomes', 'aggregate_plan_outcomes', 'aggregate_plan_outcomes', '30 1 * * *')`
    ).run();
    db.prepare(
      `INSERT INTO job_runs (id, job_id, status)
       VALUES ('run_aggregate_plan_outcomes', 'job_aggregate_plan_outcomes', 'done')`
    ).run();

    expect(() => m0095.up(db)).not.toThrow();
    expect(tableExists(db, 'plan_outcomes')).toBe(false);
    const run = db
      .prepare(`SELECT job_id FROM job_runs WHERE id = 'run_aggregate_plan_outcomes'`)
      .get() as { job_id: string | null };
    expect(run.job_id).toBeNull();

    db.close();
  });
});
