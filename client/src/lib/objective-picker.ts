import type { Objective } from './api.js';
import { flattenObjectives, matchObjectives, type FlatObjective } from './objectives.js';

/**
 * AF-6 · Assign-to-objective picker helpers (TaskCard hover-rail dropdown).
 *
 * Task links can now live on any node. Assignment rows include the full tree,
 * while the legacy leaf-only builder remains available to older callers that
 * specifically need objective-level nodes.
 */

/** One row of the assign-to-objective dropdown. */
export interface ObjectivePickerRow extends FlatObjective {
  /** Ancestor count (from the › path) — drives the indent so hierarchy reads. */
  depth: number;
  /** True when the task is already linked to this objective (shown checked). */
  checked: boolean;
}

/** Show the search-as-you-type input when the objective list exceeds this many entries. */
export const PICKER_SEARCH_THRESHOLD = 8;

/** Flatten all nodes that may hold linked tasks. */
export function linkableObjectives(tree: Objective[]): FlatObjective[] {
  return flattenObjectives(tree);
}

/** Retained for callers that specifically want objective-level leaves. */
export function leafObjectives(tree: Objective[]): FlatObjective[] {
  return flattenObjectives(tree).filter((o) => o.level === 'objective');
}

/**
 * Legacy builder: leaf-only, typeahead-filtered (title + ancestor
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

/** Build assignment rows for every node that can now hold a task link. */
export function buildLinkablePickerRows(
  tree: Objective[],
  query: string,
  linkedObjectiveIds: readonly string[],
): ObjectivePickerRow[] {
  const linked = new Set(linkedObjectiveIds);
  return matchObjectives(linkableObjectives(tree), query).map((o) => ({
    ...o,
    depth: o.path ? o.path.split(' › ').length : 0,
    checked: linked.has(o.id),
  }));
}
