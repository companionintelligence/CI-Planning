import type { Database } from 'better-sqlite3';

export const id = '0085_objective_levels_bottom_up';

/**
 * Objectives tree re-leveled bottom-up (Goal › Project › Objective).
 *
 * Phase N shipped `level` derived from depth-from-top (root=goal, 1=project,
 * 2+=milestone). The task-list "promote a task with subtasks to an objective"
 * feature builds the tree bottom-up instead: a task-bearing leaf is an
 * "objective", a node of objectives is a "project", a node of projects is a
 * "goal". So `level` is now derived from a node's HEIGHT (longest path down to a
 * leaf descendant), and the leaf level is renamed 'milestone' → 'objective'.
 *
 * This recomputes `level` for every existing objective under the new rule (which
 * subsumes the rename). No schema change — `level` is a plain TEXT column.
 */
export function up(db: Database): void {
  const ids = db.prepare(`SELECT id FROM objectives`).all() as { id: string }[];
  const heightStmt = db.prepare(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT id, 0 FROM objectives WHERE id = ?
       UNION ALL
       SELECT o.id, down.depth + 1 FROM objectives o JOIN down ON o.parent_id = down.id
     )
     SELECT MAX(depth) AS d FROM down`,
  );
  const upd = db.prepare(`UPDATE objectives SET level = ? WHERE id = ?`);
  for (const { id: objId } of ids) {
    const { d } = heightStmt.get(objId) as { d: number };
    const level = d === 0 ? 'objective' : d === 1 ? 'project' : 'goal';
    upd.run(level, objId);
  }
}
