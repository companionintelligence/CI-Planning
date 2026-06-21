import { sqlite } from '../db/index.js';

export class DependencyCycleError extends Error {
  constructor(taskId: string, dependsOnId: string) {
    super(`Adding dependency ${taskId}→${dependsOnId} would create a cycle`);
    this.name = 'DependencyCycleError';
  }
}

/** Does `from` already reach `to` through depends_on edges? (cycle probe) */
function reaches(from: number, to: number): boolean {
  const seen = new Set<number>();
  const stack = [from];
  const q = sqlite.prepare('SELECT depends_on_id AS d FROM task_dependencies WHERE task_id = ?');
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const r of q.all(n) as { d: number }[]) stack.push(r.d);
  }
  return false;
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

/** Replace a task's full set of blockers (used by POST/PATCH). Atomic; cycle-checked. */
export function setDependencies(taskId: string, dependsOnIds: string[]): void {
  const unique = [...new Set(dependsOnIds)].filter((d) => d !== taskId);
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
    for (const dep of unique) addDependency(taskId, dep);
  });
  tx();
}

/** The blockers of a task (depends_on ids). */
export function getDependencies(taskId: string): number[] {
  return (
    sqlite.prepare('SELECT depends_on_id AS d FROM task_dependencies WHERE task_id = ?').all(taskId) as {
      d: number;
    }[]
  ).map((r) => r.d);
}

/** Task ids that have at least one blocker not yet `done` — i.e. currently blocked. */
export function blockedTaskIds(): Set<number> {
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
