import type { Task } from './api.js';
import { localISODate } from './dates.js';

/**
 * AF-7 · Tasks-tab sectioning.
 *
 * The default Tasks tab groups the active backlog into four derived sections. Two
 * distinct orderings are at play — don't conflate them:
 *
 * - UI render order (top → bottom):     New Today, Open, Scheduled, Routine.
 * - Membership precedence (which single section a task lands in, first match wins):
 *   Routine > New Today > Scheduled > Open — see `partitionTaskSections`.
 *
 * This module is the single, pure authority for that partition so it can be
 * unit-tested without a DOM (the client test runner has no jsdom).
 */

/** Top-level = not a subtask and not a recurrence instance; those nest under a parent. */
export function isTopLevelTask(t: Task): boolean {
  return !t.parent_id && !t.recurrence_parent_id;
}

/**
 * True when `createdAt` (a UTC ISO instant, e.g. `tasks.created_at`) falls on the
 * local calendar day `todayISO` (YYYY-MM-DD). Mirrors the `isDoneToday` convention in
 * AllTasks: convert the instant to the client's LOCAL day, then string-compare — a raw
 * UTC comparison would flip the day around midnight for users west/east of UTC. This is
 * what makes the midnight rollover pure derivation: a task created yesterday simply
 * stops matching `todayISO` once the local day turns over, with no job moving anything.
 */
export function isCreatedOnDay(createdAt: string | null | undefined, todayISO: string): boolean {
  if (!createdAt) return false;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return false;
  return localISODate(d) === todayISO;
}

export interface SectionPredicates {
  /** Membership in a routine (checklist) — wins the grouping over everything else. */
  isRoutine: (t: Task) => boolean;
  /** Real planner placement OR a scheduled/in_progress status. */
  isScheduled: (t: Task) => boolean;
  /** The local calendar day used for the "New Today" boundary. Defaults to now. */
  todayISO?: string;
}

export interface TaskSections {
  newToday: Task[];
  open: Task[];
  scheduled: Task[];
  routine: Task[];
}

/**
 * Partition an already-filtered, already-sorted active backlog into the four Tasks-tab
 * sections. Precedence (each task lands in exactly one section):
 *   1. Routine    — a routine task stays in Routine even if created today.
 *   2. New Today  — non-routine tasks whose created_at is the local today.
 *   3. Scheduled  — non-routine, not-new-today, placed/scheduled.
 *   4. Open       — everything else.
 * Non-top-level rows (subtasks, recurrence instances) are dropped defensively so they
 * never surface flat in a section — they render nested under their parent instead.
 */
export function partitionTaskSections(list: Task[], opts: SectionPredicates): TaskSections {
  const today = opts.todayISO ?? localISODate();
  const newToday: Task[] = [];
  const open: Task[] = [];
  const scheduled: Task[] = [];
  const routine: Task[] = [];
  for (const t of list) {
    if (!isTopLevelTask(t)) continue;
    if (opts.isRoutine(t)) { routine.push(t); continue; }
    if (isCreatedOnDay(t.created_at, today)) { newToday.push(t); continue; }
    if (opts.isScheduled(t)) { scheduled.push(t); continue; }
    open.push(t);
  }
  return { newToday, open, scheduled, routine };
}

/**
 * Header "N open" count (owner decision, AF-7 follow-up): a task created today counts
 * as open IMMEDIATELY — not only after it rolls into the Open section at midnight. So
 * the count spans BOTH the New Today and Open sections, but keeps the Open section's
 * historical exclusions: Scheduled and Routine never count (a scheduled task created
 * today sits in New Today yet still doesn't count), and neither do completed/cancelled
 * rows (a done-today task renders checked in the active list but isn't "open"). Each
 * task lands in exactly one section, so summing the two filtered sections cannot
 * double-count. Counting by predicate rather than by section also means the midnight
 * rollover (New Today → Open) leaves the total unchanged when nothing else changes.
 * Takes an already-computed partition so callers reuse their sections memo instead of
 * re-running the partition just for the count.
 */
export function headerOpenCount(sections: TaskSections, isScheduled: (t: Task) => boolean): number {
  const isOpenish = (t: Task) =>
    t.status !== 'done' && t.status !== 'cancelled' && !isScheduled(t);
  return sections.open.filter(isOpenish).length + sections.newToday.filter(isOpenish).length;
}
