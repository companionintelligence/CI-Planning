import type { Objective } from './api.js';
import { flattenObjectives, matchObjectives, type FlatObjective } from './objectives.js';

/**
 * AF-6 · Assign-to-objective picker helpers (TaskCard hover-rail dropdown).
 *
 * The server only allows task links on LEAF objectives (level === 'objective';
 * non-leaf → 422 non_leaf), so — unlike the weekly-focus typeahead, where every
 * node is linkable — this picker filters the flattened tree down to leaves.
 * That filtering lives HERE, at the call site, not in the shared
 * flattenObjectives/matchObjectives defaults (DayGoals depends on those).
 */

/** One row of the assign-to-objective dropdown. */
export interface ObjectivePickerRow extends FlatObjective {
  /** Ancestor count (from the › path) — drives the indent so hierarchy reads. */
  depth: number;
  /** True when the task is already linked to this objective (shown checked). */
  checked: boolean;
}

/** Show the search-as-you-type input when the leaf list exceeds this many entries. */
export const PICKER_SEARCH_THRESHOLD = 8;

/** Flatten the objective tree and keep only linkable LEAF objectives. */
export function leafObjectives(tree: Objective[]): FlatObjective[] {
  return flattenObjectives(tree).filter((o) => o.level === 'objective');
}

/**
 * Build the dropdown rows: leaf-only, typeahead-filtered (title + ancestor
 * path, case-insensitive), with depth preserved from the tree and EVERY
 * currently-linked objective marked checked (AF-10: tasks↔objectives is M:N —
 * the card passes the full linked set, task.objective_ids, not just the first).
 */
export function buildPickerRows(
  tree: Objective[],
  query: string,
  linkedObjectiveIds: readonly string[],
): ObjectivePickerRow[] {
  const linked = new Set(linkedObjectiveIds);
  return matchObjectives(leafObjectives(tree), query).map((o) => ({
    ...o,
    depth: o.path ? o.path.split(' › ').length : 0,
    checked: linked.has(o.id),
  }));
}
