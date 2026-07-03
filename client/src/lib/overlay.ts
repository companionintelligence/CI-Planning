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

/**
 * A block that represents a scheduled Task (as opposed to a time-block container
 * such as meeting/focus/habit/break/buffer/timeblock). A task block is the one
 * kind that links to a `task_id` AND carries `block_kind === 'task'` — matching
 * the same rule stores/index.ts uses to build `scheduledByTaskId`. This predicate
 * drives the calendar's render + interaction split: task chips keep their titles
 * and open the task editor on click; containers hide their label behind a thick
 * hover-reveal left edge.
 */
export const isTaskBlock = (b: Pick<Block, 'block_kind' | 'task_id'>): boolean =>
  b.block_kind === 'task' && !!b.task_id;

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
