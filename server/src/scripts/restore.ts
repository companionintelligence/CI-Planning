/**
 * Offline restore — copy a snapshot file over DB_PATH, then run forward migrations.
 * The server must be stopped first: this script detects an open connection and exits.
 *
 * Usage: DB_PATH=/data/companion.db pnpm --filter server restore -- <snapshot-path>
 */
import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync } from 'node:fs';
import { config } from '../lib/config.js';
import { runMigrations } from '../db/migrate.js';
import { openDb } from '../db/open.js';
import { logger } from '../lib/logger.js';

const [src] = process.argv.slice(2);
if (!src) {
  console.error('Usage: pnpm restore -- <snapshot-path>');
  process.exit(1);
}

// Validate the source is a readable SQLite file before touching anything.
let probe: ReturnType<typeof BetterSqlite3> | undefined;
try {
  probe = new BetterSqlite3(src, { readonly: true });
  probe.prepare('SELECT 1').get();
} catch (err) {
  console.error(`Cannot open source snapshot: ${(err as Error).message}`);
  process.exit(1);
} finally {
  probe?.close();
}

// Refuse if the destination DB is currently locked (server running).
try {
  const dest = new BetterSqlite3(config.dbPath, { timeout: 200 });
  dest.close();
} catch (err) {
  if ((err as Error).message?.includes('SQLITE_BUSY')) {
    console.error('Server appears to be running (DB is locked). Stop it first.');
    process.exit(1);
  }
  // DB file doesn't exist yet — that's fine, we're creating it.
}

copyFileSync(src, config.dbPath);

// Real read-write open that runs forward migrations — FK enforcement ON via openDb.
// (The probe + lock-check opens above are read-only / never write, so they stay raw.)
const db = openDb(config.dbPath);
try {
  const { applied } = runMigrations(db);
  if (applied.length) logger.info('restore: ran forward migrations', { applied });
  console.log(
    `Restored ${src} → ${config.dbPath}` +
    (applied.length ? ` (applied: ${applied.join(', ')})` : '')
  );
} finally {
  db.close();
}
