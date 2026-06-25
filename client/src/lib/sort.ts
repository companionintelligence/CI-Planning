/**
 * Pure sort comparators shared by the Tasks view (T-TASKS-4) and the Flight-plan
 * (T-FP-2). No store access — callers resolve direction names where the `tags`
 * resource is in scope and pass an accessor to `byDirection`. Tested in sort.test.ts.
 *
 * Priority is 1..5 where **1 = P1 = highest**, so "by priority" is ascending.
 * "by due date" is nearest-first; undated items always sort last.
 */

/** The minimal shape the priority/due comparators need. */
export interface Sortable {
  priority?: number | null;
  due_at?: string | null;
}

/** P1 (priority 1) first. A missing priority sorts last; ties keep input order. */
export function byPriority(a: Sortable, b: Sortable): number {
  const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
  const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
  return pa - pb;
}

/** Nearest due date first. Items with no due date sort last; both-missing ties keep order. */
export function byDueDateAsc(a: Sortable, b: Sortable): number {
  const da = a.due_at ? Date.parse(a.due_at) : null;
  const db = b.due_at ? Date.parse(b.due_at) : null;
  if (da === null && db === null) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
}

/**
 * Group by direction (pattern-tag) name. The caller supplies `nameOf` because
 * resolving which of a task's tags is the direction needs the `tags` resource.
 * Undirected items (no resolved name) sort last; ties keep input order.
 */
export function byDirection<T>(nameOf: (t: T) => string | null | undefined) {
  return (a: T, b: T): number => {
    const na = nameOf(a);
    const nb = nameOf(b);
    if (na === nb) return 0;
    if (!na) return 1;
    if (!nb) return -1;
    return na.localeCompare(nb);
  };
}
