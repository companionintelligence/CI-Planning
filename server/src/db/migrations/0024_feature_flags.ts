import type { Database } from 'better-sqlite3';

export const id = '0024_feature_flags';

/**
 * Per-owner feature flags on `scheduling_prefs`. First flag (`enable_rituals`)
 * hides the Ritual pattern type — the V1 mental model is now Routine / Habit /
 * Plan-Block. The seeded Ritual pattern type stays in the DB so flipping the
 * flag on restores the UI with no migration.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('enable_rituals')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN enable_rituals INTEGER DEFAULT 0`);
  }
}
