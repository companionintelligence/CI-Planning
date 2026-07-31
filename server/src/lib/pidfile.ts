/**
 * Pidfile beside the database, so offline tools can tell whether the server is up.
 *
 * Why not just probe the database: opening a SQLite file takes no lock, so the obvious
 * `new BetterSqlite3(dbPath)` check can never fail and any guard built on it is a no-op.
 * A `BEGIN IMMEDIATE` probe only catches a process that happens to be mid-write, which an
 * idle server is not. A pidfile is the only cheap signal that reliably says "someone has
 * this database open right now".
 *
 * It lives beside the database rather than in /run or /tmp because that is the one
 * directory both the server and the restore script already agree on (DB_PATH), and it
 * survives the container/bare-metal split without extra configuration.
 *
 * Best-effort by contract: a read-only data dir must NOT stop the server from booting, so
 * every operation here swallows its errors. Consumers treat "no pidfile" as "unknown",
 * never as "definitely not running" — which is why restore.ts keeps a second check.
 */
import { writeFileSync, unlinkSync } from 'node:fs';

/** Path of the pidfile for a given database path. */
export function pidFilePath(dbPath: string): string {
  return `${dbPath}.pid`;
}

/** Record this process as the holder of `dbPath`. Never throws. */
export function writePidFile(dbPath: string): void {
  try {
    writeFileSync(pidFilePath(dbPath), `${process.pid}\n`, { mode: 0o644 });
  } catch {
    /* read-only data dir — restore.ts falls back to its write-lock probe */
  }
}

/** Remove this process's pidfile. Never throws; safe to call twice. */
export function removePidFile(dbPath: string): void {
  try {
    unlinkSync(pidFilePath(dbPath));
  } catch {
    /* already gone, or never written */
  }
}
