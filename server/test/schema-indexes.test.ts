import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0092 from '../src/db/migrations/0092_fk_indexes.js';

// Isolated in-memory DBs — these tests never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');
const indexNames = (db: Database) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((i) => i.name);

// The FK-index coverage added by migration 0092 (Q2 schema hygiene).
const EXPECTED = [
  'ix_time_blocks_task',
  'ix_time_blocks_category',
  'ix_reminders_task',
  'ix_reminders_block',
  'ix_tasks_parent',
  'ix_tasks_recurrence_parent',
  'ix_job_runs_job',
  'ix_daily_plan_block',
  'ix_possible_tasks_proposed_owner',
  'ix_possible_tasks_promoted_task',
];

describe('0092 FK index coverage', () => {
  it('creates every FK-path index', () => {
    const db = fresh();
    runMigrations(db);
    const present = new Set(indexNames(db));
    for (const name of EXPECTED) expect(present.has(name), `missing index ${name}`).toBe(true);
    db.close();
  });

  it('is a no-op on re-run (idempotent, no duplicate-index error)', () => {
    const db = fresh();
    runMigrations(db);
    // (a) the runner's bookkeeping skips an already-recorded migration.
    expect(runMigrations(db).applied).toEqual([]);
    // (b) the migration's OWN body re-run: invoking up() directly a second time
    // must not throw or duplicate indexes (exercises the CREATE INDEX IF NOT
    // EXISTS idempotency, which the runner-skip alone never reaches).
    expect(() => m0092.up(db)).not.toThrow();
    // Each index exists exactly once.
    const counts = indexNames(db).reduce<Record<string, number>>((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {});
    for (const name of EXPECTED) expect(counts[name]).toBe(1);
    db.close();
  });

  it('a task-delete cascade path plans against an index, not a full table scan', () => {
    const db = fresh();
    runMigrations(db);
    // Deleting a task cascades to time_blocks(task_id); with ix_time_blocks_task the
    // planner uses the index instead of SCANning the whole blocks table.
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM time_blocks WHERE task_id = ?`)
      .all('00000000-0000-7000-8000-0000000000c1') as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toMatch(/USING (COVERING )?INDEX ix_time_blocks_task/);
    expect(detail).not.toMatch(/SCAN time_blocks/);
    db.close();
  });
});
