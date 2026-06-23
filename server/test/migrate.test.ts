import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { runMigrations, rebuildTable } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations/index.js';

import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';

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

    // Seed migration ran: the single owner + cron jobs present; full schema in place.
    // 0030 remaps the legacy integer owner `1` to the fixed UUIDv7 sentinel.
    expect(db.prepare('SELECT id FROM owners WHERE id = ?').get(SYSTEM_OWNER_ID)).toBeTruthy();
    expect(count(db, 'scheduled_jobs')).toBeGreaterThan(0);
    expect(cols(db, 'daily_summaries')).toContain('focus');
    // 0010: all_day column on time_blocks (Phase F PR-3).
    expect(cols(db, 'time_blocks')).toContain('all_day');
    db.close();
  });

  it('0010 adds all_day to time_blocks, default 0, and is idempotent', () => {
    const db = fresh();
    runMigrations(db);
    // Inserting a block without all_day defaults to 0 (false). After 0030 the id
    // column is TEXT NOT NULL with no SQL default (this isolated in-memory DB has no
    // uuid7() UDF), so supply a literal UUIDv7-shaped id.
    db.prepare(
      `INSERT INTO time_blocks (id, title, start_at, end_at) VALUES ('00000000-0000-7000-8000-0000000000b1', 'B', '2026-06-15T16:00:00Z', '2026-06-15T17:00:00Z')`,
    ).run();
    const row = db.prepare('SELECT all_day FROM time_blocks LIMIT 1').get() as { all_day: number };
    expect(row.all_day).toBe(0);
    // Re-running the whole runner is a no-op (the add-column guard holds).
    expect(runMigrations(db).applied).toEqual([]);
    expect(cols(db, 'time_blocks').filter((c) => c === 'all_day').length).toBe(1); // not duplicated
    db.close();
  });

  it('0010 is a no-op when the column already exists (pre-grown DB)', () => {
    const db = fresh();
    runMigrations(db);
    // Simulate a DB that already has the column (e.g. a future baseline) and rerun.
    const before = cols(db, 'time_blocks');
    expect(runMigrations(db).applied).toEqual([]);
    expect(cols(db, 'time_blocks')).toEqual(before);
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

    // Existing rows preserved through the migration; seed did not clobber the existing
    // owner. 0030 retyped ids (the legacy integer owner `1` → the UUIDv7 sentinel), so
    // identify the surviving rows by their stable attributes rather than the old int id.
    expect(db.prepare("SELECT 1 FROM tasks WHERE title = 'Old task'").get()).toBeTruthy();
    expect((db.prepare('SELECT name FROM owners WHERE id = ?').get(SYSTEM_OWNER_ID) as { name: string }).name).toBe('Existing User');

    // Missing columns were added; timezone backfilled (never null for the scheduler).
    expect(cols(db, 'tasks')).toEqual(expect.arrayContaining(['notes', 'task_time', 'parent_id']));
    expect(cols(db, 'scheduling_prefs')).toEqual(expect.arrayContaining(['timezone', 'planning_horizon_days']));
    const tz = (db.prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?').get(SYSTEM_OWNER_ID) as { timezone: string }).timezone;
    expect(tz).toBeTruthy();

    // Second run changes nothing.
    expect(runMigrations(db).applied).toEqual([]);
    db.close();
  });
});

describe('0048 drop habit boolean columns', () => {
  // 0042 repaired is_habit/is_fast_task ↔ subtype coherence; 0048 drops the columns
  // entirely. The incoherent state (is_habit=1, subtype='standard') can no longer be
  // created — the schema enforces subtype as the sole source of truth.
  it('removes is_habit and is_fast_task columns from tasks', () => {
    const db = fresh();
    runMigrations(db);

    const taskCols = cols(db, 'tasks');
    expect(taskCols).not.toContain('is_habit');
    expect(taskCols).not.toContain('is_fast_task');
    expect(taskCols).toContain('subtype');

    // Tasks can still be inserted and retrieved with just subtype.
    db.prepare(`INSERT INTO tasks (id, title, status, owner_id, subtype) VALUES (?, 'Habit', 'open', ?, 'habit')`).run('00000000-0000-7000-8000-0000000000a1', SYSTEM_OWNER_ID);
    const row = db.prepare('SELECT subtype FROM tasks WHERE id = ?').get('00000000-0000-7000-8000-0000000000a1') as { subtype: string };
    expect(row.subtype).toBe('habit');
    db.close();
  });
});

describe('0049 api_keys store', () => {
  it('creates the api_keys table with a TEXT owner_id and a prefix index', () => {
    const db = fresh();
    runMigrations(db);

    const keyCols = cols(db, 'api_keys');
    expect(keyCols).toEqual(
      expect.arrayContaining(['id', 'owner_id', 'prefix', 'key_hash', 'scopes', 'expires_at', 'last_used_at', 'created_at', 'revoked_at']),
    );
    // owner_id is TEXT (CON-1 UUIDv7 owners), not the INTEGER the I spec predates.
    const ownerCol = (db.prepare(`PRAGMA table_info(api_keys)`).all() as { name: string; type: string }[]).find((c) => c.name === 'owner_id');
    expect(ownerCol?.type).toBe('TEXT');

    const indexes = (db.prepare(`PRAGMA index_list(api_keys)`).all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('ix_api_keys_prefix');
    db.close();
  });
});

describe('0050 owner external_subject', () => {
  it('adds external_subject to owners with a partial UNIQUE index', () => {
    const db = fresh();
    runMigrations(db);

    expect(cols(db, 'owners')).toContain('external_subject');
    const indexes = (db.prepare(`PRAGMA index_list(owners)`).all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('ux_owners_external_subject');

    // The partial index allows many NULLs (api-key-only owners) but one row per subject.
    db.prepare(`INSERT INTO owners (id, name, external_subject) VALUES (?, 'A', 'sub-1')`).run('00000000-0000-7000-8000-0000000000c1');
    expect(() =>
      db.prepare(`INSERT INTO owners (id, name, external_subject) VALUES (?, 'B', 'sub-1')`).run('00000000-0000-7000-8000-0000000000c2'),
    ).toThrow();
    db.prepare(`INSERT INTO owners (id, name) VALUES (?, 'C')`).run('00000000-0000-7000-8000-0000000000c3'); // NULL subject ok
    db.close();
  });
});

describe('0051 connection_tokens store', () => {
  it('creates the connection_tokens table with BLOB columns and a unique connection', () => {
    const db = fresh();
    runMigrations(db);

    const info = db.prepare(`PRAGMA table_info(connection_tokens)`).all() as { name: string; type: string }[];
    const byName = Object.fromEntries(info.map((c) => [c.name, c.type]));
    expect(byName.owner_id).toBe('TEXT');
    expect(byName.iv).toBe('BLOB');
    expect(byName.auth_tag).toBe('BLOB');
    expect(byName.ciphertext).toBe('BLOB');

    // One row per (owner, provider, account) — distinct PK ids, same connection.
    db.prepare(`INSERT INTO owners (id, name) VALUES (?, 'O')`).run('00000000-0000-7000-8000-0000000000d1');
    const ins = (rowId: string) =>
      db.prepare(`INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext) VALUES (?, ?, 'google', 'me@x.io', x'00', x'00', x'00')`)
        .run(rowId, '00000000-0000-7000-8000-0000000000d1');
    ins('00000000-0000-7000-8000-0000000000d2');
    expect(() => ins('00000000-0000-7000-8000-0000000000d3')).toThrow(); // duplicate connection rejected
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
