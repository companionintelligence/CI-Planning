import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import * as m0092 from '../src/db/migrations/0092_fk_indexes.js';
import * as m0112 from '../src/db/migrations/0112_graphql_perf_indexes.js';

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

// The GraphQL keyset-pagination perf indexes added by migration 0112 (Phase W close).
const GRAPHQL_INDEXES = [
  'idx_tags_owner_kind_name_id',
  'idx_tag_directions_dir_int',
  'idx_tag_categories_cat_int',
];
// The single-column prefixes 0112 drops as redundant (superseded by the composites above).
const DROPPED_SINGLES = ['idx_tag_directions_direction', 'ix_tag_categories_cat'];

describe('0112 GraphQL perf indexes', () => {
  it('creates the three keyset indexes and drops the two redundant single-column prefixes', () => {
    const db = fresh();
    runMigrations(db);
    const present = new Set(indexNames(db));
    for (const name of GRAPHQL_INDEXES) expect(present.has(name), `missing index ${name}`).toBe(true);
    for (const name of DROPPED_SINGLES) expect(present.has(name), `stale index ${name} not dropped`).toBe(false);
    db.close();
  });

  it('is a no-op on re-run (idempotent — CREATE/DROP INDEX IF [NOT] EXISTS)', () => {
    const db = fresh();
    runMigrations(db);
    expect(() => m0112.up(db)).not.toThrow();
    const counts = indexNames(db).reduce<Record<string, number>>((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {});
    for (const name of GRAPHQL_INDEXES) expect(counts[name]).toBe(1);
    db.close();
  });

  it('serves the tags(kind:) keyset connection with NO temp b-tree sort', () => {
    const db = fresh();
    runMigrations(db);
    // The pageOwnerTagsByKind statement (services/tags.ts): the (owner_id, kind, name, id)
    // index must satisfy BOTH the WHERE seek AND the ORDER BY name, id — no sort step.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT t.id, t.name, t.kind FROM tags t
           WHERE t.owner_id = ? AND t.kind = ?
             AND (t.name > ? OR (t.name = ? AND t.id > ?)) ORDER BY t.name, t.id LIMIT ?`,
      )
      .all('o', 'intention', '', '', '', 10) as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_tags_owner_kind_name_id/);
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    db.close();
  });
});
