import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

/**
 * Open a better-sqlite3 connection with FK enforcement ON (per-connection,
 * off by default) + a busy_timeout. Every open site MUST route through this
 * so FK enforcement can't be silently forgotten on backup/restore/migrate.
 *
 * Side-effect-free: this module must NOT import `db/index.ts` (which opens the
 * shared DB and runs migrations on import). Keep it dependency-light.
 */
export function openDb(path: string): Database {
  const db = new BetterSqlite3(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
