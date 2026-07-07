import type { Task } from './api.js';

/**
 * Pure, dependency-free filter model for the Today Due/Overdue card. No Solid, no
 * localStorage here — this module is unit-testable in a plain node env. The reactive
 * signal + localStorage persistence live in the UI/store layer (stores/due-filter.ts).
 *
 * Five multi-selectable options, all AND-combined:
 *   - `directions` — INCLUDE filter over direction tag names (tags.kind='direction',
 *     base work/home/community). Empty = no direction narrowing (show every direction).
 *     Non-empty = keep only tasks carrying at least one of the selected direction tags.
 *   - `hideHabits`   — when true, habit tasks (`is_habit`) are hidden. Default TRUE.
 *   - `hideRoutines` — when true, tasks that belong to a Routine are hidden. Default TRUE.
 */
export interface DueFilterState {
  directions: string[];
  hideHabits: boolean;
  hideRoutines: boolean;
}

/** The default filter: habits & routines hidden, no direction narrowing. */
export function defaultDueFilter(): DueFilterState {
  return { directions: [], hideHabits: true, hideRoutines: true };
}

/** Whether the filter narrows anything beyond the plain defaults (drives the trigger tint). */
export function dueFilterActive(f: DueFilterState): boolean {
  return f.directions.length > 0 || !f.hideHabits || !f.hideRoutines;
}

/**
 * Does a task survive the current filter? `isRoutine` is supplied by the caller (the
 * store's `isRoutineTask`) so this stays framework/dependency-free.
 */
export function passesDueFilter(
  task: Pick<Task, 'tags' | 'is_habit'>,
  isRoutine: boolean,
  filter: DueFilterState,
): boolean {
  if (filter.hideHabits && task.is_habit) return false;
  if (filter.hideRoutines && isRoutine) return false;
  if (filter.directions.length > 0) {
    const tags = task.tags ?? [];
    if (!filter.directions.some((d) => tags.includes(d))) return false;
  }
  return true;
}
