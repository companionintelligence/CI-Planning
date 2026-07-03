import type { Database } from 'better-sqlite3';

export const id = '0106_time_sense_flag';

/**
 * Phase Z (Time-Sense) — `time_sense_enabled` master feature flag on
 * scheduling_prefs. Default OFF — gates every Time-Sense surface (Focus Ritual,
 * Calibration Loop scoping, EOD Alignment) while the phase lands dark, slice by
 * slice. Per-cue toggles (haptic/sound/color per timer) arrive with the Z5 prefs
 * slice; this is only the master gate, mirroring enable_rituals/enable_routines.
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('time_sense_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN time_sense_enabled INTEGER DEFAULT 0`);
  }
}
