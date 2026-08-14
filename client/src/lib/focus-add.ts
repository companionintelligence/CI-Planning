import type { Task } from './api.js';
import { filterByName } from './flight-plan-view.js';

/**
 * FOCUS × Time Blocks, Phase 3 — the inline "add a task to this Time Block" box.
 *
 * One input, two paths, one gesture: type to SEARCH the open backlog, or type
 * something with no match and press Enter to CREATE it. Both end the same way —
 * the task is placed inside the container as a member block.
 *
 * The matching and the outcome wording are pure so the keyboard contract can be
 * tested without jsdom, and so Focus words a full container the same way the
 * Planner does.
 */

/** How many matches the dropdown shows — FlightPlan's cap, for one idiom. */
export const MATCH_CAP = 8;

/**
 * Backlog matches for a section's add box: open tasks whose title contains the
 * query, minus the ones already in this block.
 *
 * Recurrence instances are excluded for the same reason FlightPlan excludes them —
 * they are generated occurrences, not backlog items, and the server rejects staging
 * them. Empty query yields nothing: the dropdown only exists once you type.
 */
export function addCandidates(
  tasks: readonly Task[],
  query: string,
  alreadyInBlock: ReadonlySet<string>,
): Task[] {
  if (!query.trim()) return [];
  return filterByName([...tasks], query, (t) => t.title)
    .filter((t) => !alreadyInBlock.has(t.id) && !t.recurrence_parent_id)
    .slice(0, MATCH_CAP);
}

/**
 * Move the highlighted index by `delta`, wrapping at both ends. Returns 0 for an
 * empty list so Enter on no matches is unambiguous (it means "create this").
 */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

/** The subset of the add-tasks response the message depends on. */
export interface PlaceOutcome {
  placed: number;
  unplaced: number;
  skipped: number;
}

export type OutcomeKind = 'success' | 'default' | 'error';

/**
 * What to tell the owner after placing into a container.
 *
 * A FULL container is the interesting case. Decision 7 settled it after this phase
 * was written: a full Time Block **never auto-extends** — its span is the owner's
 * stated budget for that category. So "didn't fit" is a real outcome to report, not
 * a failure to route around, and the plan's alternative (grow the block via
 * extend-block) is deliberately not taken.
 */
export function describeAddOutcome(title: string, r: PlaceOutcome): { message: string; kind: OutcomeKind } {
  if (r.placed > 0) return { message: `Added "${title}"`, kind: 'success' };
  if (r.unplaced > 0) return { message: `No room left in this Time Block for "${title}"`, kind: 'default' };
  if (r.skipped > 0) return { message: `"${title}" is already in this Time Block`, kind: 'default' };
  return { message: `Couldn't add "${title}"`, kind: 'error' };
}
