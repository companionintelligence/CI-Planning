import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations, rebuildTable } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';

// Isolated in-memory DBs — these tests never touch the shared file DB.
const fresh = () => new BetterSqlite3(':memory:');
const cols = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const count = (db: Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migration runner', () => {
  it('applies every migration on a fresh DB and records them', () => {
    const db = fresh();
    const { applied } = runMigrations(db);

    expect(applied.length).toBe(MIGRATIONS.length);
    expect(count(db, 'schema_migrations')).toBe(MIGRATIONS.length);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    // Seed migration ran: owner 1 + cron jobs present; full schema in place.
    expect(db.prepare('SELECT id FROM owners WHERE id = 1').get()).toBeTruthy();
    expect(count(db, 'scheduled_jobs')).toBeGreaterThan(0);
    expect(cols(db, 'daily_summaries')).toContain('focus');
    db.close();
  });

  it('is a no-op on re-run', () => {
    const db = fresh();
    runMigrations(db);
    const before = count(db, 'schema_migrations');
    const { applied } = runMigrations(db);

    expect(applied).toEqual([]);
    expect(count(db, 'schema_migrations')).toBe(before);
    db.close();
  });

  it('adopts an existing 0.2-shaped DB without losing data, and is idempotent', () => {
    const db = fresh();
    // A pre-runner database: tables present, no schema_migrations, and missing the
    // columns that accreted later (notes/task_time/parent_id, timezone/horizon).
    db.exec(`
      CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT);
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
        due_at TEXT, estimated_minutes INTEGER, priority INTEGER DEFAULT 3,
        status TEXT DEFAULT 'open', owner_id INTEGER, source_kind TEXT DEFAULT 'manual',
        source_ref TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
      );
      CREATE TABLE scheduling_prefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER,
        workday_start TEXT DEFAULT '09:00', workday_end TEXT DEFAULT '18:00'
      );
    `);
    db.prepare('INSERT INTO owners (id, name, email) VALUES (1, ?, ?)').run('Existing User', 'e@x.io');
    db.prepare("INSERT INTO tasks (title, priority, status, owner_id) VALUES ('Old task', 2, 'open', 1)").run();
    db.prepare('INSERT INTO scheduling_prefs (owner_id) VALUES (1)').run();

    const { applied } = runMigrations(db);
    expect(applied.length).toBe(MIGRATIONS.length);

    // Existing rows preserved; seed did not clobber the existing owner.
    expect((db.prepare('SELECT title FROM tasks WHERE id = 1').get() as { title: string }).title).toBe('Old task');
    expect((db.prepare('SELECT name FROM owners WHERE id = 1').get() as { name: string }).name).toBe('Existing User');

    // Missing columns were added; timezone backfilled (never null for the scheduler).
    expect(cols(db, 'tasks')).toEqual(expect.arrayContaining(['notes', 'task_time', 'parent_id']));
    expect(cols(db, 'scheduling_prefs')).toEqual(expect.arrayContaining(['timezone', 'planning_horizon_days']));
    const tz = (db.prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = 1').get() as { timezone: string }).timezone;
    expect(tz).toBeTruthy();

    // Second run changes nothing.
    expect(runMigrations(db).applied).toEqual([]);
    db.close();
  });
});

describe('rebuildTable helper', () => {
  it('rebuilds a table to a new shape, preserving rows and restoring foreign_keys', () => {
    const db = fresh();
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);`);
    db.prepare('INSERT INTO widgets (id, name) VALUES (1, ?), (2, ?)').run('alpha', 'beta');

    rebuildTable(db, {
      table: 'widgets',
      createNewSql: `CREATE TABLE widgets_new (id INTEGER PRIMARY KEY, name TEXT, color TEXT DEFAULT 'red')`,
      columns: 'id, name',
    });

    expect(count(db, 'widgets')).toBe(2);
    expect(cols(db, 'widgets')).toContain('color');
    const row = db.prepare('SELECT name, color FROM widgets WHERE id = 1').get() as { name: string; color: string };
    expect(row.name).toBe('alpha');
    expect(row.color).toBe('red'); // default applied to copied rows
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // restored
    db.close();
  });
});
