import type { Task } from './api.js';

/**
 * Shared guard: should this task be OFFERED promotion via `api.tasks.promoteObjective`
 * (POST /tasks/:id/promote-objective)? Two distinct server-side rules say no.
 *
 * 1. **Ephemeral tasks — the route's 422.** `ensureTaskPromoted`
 *    (server/src/services/task-promotion.ts) silently refuses a quick task or a
 *    materialized recurrence instance, because neither should spawn a strategic
 *    objective. Offering the action there means the owner clicks and gets an error
 *    we could have predicted.
 *
 * 2. **Abandoned work — `dropSourceObjective`'s rule.** Throwing a task away
 *    (status 'cancelled') makes the server hard-delete the pristine objective that
 *    task spawned: *"its work is abandoned"*. The promote route does NOT re-check
 *    status, so it answers 200 and re-creates that objective — one click undoing the
 *    GC the owner just triggered, on a card sitting in Archive → "Thrown away"
 *    (views/AllTasks.tsx renders full TaskCards there). Verified live. Withholding
 *    the offer is the client keeping faith with a rule the server states one function
 *    away. NOTE: this one is offer-side only — the API still accepts it.
 *
 * 'done' is deliberately NOT excluded: an objective survives its task being completed
 * (that is the documented ENTITY-3 behavior), so promoting a finished task is a real,
 * server-supported capability.
 *
 * Surface-specific extras stay at the call site: the Planner card also hides for
 * habits and Time Block containers, whereas the TaskCard picker treats habit as an
 * orthogonal axis (a habit can already link to an existing objective there).
 */
export function isPromotableToObjective(task: Task): boolean {
  return task.subtype !== 'quick' && !task.recurrence_parent_id && task.status !== 'cancelled';
}
