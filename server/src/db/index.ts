import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';
import { openDb } from './open.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { setStore, createSqliteStore } from './store.js';

const sqlite = openDb(config.dbPath); // FK enforcement ON + busy_timeout; the runner sets WAL
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

// Install the SQLite backend of the data facade (db/store.ts) as soon as the handle
// exists. It lives HERE rather than only in boot.ts because importing the database is
// what every consumer already does — including scripts, the CLI, and the many test files
// that never load boot.ts or the test harness. Without it, any ported call site reached
// from one of those throws "store not initialised", which is a module-ordering trap
// rather than a real error. boot.ts still calls setStore afterwards, and that is what
// swaps in Postgres when STORE_BACKEND says so.
setStore(createSqliteStore(sqlite));

export const db = drizzle(sqlite, { schema });
export { sqlite };
