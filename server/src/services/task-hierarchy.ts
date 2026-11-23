import { store } from '../db/store.js';
import { stampRow } from '../sync/apply.js';
import { syncTaskReminders } from '../engine/reminders.js';

export interface TaskHierarchyChanges {
  taskIds: string[];
  blockIds: string[];
}

/**
 * Keep a task with subtasks aligned to the work beneath it. A parent stays open
 * until a child is started; once any child is in progress or done, the parent is
 * in progress until every active child is done. Cancelled children leave the set.
 *
 * `seedIds` may name changed tasks or known parents. The walk recalculates each
 * task with children and continues up its parent chain, so completing a deep
 * subtask updates every objective task above it.
 */
export async function recomputeTaskHierarchy(ownerId: string, seedIds: readonly (string | null | undefined)[]): Promise<TaskHierarchyChanges> {
  const queue = [...new Set(seedIds.filter((id): id is string => !!id))];
  const visited = new Set<string>();
  const taskIds: string[] = [];
  const blockIds: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const parent = await store().prepare(
      `SELECT id, parent_id, status, completed_at FROM tasks WHERE id = ? AND owner_id = ?`,
    ).get<{ id: string; parent_id: string | null; status: string; completed_at: string | null }>(id, ownerId);
    if (!parent) continue;

    if (!['cancelled', 'archived'].includes(parent.status)) {
      const allChildren = await store().prepare(
        `SELECT status FROM tasks WHERE parent_id = ? AND owner_id = ?`,
      ).all<{ status: string }>(id, ownerId);
      if (allChildren.length > 0) {
        const children = allChildren.filter((child) => !['cancelled', 'archived'].includes(child.status));
        const nextStatus = children.length === 0
          ? 'open'
          : children.every((child) => child.status === 'done')
          ? 'done'
          : children.some((child) => child.status === 'in_progress' || child.status === 'done')
            ? 'in_progress'
            : 'open';

        if (nextStatus !== parent.status) {
          const completedAt = nextStatus === 'done' ? (parent.completed_at ?? new Date().toISOString()) : null;
          const info = await store().prepare(
            `UPDATE tasks SET status = ?, completed_at = ? WHERE id = ? AND owner_id = ? AND status = ?`,
          ).run(nextStatus, completedAt, id, ownerId, parent.status);
          if (info.changes > 0) {
            await stampRow('task', id, ['status', 'completedAt']);
            await syncTaskReminders(ownerId, id);
            taskIds.push(id);

            // A stored system-lane choice must follow the derived task status too.
            // Keep user-defined columns intact; only Open / In work / Done are
            // controlled by this rollup.
            const targetSystemKey = nextStatus === 'done' ? 'done' : nextStatus === 'in_progress' ? 'in_work' : 'open';
            const targetColumn = await store().prepare(
              `SELECT id FROM objective_board_columns WHERE owner_id = ? AND system_key = ?`,
            ).get<{ id: string }>(ownerId, targetSystemKey);
            if (targetColumn) {
              await store().prepare(
                `UPDATE objective_board_cards
                    SET column_id = ?, updated_at = ?
                  WHERE owner_id = ? AND task_id = ?
                    AND EXISTS (
                      SELECT 1 FROM objective_board_columns c
                       WHERE c.id = objective_board_cards.column_id AND c.owner_id = ? AND c.system_key IS NOT NULL
                    )`,
              ).run(targetColumn.id, new Date().toISOString(), ownerId, id, ownerId);
            }

            const fromStatuses = nextStatus === 'done'
              ? `'planned','overrun','in_progress'`
              : parent.status === 'done' ? `'completed'` : '';
            if (fromStatuses) {
              const blocks = await store().prepare(
                `SELECT id FROM time_blocks
                  WHERE task_id = ? AND owner_id = ? AND block_kind = 'task' AND status IN (${fromStatuses})`,
              ).all<{ id: string }>(id, ownerId);
              const blockStatus = nextStatus === 'done' ? 'completed' : 'planned';
              for (const block of blocks) {
                const changed = await store().prepare(
                  `UPDATE time_blocks SET status = ? WHERE id = ? AND owner_id = ?`,
                ).run(blockStatus, block.id, ownerId);
                if (changed.changes > 0) {
                  await stampRow('block', block.id, ['status']);
                  blockIds.push(block.id);
                }
              }
            }
          }
        }
      }
    }

    if (parent.parent_id) queue.push(parent.parent_id);
  }

  return { taskIds, blockIds };
}
