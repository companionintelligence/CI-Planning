import type { Objective } from './api.js';

/** A single row of the flattened objective tree for the "3 for the week" typeahead. */
export interface FlatObjective {
  id: string;
  title: string;
  level: Objective['level'];
  /** ' › '-joined ancestor titles above this node (empty for a root). */
  path: string;
}

/**
 * Flatten the objective tree (GET /api/objectives) into a linkable list for the
 * weekly-focus typeahead. EVERY node is linkable — goal, project, or leaf
 * objective — because a *focus* link is not a *task* link, so the leaf-only
 * containment rule does not apply (Phase O · O0). Depth-first, parents before
 * children, so the list reads top-down.
 */
export function flattenObjectives(tree: Objective[], parents: string[] = []): FlatObjective[] {
  const out: FlatObjective[] = [];
  for (const o of tree) {
    out.push({ id: o.id, title: o.title, level: o.level, path: parents.join(' › ') });
    if (o.children?.length) out.push(...flattenObjectives(o.children, [...parents, o.title]));
  }
  return out;
}

/** Case-insensitive substring filter over title + path; empty query returns all. */
export function matchObjectives(flat: FlatObjective[], query: string): FlatObjective[] {
  const q = query.trim().toLowerCase();
  if (!q) return flat;
  return flat.filter((o) => o.title.toLowerCase().includes(q) || o.path.toLowerCase().includes(q));
}
