/**
 * Run pending migrations against the configured database without booting the
 * server (for ops / CI). Usage: `pnpm migrate`.
 */
import BetterSqlite3 from 'better-sqlite3';
import { config } from '../lib/config.js';
import { runMigrations } from '../db/migrate.js';
import { logger } from '../lib/logger.js';

const db = new BetterSqlite3(config.dbPath);
try {
  const { applied } = runMigrations(db);
  if (applied.length) logger.info('migrate: applied', { applied });
  else logger.info('migrate: already up to date');
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
} finally {
  db.close();
}
