/**
 * Overlay filter predicate (Phase F PR-3): pure so it's unit-testable without the
 * SSE/resource machinery in `stores/index.ts`.
 *
 * Tag and priority live on the linked *task*, not the block, and AND-combine. An
 * empty filter means "all". A block with no linked task (break/buffer) passes only
 * when neither filter is set.
 */
import type { Block, Task } from './api.js';

/** All-day blocks (header lane). Absent `all_day` column ⇒ false (pre-migration). */
export const isAllDay = (b: Pick<Block, 'all_day'>): boolean => b.all_day === true;
/** Timed blocks (minute axis): everything not flagged all-day. */
export const isTimed = (b: Pick<Block, 'all_day'>): boolean => !isAllDay(b);

export function blockPasses(
  block: Pick<Block, 'task_id'>,
  task: Pick<Task, 'tags' | 'priority'> | undefined,
  tagFilter: string[],
  prioFilter: number[],
): boolean {
  void block; // task linkage is resolved by the caller; signature kept for clarity
  const tagOk = !tagFilter.length || (!!task && task.tags.some((x) => tagFilter.includes(x)));
  const prioOk = !prioFilter.length || (!!task && prioFilter.includes(task.priority));
  return tagOk && prioOk;
}
