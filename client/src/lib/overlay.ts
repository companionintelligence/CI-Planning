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

/**
 * Whether a block renders a VISIBLE title on the calendar, as opposed to standing in
 * for one with a thick hover-reveal left edge.
 *
 * Deliberately separate from isTaskBlock, which governs *interaction* (only a real task
 * chip opens the task editor). The label-hiding treatment was designed for anonymous
 * time-block containers, but `meeting` is the one container kind anything actually
 * writes — and every meeting is a real, externally-named event mirrored from a
 * connected calendar. Hiding those names left the whole week rendering as blank
 * rectangles once a Google account was connected.
 */
export const showsBlockLabel = (b: Pick<Block, 'block_kind' | 'task_id'>): boolean =>
  isTaskBlock(b) || b.block_kind === 'meeting';

/**
 * A block mirrored in from a connected external calendar. Keyed on `source_account`
 * rather than `source_kind`, because source_kind only says WHICH PROVIDER and is also
 * stamped on things the owner created here; the account is present only on rows
 * external_events actually maps.
 */
export const isExternalBlock = (b: Pick<Block, 'source_account'>): boolean => !!b.source_account;

/**
 * Events-only ("free time") view: show what genuinely constrains the day and hide
 * everything the owner could move. That is external calendar events plus anything
 * explicitly locked — a locked block is a commitment regardless of where it came from,
 * so hiding it would paint busy time as free, which is the one error this view must
 * never make. Unlocked task blocks (including auto-placed work) drop out.
 */
export const isCommitment = (b: Pick<Block, 'source_account' | 'is_locked'>): boolean =>
  isExternalBlock(b) || b.is_locked === true;

/** Done-ish statuses no longer hold their span — the slot is open again. Mirrors the
 *  server's block DONE_STATUSES (engine/blocks-place.ts). */
const INACTIVE_STATUSES = new Set(['completed', 'done', 'cancelled', 'skipped', 'missed']);

/**
 * Does this block hold minutes on the day's timeline?
 *
 * The single home for that question, because more than one feature asks it and they
 * must not drift: click-to-create asks it to refuse stacking onto an occupied slot
 * (`isSlotOccupied`), and the Today header asks it to subtract busy time from the
 * day's placement windows (`busyFromBlocks`). Three things do NOT occupy minutes:
 *
 *  - **all-day blocks** live in the pinned header lane, not the minute axis. Their
 *    `end_at` is start + duration — an artifact of the notNull column, not a span —
 *    so subtracting it removes hours nothing is actually using.
 *  - **someday concepts** have no start/end semantics at all (0019/CON-2); they are
 *    stored at their goal day's midnight for ordering, not placement.
 *  - **finished or cancelled blocks** have given their slot back.
 *
 * Says nothing about WHICH minutes — the caller resolves that against its own day.
 */
export const occupiesMinuteAxis = (
  b: Pick<Block, 'all_day' | 'block_type' | 'status' | 'start_at' | 'end_at'>,
): boolean =>
  isTimed(b) && b.block_type !== 'someday' && !INACTIVE_STATUSES.has(b.status)
  && !!b.start_at && !!b.end_at;

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
 * Does a plain name list pass a deselection set? The category-axis twin of
 * `axisPasses` (Phase D): categories are NOT tag names on the task — they ride the
 * block's `categories` (its effective set: own entity_categories rows, else its
 * task's, derived server-side) — so there's no kind-bucketing step. Same
 * semantics: nothing on the axis passes; else any still-selected name passes.
 */
export function namesPass(names: readonly string[], deselected: ReadonlySet<string>): boolean {
  if (deselected.size === 0) return true;
  if (names.length === 0) return true; // uncategorized is never hidden
  return names.some((n) => !deselected.has(n));
}

/**
 * The full calendar predicate: a block passes when it clears all three tag axes AND
 * the priority row. Direction/intention come from the linked task's tags; the
 * CATEGORY axis reads the block's effective `categories` (Phase D — previously it
 * matched category names against task tags, where they never appear, making the
 * category row inert). A block with no task (break/buffer) carries no tags and no
 * priority, so it passes every tag axis but is hidden the moment a priority
 * filter is set.
 */
export function blockPassesAxes(
  block: Pick<Block, 'task_id' | 'categories'>,
  task: Pick<Task, 'tags' | 'priority'> | undefined,
  kindOf: TagKindLookup,
  deselected: AxisDeselected,
  prioFilter: readonly number[],
): boolean {
  const tags = task?.tags ?? [];
  const tagsOk = (['direction', 'intention'] as const).every((axis) => axisPasses(tags, axis, kindOf, deselected[axis]));
  const catOk = namesPass(block.categories ?? [], deselected.category);
  const prioOk = !prioFilter.length || (!!task && prioFilter.includes(task.priority));
  return tagsOk && catOk && prioOk;
}
