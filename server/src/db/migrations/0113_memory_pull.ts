import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

// PROVISIONAL number: head was 0112 (W-close #286) when this branch cut — renumber at
// merge if another lane lands 0113 first.
export const id = '0113_memory_pull';

/**
 * Phase AA · AA0/AA1 — `memory_pull_enabled` master flag on scheduling_prefs
 * (default OFF: flag-off behavior is byte-identical, Z-phase discipline) + the
 * `memory_suggest` scheduled job (AA1: pulls the next-48h CI-Server memory graph
 * and stages inbox suggestions; the job itself no-ops per owner until the flag
 * is on AND the connector resolves creds).
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS;
 * INSERT OR IGNORE dedupes on scheduled_jobs.name UNIQUE).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('memory_pull_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN memory_pull_enabled INTEGER DEFAULT 0`);
  }
  db.prepare(`INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`).run(
    newId(),
    'memory_suggest',
    'memory_suggest',
    '0 */6 * * *', // every 6h — suggestions are idempotent on source_ref, so re-runs are safe
  );
}
