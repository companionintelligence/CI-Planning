import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';

export const backupDir = join(dirname(config.dbPath), 'backups');

/** Write a consistent point-in-time snapshot of the live DB to `dest`. */
export async function snapshot(dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  // Not via openDb(): this is a READ-ONLY snapshot source. `.backup()` copies
  // pages and never writes through this handle, so FK enforcement is moot here;
  // the openDb() helper (which opens read-write) would defeat the readonly guard.
  const src = new BetterSqlite3(config.dbPath, { readonly: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
}

/** Delete oldest `companion-*.db` files in `dir`, keeping the `retain` newest. */
export function pruneOldSnapshots(dir: string, retain: number): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('companion-') && f.endsWith('.db'))
    .sort(); // lexicographic == chronological (ISO timestamp in filename)
  for (const f of files.slice(0, Math.max(0, files.length - retain))) {
    try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
  }
}
