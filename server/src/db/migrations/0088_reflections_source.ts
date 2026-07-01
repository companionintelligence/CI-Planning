import type { Database } from 'better-sqlite3';

export const id = '0088_reflections_source';

/**
 * Phase O · O0 — link a reflection (a today intention / weekly goal) to the work
 * it references. Mirrors the `flight_plan.(source_kind, source_ref)` pattern from
 * 0081_objectives.
 *
 *   source_kind — 'manual' | 'task' | 'objective'  (default 'manual')
 *   source_ref  — tasks.id | objectives.id | NULL
 *
 * No FK (the ref is cross-table); a dangling ref just renders as plain text — the
 * `body` is always the display source of truth. Additive + idempotent (PRAGMA
 * guard) so a re-run on a partially-migrated DB is safe.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(reflections)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('source_kind')) {
    db.exec(`ALTER TABLE reflections ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual';`);
  }
  if (!cols.includes('source_ref')) {
    db.exec(`ALTER TABLE reflections ADD COLUMN source_ref TEXT;`);
  }
}
