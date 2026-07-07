import { createSignal } from 'solid-js';

/**
 * Persisted filter state for the Today view's Due / Overdue card.
 *
 * Five multi-selectable options, all AND-combined:
 *   - `directions` — INCLUDE filter over direction tag names (tags.kind='direction',
 *     base work/home/community). Empty = no direction narrowing (show every direction).
 *     Non-empty = keep only tasks carrying at least one of the selected direction tags.
 *   - `hideHabits`   — when true, habit tasks (`is_habit`) are hidden. Default TRUE:
 *     habits do not show unless the user opts them back in.
 *   - `hideRoutines` — when true, tasks that belong to a Routine are hidden. Default
 *     TRUE: routine tasks do not show unless the user opts them back in.
 *
 * State is kept at module scope (survives card remounts + navigation) and mirrored to
 * localStorage so the last filter settings stay active across reloads until changed
 * again. This is a UI-only preference — no server/migration involved.
 */
export interface DueFilterState {
  directions: string[];
  hideHabits: boolean;
  hideRoutines: boolean;
}

const KEY = 'due-filter-v1';

function defaults(): DueFilterState {
  return { directions: [], hideHabits: true, hideRoutines: true };
}

function load(): DueFilterState {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<DueFilterState>;
    return {
      directions: Array.isArray(p.directions) ? p.directions.filter((x): x is string => typeof x === 'string') : base.directions,
      hideHabits: typeof p.hideHabits === 'boolean' ? p.hideHabits : base.hideHabits,
      hideRoutines: typeof p.hideRoutines === 'boolean' ? p.hideRoutines : base.hideRoutines,
    };
  } catch {
    return base;
  }
}

const [dueFilter, setDueFilterRaw] = createSignal<DueFilterState>(load());
export { dueFilter };

/** Replace the filter state and persist it. */
export function setDueFilter(next: DueFilterState) {
  setDueFilterRaw(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private-mode / quota — the in-memory signal still holds for the session */
  }
}

/** Toggle a direction tag name in/out of the INCLUDE set. */
export function toggleDirection(name: string) {
  const cur = dueFilter();
  const has = cur.directions.includes(name);
  setDueFilter({
    ...cur,
    directions: has ? cur.directions.filter((d) => d !== name) : [...cur.directions, name],
  });
}

export function setHideHabits(v: boolean) {
  setDueFilter({ ...dueFilter(), hideHabits: v });
}

export function setHideRoutines(v: boolean) {
  setDueFilter({ ...dueFilter(), hideRoutines: v });
}

/** Whether the filter narrows anything beyond the plain defaults (drives the trigger tint). */
export function dueFilterActive(f: DueFilterState): boolean {
  return f.directions.length > 0 || !f.hideHabits || !f.hideRoutines;
}

/**
 * Pure predicate — does a task survive the current filter? `isRoutine` is supplied by
 * the caller (store's `isRoutineTask`) so this stays framework/dependency-free and
 * unit-testable in a node env.
 */
export function passesDueFilter(
  task: Pick<import('./api.js').Task, 'tags' | 'is_habit'>,
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
