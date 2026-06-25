import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';

const sqlite = new BetterSqlite3(config.dbPath);
sqlite.pragma('foreign_keys = ON'); // connection-level; the runner sets WAL
// uuid7() for raw-SQL inserts (CON-1). SQLite can't DEFAULT a dashed UUIDv7
// (no UDFs in DEFAULT; one randomblob can't be sliced consistently), so every
// raw INSERT supplies `id` via this function; Drizzle inserts use $defaultFn.
sqlite.function('uuid7', () => newId());
logger.info('SQLite database opened', { path: config.dbPath });

/**
 * Phase M C3 — best-effort load of the `sqlite-vec` extension onto the raw handle.
 * When available, possible-task dedupe uses a transient `vec0` KNN search; on any
 * load failure (e.g. no prebuilt binary for the platform) it logs once and the
 * dedupe falls back to the deterministic cosine loop (agents/groom.ts) — same result.
 */
export const vecAvailable: boolean = (() => {
  try {
    sqliteVec.load(sqlite);
    const v = (sqlite.prepare('SELECT vec_version() AS v').get() as { v: string }).v;
    logger.info('sqlite-vec loaded', { version: v });
    return true;
  } catch (err) {
    logger.warn('sqlite-vec unavailable — possible-task dedupe uses the cosine fallback', { err: (err as Error).message });
    return false;
  }
})();

const { applied } = runMigrations(sqlite);
logger.info('Schema ready', { migrationsApplied: applied.length });

export const db = drizzle(sqlite, { schema });
export { sqlite };
