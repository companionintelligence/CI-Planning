import type { Database } from 'better-sqlite3';

export const id = '0132_owner_onboarded';

/**
 * FTUE · T11 (#347) — the "confirmed owner" signal for the first-run onboarding wizard.
 *
 * Slot note: the T11 draft reserved `0128`, but that slot went to `sleep_hours`
 * (`0128_sleep_hours.ts`, the Priorities Wizard) while this ticket sat. `0132` is the
 * next free integer with no open PR claiming it, confirmed against
 * `server/src/db/migrations/` at implementation time.
 *
 * `onboarded_at` is nullable with NO default: NULL means the owner has not yet
 * completed or skipped the wizard, and a non-NULL ISO-8601 string is both the "done"
 * flag and its own timestamp. Backfilled for any owner that already has ≥1 task, so an
 * existing (pre-FTUE) install never sees the wizard on upgrade — only a genuinely fresh
 * seed owner does.
 */
function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'scheduling_prefs', 'onboarded_at')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN onboarded_at TEXT;`);
  }
  db.prepare(
    `UPDATE scheduling_prefs SET onboarded_at = CURRENT_TIMESTAMP
      WHERE onboarded_at IS NULL AND owner_id IN (SELECT DISTINCT owner_id FROM tasks)`,
  ).run();
}
