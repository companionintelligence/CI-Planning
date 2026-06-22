import type { Database } from 'better-sqlite3';

export const id = '0040_pattern_default_minutes';

/**
 * Add `default_minutes` to `pattern_prefs`: the fallback estimate a pattern
 * (direction) tag contributes when a task carries no intention tag to suggest one.
 * Mirrors the intention tags' per-tag minutes. Defaults to 60. Additive + idempotent
 * (column-existence guard makes a re-run a no-op).
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(pattern_prefs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'default_minutes')) {
    db.exec(`ALTER TABLE pattern_prefs ADD COLUMN default_minutes INTEGER NOT NULL DEFAULT 60`);
  }
}
