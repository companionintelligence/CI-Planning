/**
 * Offline restore — put a snapshot file in place of DB_PATH, then run forward migrations.
 * The server must be stopped first; this script refuses to run while it is up.
 *
 * Usage: DB_PATH=/data/companion.db pnpm --filter server restore -- <snapshot-path>
 *
 * Two things here are load-bearing and were previously wrong, so they are spelled out:
 *
 * 1. THE STALE WAL. SQLite in WAL mode keeps recent pages in `<db>-wal`. Copying a
 *    snapshot over `<db>` while the old `-wal`/`-shm` remain means the next open replays
 *    the OLD database's WAL onto the NEW file. The result is a page-level mixture of two
 *    databases that `PRAGMA integrity_check` happily reports as `ok` — silent, and not
 *    detectable after the fact. The pre-existing db/wal/shm are therefore MOVED aside as
 *    one set before the copy, never left in place and never deleted.
 *
 * 2. THE RUNNING-SERVER CHECK. Merely opening a SQLite database takes no lock, so the
 *    previous `new BetterSqlite3(dbPath)` probe could never fail and the guard never
 *    fired. Detection is now a pidfile written by boot.ts, plus a `BEGIN IMMEDIATE`
 *    probe that catches any other process mid-write.
 */
import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { config } from '../lib/config.js';
import { runMigrations } from '../db/migrate.js';
import { openDb } from '../db/open.js';
import { logger } from '../lib/logger.js';
import { pidFilePath } from '../lib/pidfile.js';

const [src] = process.argv.slice(2);
if (!src) {
  console.error('Usage: pnpm restore -- <snapshot-path>');
  process.exit(1);
}

/** SQLite's sidecar files. They must always travel with the main db file, never alone. */
const SIDECARS = ['-wal', '-shm'] as const;

// ── 1. Validate the source before touching anything ──────────────────────────
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

// ── 2. Refuse while the server is running ────────────────────────────────────
// A live server holds the database open; restoring under it corrupts both the file and
// the running process's view of it.
const pidPath = pidFilePath(config.dbPath);
if (existsSync(pidPath)) {
  const raw = readFileSync(pidPath, 'utf8').trim();
  const pid = Number(raw);
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0); // signal 0 = existence check, does not signal
      alive = true;
    } catch (err) {
      // ESRCH = no such process (stale pidfile). EPERM = alive but owned by another user.
      alive = (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  if (alive) {
    console.error(
      `Server appears to be running (pid ${pid}, from ${pidPath}). Stop it first — ` +
        `e.g. \`systemctl --user stop companion-planning\` or \`docker stop\`.`,
    );
    process.exit(1);
  }
  logger.warn(`restore: ignoring stale pidfile at ${pidPath} (pid ${raw} is not running)`);
}

// Second line of defence: catch any other writer (a cron container, a second copy of this
// script) even when no pidfile exists. Unlike opening the db, BEGIN IMMEDIATE really does
// take a write lock.
if (existsSync(config.dbPath)) {
  let writeProbe: ReturnType<typeof BetterSqlite3> | undefined;
  try {
    writeProbe = new BetterSqlite3(config.dbPath, { timeout: 200 });
    writeProbe.exec('BEGIN IMMEDIATE');
    writeProbe.exec('ROLLBACK');
  } catch (err) {
    console.error(
      `Destination database is locked by another process — refusing to restore. (${(err as Error).message})`,
    );
    process.exit(1);
  } finally {
    writeProbe?.close();
  }
}

// ── 3. Move the current database aside, as one consistent set ────────────────
// This is both the stale-WAL fix and the "don't destroy the only other copy" fix: the
// previous implementation overwrote the live file in place, so a restore from the wrong
// snapshot left the operator with neither database.
if (existsSync(config.dbPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const asideDir = join(dirname(config.dbPath), 'pre-restore');
  mkdirSync(asideDir, { recursive: true });
  const asideBase = join(asideDir, `${basename(config.dbPath)}.${stamp}`);

  renameSync(config.dbPath, asideBase);
  for (const ext of SIDECARS) {
    if (existsSync(config.dbPath + ext)) renameSync(config.dbPath + ext, asideBase + ext);
  }
  console.log(`Previous database moved to ${asideBase} (with any -wal/-shm).`);
} else {
  // No database yet, but a sidecar could still be lying around from a crash. Leaving it
  // would replay onto the restored file — the exact corruption this script guards against.
  for (const ext of SIDECARS) {
    if (existsSync(config.dbPath + ext)) {
      console.error(
        `Found ${config.dbPath + ext} with no database beside it. Move it away manually ` +
          `before restoring — replaying it onto the snapshot would corrupt it.`,
      );
      process.exit(1);
    }
  }
}

// ── 4. Put the snapshot in place ─────────────────────────────────────────────
// Safe now: no -wal/-shm exist for this path, so nothing replays onto the new file.
copyFileSync(src, config.dbPath);

// ── 5. Forward-migrate ───────────────────────────────────────────────────────
// Real read-write open, FK enforcement ON via openDb. (The probes above are read-only or
// roll back, so they stay raw.)
const db = openDb(config.dbPath);
try {
  const { applied } = runMigrations(db);
  if (applied.length) logger.info('restore: ran forward migrations', { applied });
  console.log(
    `Restored ${src} → ${config.dbPath}` +
      (applied.length ? ` (applied: ${applied.join(', ')})` : ''),
  );
} finally {
  db.close(); // checkpoints the WAL this open just created
}
