import type { Database } from 'better-sqlite3';

export const id = '0108_focus_prefs';

/**
 * Phase Z · Z5 (Time-Sense) — the per-cue prefs matrix + experiment arm.
 *
 * Expands the single `time_sense_enabled` master flag (0106) into the granular
 * control the spec's A/B plan needs (§5.1). All four channel/feature flags default
 * ON so an owner who flips only the master flag gets the full ritual; the
 * experiment-arm assignment (server-side, on first enable) overrides haptic/color
 * to match the assigned 2×2 cell (§5.2). None of these is read while the master
 * flag is OFF, so this migration is behaviour-neutral for pre-Z owners.
 *
 *   focus_ritual_enabled   — master gate for the Focus screen (§1)
 *   haptic_cues_enabled    — T1–T4 haptics (arm-derived)
 *   ambient_color_enabled  — depletion + breathing animation (arm-derived)
 *   calibration_loop_enabled — §2 estimate prompt + scoped nudge
 *   z_experiment_arm       — fixed A/B/C/D bucket, server-assigned (§5.2); NULL = unassigned
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN ${ddl}`);
  };
  add('focus_ritual_enabled', 'focus_ritual_enabled INTEGER DEFAULT 1');
  add('haptic_cues_enabled', 'haptic_cues_enabled INTEGER DEFAULT 1');
  add('ambient_color_enabled', 'ambient_color_enabled INTEGER DEFAULT 1');
  add('calibration_loop_enabled', 'calibration_loop_enabled INTEGER DEFAULT 1');
  add('z_experiment_arm', 'z_experiment_arm TEXT'); // NULL until first Time-Sense enable
}
