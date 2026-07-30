import type { Database } from 'better-sqlite3';

export const id = '0139_triality_flag';

/**
 * Triality master flag (docs/triality-design.md §7). Default OFF — the whole
 * feature (Focus suggestion banner, Balance→Metrics tiles, /api/triality/*)
 * ships dark, and flag-off must stay byte-identical. A plain scheduling_prefs
 * boolean, the time_sense_enabled shape (0106).
 *
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'triality_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN triality_enabled INTEGER DEFAULT 0`);
  }
}
