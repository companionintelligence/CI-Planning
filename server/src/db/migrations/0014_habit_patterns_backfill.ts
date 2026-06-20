import type { Database } from 'better-sqlite3';

export const id = '0014_habit_patterns_backfill';

/**
 * Habit → Pattern bridge backfill (Phase G, ticket G2 / E′-1).
 *
 * Link every existing habit (an `is_habit` template — `recurrence_parent_id IS
 * NULL`) to a **Habit-type Pattern**. This is the *additive* bridge: `is_habit`
 * stays the runtime flag (the generation job, streaks, and skip are unchanged), so
 * E behaves exactly as before; the pattern is just the new representation the Phase-G
 * cockpit reads. Idempotent — re-running creates nothing new.
 */
export function up(db: Database): void {
  const habitTypes = db
    .prepare(`SELECT id, owner_id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1`)
    .all() as { id: number; owner_id: number }[];

  const alreadyLinked = db.prepare(
    `SELECT 1 FROM pattern_tasks pt JOIN patterns p ON p.id = pt.pattern_id
      WHERE pt.task_id = ? AND p.type_id = ?`
  );
  const insPattern = db.prepare(`INSERT INTO patterns (owner_id, type_id, name) VALUES (?, ?, ?) RETURNING id`);
  const insMember = db.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`);

  for (const ht of habitTypes) {
    const habits = db
      .prepare(`SELECT id, title FROM tasks WHERE owner_id = ? AND is_habit = 1 AND recurrence_parent_id IS NULL`)
      .all(ht.owner_id) as { id: number; title: string }[];
    for (const h of habits) {
      if (alreadyLinked.get(h.id, ht.id)) continue; // idempotent
      const p = insPattern.get(ht.owner_id, ht.id, h.title) as { id: number };
      insMember.run(p.id, h.id);
    }
  }
}
