import type { Database } from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index.js';
import { logger } from '../lib/logger.js';

/**
 * Forward-only, version-tracked migration runner. Replaces the old
 * `CREATE TABLE IF NOT EXISTS` + try/catch `ALTER` setup, and the cross-branch
 * schema drift that caused. Each migration runs once, in order, in its own
 * transaction; failures abort that migration only, leaving earlier ones applied
 * (so a re-run resumes).
 *
 * Every historical migration is written idempotently, which is what lets an
 * existing 0.2 database adopt the runner with no detection step: running the
 * loop on a populated DB simply records the already-present migrations.
 */
export function runMigrations(db: Database): { applied: string[] } {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checksum   TEXT
    );
  `);

  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id)
  );

  const applied: string[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');

  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    // better-sqlite3 is synchronous, so the whole migration + its bookkeeping
    // commit (or roll back) atomically.
    const tx = db.transaction(() => {
      m.up(db);
      record.run(m.id);
    });
    tx();
    applied.push(m.id);
    logger.info('migration applied', { id: m.id });
  }

  db.pragma(`user_version = ${MIGRATIONS.length}`); // fast cross-check of "all applied"
  return { applied };
}

/**
 * Rebuild a table whose shape can't be changed in place (SQLite can't drop /
 * rename / retype a column cleanly). Used by future non-additive migrations so
 * they don't reinvent the 12-step dance. `columns` is the comma-separated list
 * of columns shared between old and new tables (for the data copy).
 *
 * Toggles foreign_keys OFF for the swap and restores it — required, or later
 * inserts silently skip FK enforcement.
 */
export function rebuildTable(
  db: Database,
  opts: { table: string; createNewSql: string; columns: string; afterSql?: string }
): void {
  const { table, createNewSql, columns, afterSql } = opts;
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(createNewSql); // must create `${table}_new`
      db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table};`);
      db.exec(`DROP TABLE ${table};`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table};`);
      if (afterSql) db.exec(afterSql); // recreate indexes / triggers
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
