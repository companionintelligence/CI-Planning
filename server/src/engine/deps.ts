import { sqlite } from '../db/index.js';

export class DependencyCycleError extends Error {
  constructor(taskId: string, dependsOnId: string) {
    super(`Adding dependency ${taskId}→${dependsOnId} would create a cycle`);
    this.name = 'DependencyCycleError';
  }
}

/** Does `from` already reach `to` through depends_on edges? (cycle probe) */
function reaches(from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  const q = sqlite.prepare('SELECT depends_on_id AS d FROM task_dependencies WHERE task_id = ?');
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const r of q.all(n) as { d: string }[]) stack.push(r.d);
  }
  return false;
}

/**
 * Restrict a set of candidate depends_on ids to the ones `ownerId` actually owns.
 * The `task_dependencies` table has no owner column, so a cross-tenant id would
 * otherwise be accepted verbatim (W3.1b IDOR: cross-owner completion oracle +
 * id-existence disclosure via `blocked`). Non-owned ids are dropped silently — we
 * never signal whether the id exists (mirrors services/tags.ts owner-namespace
 * resolution). Order-preserving so the cycle probe still walks in caller order.
 */
function ownedDependsOnIds(ownerId: string, ids: string[]): string[] {
  if (ids.length === 0) return ids;
  // Keep well under SQLITE_MAX_VARIABLE_NUMBER (often 999) since ids is client-controlled.
  const CHUNK = 500;
  const owned = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = sqlite
      .prepare(`SELECT id FROM tasks WHERE id IN (${placeholders}) AND owner_id = ?`)
      .all(...chunk, ownerId) as { id: string }[];
    for (const r of rows) owned.add(r.id);
  }
  return ids.filter((id) => owned.has(id));
}

/** Add a single edge, rejecting self-edges and any edge that would close a cycle. */
export function addDependency(taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new DependencyCycleError(taskId, dependsOnId);
  // If dependsOnId already reaches taskId, adding taskId→dependsOnId closes a loop.
  if (reaches(dependsOnId, taskId)) throw new DependencyCycleError(taskId, dependsOnId);
  sqlite
    .prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)')
    .run(taskId, dependsOnId);
}

/**
 * Replace a task's full set of blockers (used by POST/PATCH). Atomic; cycle-checked.
 * When `ownerId` is supplied (the client-driven create/update paths), candidate
 * blocker ids are first filtered to the caller's own tasks (W3.1b) so owner A can
 * never depend on owner B's task. Engine/internal callers may omit it (no external
 * input, ids are already trusted).
 */
export function setDependencies(taskId: string, dependsOnIds: string[], ownerId?: string): void {
  const scoped = ownerId !== undefined ? ownedDependsOnIds(ownerId, dependsOnIds) : dependsOnIds;
  const unique = [...new Set(scoped)].filter((d) => d !== taskId);
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
    for (const dep of unique) addDependency(taskId, dep);
  });
  tx();
}

/** The blockers of a task (depends_on ids). */
export function getDependencies(taskId: string): string[] {
  return (
    sqlite.prepare('SELECT depends_on_id AS d FROM task_dependencies WHERE task_id = ?').all(taskId) as {
      d: string;
    }[]
  ).map((r) => r.d);
}

/** Task ids that have at least one blocker not yet `done` — i.e. currently blocked. */
export function blockedTaskIds(): Set<string> {
  return new Set(
    (
      sqlite
        .prepare(
          `SELECT DISTINCT d.task_id AS id
           FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_id
           WHERE b.status <> 'done'`
        )
        .all() as { id: string }[]
    ).map((r) => r.id)
  );
}
