import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';

/**
 * Midnight reset for Routine tasks. A Routine is a repeatable checklist, so its member
 * tasks are NEVER archived on completion — instead they flip back to `open` (and clear
 * `completed_at`) at midnight so the routine is fresh for the new day. Owner-scoped:
 * runs inside the cron's per-owner runWithOwner binding.
 *
 * "In a routine" = a member of a pattern whose type is 'Routine' (the same rule the
 * client's isRoutineTask uses: pattern_types.name = 'Routine'). Habit/Ritual patterns
 * are untouched — those have their own occurrence lifecycle.
 */
export function resetRoutineTasks(): { reset: number } {
  const owner = currentOwnerId();
  const res = sqlite
    .prepare(
      `UPDATE tasks
          SET status = 'open', completed_at = NULL
        WHERE owner_id = ?
          AND status = 'done'
          AND id IN (
            SELECT pt.task_id
              FROM pattern_tasks pt
              JOIN patterns p       ON p.id = pt.pattern_id
              JOIN pattern_types ty ON ty.id = p.type_id
             WHERE ty.name = 'Routine' AND p.owner_id = ?
          )`,
    )
    .run(owner, owner);
  return { reset: res.changes };
}
