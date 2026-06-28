import type { Database } from 'better-sqlite3';

export const id = '0073_enable_routines';

/**
 * Per-owner feature flag `enable_routines` on `scheduling_prefs` (mirrors the
 * 0024 `enable_rituals` flag). Default OFF: the Routine tile is hidden in the
 * Add-to-calendar wizard AND recurring Routine patterns stop auto-placing on
 * the board. Habits are unaffected. Flipping the flag on restores both with no
 * further migration.
 *
 * Why gate placement too: recurring Routine patterns are auto-placed lazily on
 * every GET /api/blocks read. With no gate, deleting a placed Routine container
 * regenerates it on the very next read (the refetch the client fires after the
 * delete) — so the block can never be removed. Honouring the flag in
 * `ensurePatternsForRange` makes the deletion stick.
 *
 * Additive + idempotent.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('enable_routines')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN enable_routines INTEGER DEFAULT 0`);
  }
}
