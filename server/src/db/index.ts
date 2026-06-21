import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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

const { applied } = runMigrations(sqlite);
logger.info('Schema ready', { migrationsApplied: applied.length });

export const db = drizzle(sqlite, { schema });
export { sqlite };
