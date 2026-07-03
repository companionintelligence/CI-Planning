/**
 * Overlay filter predicate (Phase F PR-3; three-axis rework Wave 3 item 11): pure so
 * it's unit-testable without the SSE/resource machinery in `stores/index.ts`.
 *
 * Tags + priority live on the linked *task*, not the block. The calendar overlay now
 * has THREE independent tag axes — Direction / Intention / Category (tags.kind) — plus
 * the priority row, all AND-combined.
 *
 * State model: each axis is a set of DESELECTED (hidden) tag names. Empty set = every
 * chip on = no filtering on that axis (the historical "empty means all" invariant, so
 * tags loading async need no eager population). A chip is ON when its name is NOT in the
 * axis's deselected set.
 *
 * Semantics: OR within a group (a block passes an axis if ANY of its tags on that axis
 * is still selected), AND across groups (must pass Direction AND Intention AND Category
 * AND priority). Untagged-on-an-axis blocks ALWAYS pass that axis — hiding a direction
 * never hides blocks that carry no direction at all.
 */
import type { Block, Task } from './api.js';

/** All-day blocks (header lane). Absent `all_day` column ⇒ false (pre-migration). */
export const isAllDay = (b: Pick<Block, 'all_day'>): boolean => b.all_day === true;
/** Timed blocks (minute axis): everything not flagged all-day. */
export const isTimed = (b: Pick<Block, 'all_day'>): boolean => !isAllDay(b);

/** The three tag axes the calendar overlay filters on (tags.kind, post Z/W2 revert). */
export type TagAxis = 'direction' | 'intention' | 'category';
export const TAG_AXES: TagAxis[] = ['direction', 'intention', 'category'];

/** Per-axis sets of DESELECTED (hidden) tag names. Empty set = all-on for that axis. */
export type AxisDeselected = Record<TagAxis, Set<string>>;

/** A tag-name → kind lookup, so the predicate can bucket a task's tag names by axis. */
export type TagKindLookup = ReadonlyMap<string, TagAxis>;

/** Build the empty (all-on) deselection state — nothing hidden on any axis. */
export function emptyAxisDeselected(): AxisDeselected {
  return { direction: new Set(), intention: new Set(), category: new Set() };
}

/** True when no chip is deselected on any axis (i.e. the tag filter is inert). */
export function noAxisFilter(deselected: AxisDeselected): boolean {
  return TAG_AXES.every((axis) => deselected[axis].size === 0);
}

/**
 * Does a task's tag set pass ONE axis?
 *  - the task's tag names are bucketed to this axis via the kind lookup;
 *  - no tag on this axis ⇒ pass (untagged-on-axis is never hidden);
 *  - otherwise pass iff at least one of those tags is still selected (OR-within-group).
 */
export function axisPasses(
  taskTags: readonly string[],
  axis: TagAxis,
  kindOf: TagKindLookup,
  deselected: ReadonlySet<string>,
): boolean {
  if (deselected.size === 0) return true; // whole axis is all-on
  let hasOnAxis = false;
  for (const name of taskTags) {
    if (kindOf.get(name) !== axis) continue;
    hasOnAxis = true;
    if (!deselected.has(name)) return true; // a still-selected tag on this axis
  }
  return !hasOnAxis; // untagged-on-axis passes; else every on-axis tag was hidden
}

/**
 * The full calendar predicate: a block passes when it clears all three tag axes AND
 * the priority row. Tag/priority come from the linked task; a block with no task
 * (break/buffer) carries no tags and no priority, so it passes every tag axis
 * (untagged-on-axis) but is hidden the moment a priority filter is set.
 */
export function blockPassesAxes(
  block: Pick<Block, 'task_id'>,
  task: Pick<Task, 'tags' | 'priority'> | undefined,
  kindOf: TagKindLookup,
  deselected: AxisDeselected,
  prioFilter: readonly number[],
): boolean {
  void block; // task linkage is resolved by the caller; signature kept for clarity
  const tags = task?.tags ?? [];
  const tagsOk = TAG_AXES.every((axis) => axisPasses(tags, axis, kindOf, deselected[axis]));
  const prioOk = !prioFilter.length || (!!task && prioFilter.includes(task.priority));
  return tagsOk && prioOk;
}
