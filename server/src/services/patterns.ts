import { sqlite } from '../db/index.js';

/**
 * Habit → Pattern bridge (Phase G, G2 / E′). Ensure a habit task is represented as
 * a Habit-type Pattern, keeping the pattern model in sync with `tasks.is_habit`
 * (which remains the runtime flag). Idempotent; a no-op if the owner has no built-in
 * Habit type or the task is already in a Habit pattern.
 */
export function ensureHabitPattern(taskId: number, ownerId: number, name: string): void {
  const habitType = sqlite
    .prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1 AND owner_id = ?`)
    .get(ownerId) as { id: number } | undefined;
  if (!habitType) return;

  const already = sqlite
    .prepare(
      `SELECT 1 FROM pattern_tasks pt JOIN patterns p ON p.id = pt.pattern_id
        WHERE pt.task_id = ? AND p.type_id = ?`
    )
    .get(taskId, habitType.id);
  if (already) return;

  const p = sqlite
    .prepare(`INSERT INTO patterns (owner_id, type_id, name) VALUES (?, ?, ?) RETURNING id`)
    .get(ownerId, habitType.id, name) as { id: number };
  sqlite.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(p.id, taskId);
}
