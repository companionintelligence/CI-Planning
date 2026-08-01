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
 *   Routine > Scheduled > New Today > Open — see `partitionTaskSections`.
 *
 * Scheduled outranks New Today (owner ruling): placing a task the same day it was
 * created moves its card to Scheduled IMMEDIATELY. Under the original AF-7 order New
 * Today won, so a just-scheduled task sat in New Today until the local midnight and the
 * placement produced no visible movement — the section then read as "created today"
 * rather than "not yet dealt with".
 *
 * This module is the single, pure authority for that partition so it can be
 * unit-tested without a DOM (the client test runner has no jsdom).
 */

/** Top-level = not a subtask and not a recurrence instance; those nest under a parent. */
export function isTopLevelTask(t: Task): boolean {
  return !t.parent_id && !t.recurrence_parent_id;
}

/**
 * True when `createdAt` (a UTC instant, e.g. `tasks.created_at`) falls on the
 * local calendar day `todayISO` (YYYY-MM-DD). Mirrors the `isDoneToday` convention in
 * AllTasks: convert the instant to the client's LOCAL day, then string-compare — a raw
 * UTC comparison would flip the day around midnight for users west/east of UTC. This is
 * what makes the midnight rollover pure derivation: a task created yesterday simply
 * stops matching `todayISO` once the local day turns over, with no job moving anything.
 *
 * `tasks.created_at` is defaulted by SQLite's `CURRENT_TIMESTAMP`, which stores
 * `'YYYY-MM-DD HH:MM:SS'` — a UTC instant with NO zone designator that `new Date()`
 * would otherwise parse as LOCAL time. Behind UTC that silently shifted every
 * evening-created task into TOMORROW's bucket, so it missed New Today on the day it
 * actually arrived. Stamping the Z first is what makes the section honest; the server's
 * `sqliteUtcToISO` applies the identical rule so both ends agree on the same set.
 */
export function isCreatedOnDay(createdAt: string | null | undefined, todayISO: string): boolean {
  if (!createdAt) return false;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(createdAt)
    ? `${createdAt.replace(' ', 'T')}Z`
    : createdAt;
  const d = new Date(normalized);
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
 *   1. Routine    — a routine task stays in Routine even if created today or scheduled.
 *   2. Scheduled  — non-routine, placed/scheduled, INCLUDING one created today.
 *   3. New Today  — non-routine, unscheduled, created_at is the local today.
 *   4. Open       — everything else.
 * Non-top-level rows (subtasks, recurrence instances) are dropped defensively so they
 * never surface flat in a section — they render nested under their parent instead.
 *
 * New Today therefore means "arrived today and still needs a decision", and scheduling
 * is what retires it — the card moves on placement, not at midnight. What remains
 * derived-not-stored is the OTHER edge: an unscheduled New Today task falls into Open
 * purely because `todayISO` advanced, with no column and no job.
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
    if (opts.isScheduled(t)) { scheduled.push(t); continue; }
    if (isCreatedOnDay(t.created_at, today)) { newToday.push(t); continue; }
    open.push(t);
  }
  return { newToday, open, scheduled, routine };
}

/**
 * Header "N open" count (owner decision, AF-7 follow-up): a task created today counts
 * as open IMMEDIATELY — not only after it rolls into the Open section at midnight. So
 * the count spans BOTH the New Today and Open sections. Scheduled and Routine never
 * count, and neither do completed/cancelled rows (a done-today task renders checked in
 * the active list but isn't "open"). Each task lands in exactly one section, so summing
 * the two cannot double-count.
 *
 * The Scheduled exclusion needs no predicate here: since Scheduled outranks New Today in
 * the partition, neither of the two summed sections can contain a scheduled task at all
 * (the earlier `!isScheduled` filter existed only to strip them out of New Today under
 * the old order). The resulting NUMBER is unchanged by that precedence swap — a
 * scheduled task created today was excluded by the filter before and is excluded by its
 * section now. The midnight rollover (New Today → Open) likewise still leaves the total
 * unchanged. Takes an already-computed partition so callers reuse their sections memo
 * instead of re-running the partition just for the count.
 */
export function headerOpenCount(sections: TaskSections): number {
  const isOpenish = (t: Task) => t.status !== 'done' && t.status !== 'cancelled';
  return sections.open.filter(isOpenish).length + sections.newToday.filter(isOpenish).length;
}
