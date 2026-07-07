import { createSignal } from 'solid-js';
import { type DueFilterState, defaultDueFilter } from '../lib/due-filter.js';

/**
 * UI/store layer for the Today Due/Overdue filter: the reactive signal + localStorage
 * persistence around the pure model in lib/due-filter.ts. State is kept at module scope
 * (survives card remounts + navigation) and mirrored to localStorage, so the last filter
 * settings stay active across reloads until changed again. UI-only — no server/migration.
 */
const KEY = 'due-filter-v1';

function load(): DueFilterState {
  const base = defaultDueFilter();
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
