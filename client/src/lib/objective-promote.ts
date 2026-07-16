import type { Task } from './api.js';

/**
 * Shared promotability guard for `api.tasks.promoteObjective` (POST
 * /tasks/:id/promote-objective).
 *
 * The route answers 422 not_promotable for the tasks `ensureTaskPromoted`
 * silently refuses (server/src/services/task-promotion.ts): a quick task or a
 * materialized recurrence instance is ephemeral and must not spawn a strategic
 * objective. Every surface offering the action has to hide it for exactly that
 * set, or the owner clicks and gets an error for a case we already knew about.
 *
 * This mirrors the SERVER's refuse set only. Surface-specific extras stay at the
 * call site: the Planner card also hides for habits and Time Block containers,
 * whereas the TaskCard picker treats habit as an orthogonal axis (a habit can
 * already link to an existing objective there).
 */
export function isPromotableToObjective(task: Task): boolean {
  return task.subtype !== 'quick' && !task.recurrence_parent_id;
}
