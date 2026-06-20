import type { Database } from 'better-sqlite3';

export const id = '0017_pattern_settings';

/**
 * Settings expansion, Step 1. Per-type **pattern display/config defaults**
 * (`color_token`, `texture`, `default_est_minutes`, `notify`) so each pattern
 * category — Habit ◯ / Routine ▢ / Ritual △ (+ custom) — carries its own look and
 * defaults, plus the new **Time-Block duration bounds** on `scheduling_prefs`
 * (Max 240 / Min 15). `color_token` holds a CI-Hub token key (e.g. 'chart-1'), not
 * a hex — colours stay on the shared design system. `texture` is an optional motif
 * override; null keeps the tag-seeded default. Reminder *firing* is still Phase H;
 * `notify` only stores the per-type toggle.
 *
 * Additive + idempotent (add-column-if-missing). Seeds tasteful defaults for the
 * built-ins (only where unset) so the Pattern Settings UI reads well immediately.
 */
export function up(db: Database): void {
  const ptCols = (db.prepare(`PRAGMA table_info(pattern_types)`).all() as { name: string }[]).map((c) => c.name);
  const addPt = (name: string, sql: string) => { if (!ptCols.includes(name)) db.exec(sql); };
  addPt('color_token', `ALTER TABLE pattern_types ADD COLUMN color_token TEXT`);            // CI-Hub token key
  addPt('texture', `ALTER TABLE pattern_types ADD COLUMN texture TEXT`);                    // motif override; null = derive from tag
  addPt('default_est_minutes', `ALTER TABLE pattern_types ADD COLUMN default_est_minutes INTEGER`);
  addPt('notify', `ALTER TABLE pattern_types ADD COLUMN notify INTEGER DEFAULT 0`);          // per-type reminder toggle (Phase H fires)

  // Tasteful defaults for the built-ins, only where unset (COALESCE) so edits stick.
  const setDefault = db.prepare(
    `UPDATE pattern_types
        SET color_token = COALESCE(color_token, ?), default_est_minutes = COALESCE(default_est_minutes, ?)
      WHERE name = ? AND is_builtin = 1`
  );
  setDefault.run('chart-1', 15, 'Habit');
  setDefault.run('chart-4', 30, 'Routine');
  setDefault.run('chart-3', 45, 'Ritual');

  const spCols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  const addSp = (name: string, sql: string) => { if (!spCols.includes(name)) db.exec(sql); };
  addSp('max_time_block_minutes', `ALTER TABLE scheduling_prefs ADD COLUMN max_time_block_minutes INTEGER DEFAULT 240`);
  addSp('min_time_block_minutes', `ALTER TABLE scheduling_prefs ADD COLUMN min_time_block_minutes INTEGER DEFAULT 15`);
}
