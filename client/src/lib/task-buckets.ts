import type { Task } from './api.js';
import { dayRangeUTC } from './dates.js';

/**
 * Phase O · O3 — the Today-header count buttons.
 *
 * Four single-select buckets over the loaded task set. Overdue and due-today use
 * the same local-day deadline rules as the Today Due popup and TaskCard badges:
 *
 *   overdue    — ACTIVE status AND due_at before the local day; a defer_until date
 *                must have arrived before it is eligible to appear
 *   due today  — ACTIVE status AND due_at within the local day; deferred tasks
 *                appear only when their defer date has arrived
 *   scheduled  — not routine AND (status IN (scheduled, in_progress) OR placed on the planner for the day)
 *   open       — a plain backlog task (status='open'), not routine and not placed for the day
 *
 * Pure + framework-free so it can be unit-tested in a node env (no jsdom). The
 * caller supplies `scheduledIds` (the store's placement map for the loaded range)
 * and `isRoutine` (routine-membership predicate) so this stays dependency-free.
 */
export type BucketKey = 'overdue' | 'dueToday' | 'scheduled' | 'open';

export interface BucketDeps {
  /** Task ids placed on the planner for `date` (store's scheduledByTaskId keys). */
  scheduledIds: Set<string>;
  /** Routine-membership predicate (store's isRoutineTask). */
  isRoutine: (id: string) => boolean;
}

const ACTIVE = new Set(['open', 'scheduled', 'in_progress']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A date-only due value is a local calendar date; an ISO value is an instant. */
function isDateOnly(value: string): boolean { return DATE_ONLY.test(value); }

/** True when `due_at` is before the local calendar day. */
function isBeforeDay(dueAt: string | undefined, date: string): boolean {
  if (!dueAt) return false;
  if (isDateOnly(dueAt)) return dueAt < date;
  const dueMs = Date.parse(dueAt);
  return Number.isFinite(dueMs) && dueMs < Date.parse(dayRangeUTC(date).from);
}

/** True when `due_at` falls within the local `date`. */
function isOnDay(dueAt: string | undefined, date: string): boolean {
  if (!dueAt) return false;
  if (isDateOnly(dueAt)) return dueAt === date;
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) return false;
  const { from, to } = dayRangeUTC(date);
  return dueMs >= Date.parse(from) && dueMs <= Date.parse(to);
}

/** A defer date releases a task once the selected local day reaches that date. */
function isAvailableOnDay(task: Pick<Task, 'status' | 'defer_until'>, date: string): boolean {
  if (!ACTIVE.has(task.status)) return false;
  const deferredUntil = task.defer_until;
  if (!deferredUntil) return true;
  if (isDateOnly(deferredUntil)) return deferredUntil <= date;
  const deferMs = Date.parse(deferredUntil);
  if (!Number.isFinite(deferMs)) return true;
  return deferMs <= Date.parse(dayRangeUTC(date).to);
}

/** True when an active task's deadline is before the selected local calendar day. */
export function isTaskOverdueOnDay(
  task: Pick<Task, 'status' | 'due_at' | 'defer_until'>,
  date: string,
): boolean {
  return isAvailableOnDay(task, date) && isBeforeDay(task.due_at, date);
}

/** Sort by actual deadline; a date-only deadline means end of that local day. */
function dueSortValue(dueAt: string | undefined): number {
  if (!dueAt) return Number.POSITIVE_INFINITY;
  if (isDateOnly(dueAt)) return Date.parse(dayRangeUTC(dueAt).to);
  const parsed = Date.parse(dueAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** The tasks in a single bucket for `date`, top-level only (no subtasks). */
export function tasksInBucket(
  bucket: BucketKey,
  tasks: Task[],
  date: string,
  deps: BucketDeps,
): Task[] {
  const top = tasks.filter((t) => !t.parent_id);
  switch (bucket) {
    case 'overdue':
      return top.filter((t) => isTaskOverdueOnDay(t, date));
    case 'dueToday':
      return top.filter((t) => isAvailableOnDay(t, date) && isOnDay(t.due_at, date));
    case 'scheduled':
      return top.filter(
        (t) => !deps.isRoutine(t.id) && (t.status === 'scheduled' || t.status === 'in_progress' || deps.scheduledIds.has(t.id)),
      );
    case 'open':
      return top.filter((t) => t.status === 'open' && !deps.isRoutine(t.id) && !deps.scheduledIds.has(t.id));
  }
}

/** {key,count} for every bucket, in display order. */
export function bucketCounts(
  tasks: Task[],
  date: string,
  deps: BucketDeps,
): { key: BucketKey; count: number }[] {
  return (['overdue', 'dueToday', 'scheduled', 'open'] as BucketKey[]).map((key) => ({
    key,
    count: tasksInBucket(key, tasks, date, deps).length,
  }));
}

/**
 * Phase AB · AB4 — the always-visible "Due" card on the Today view.
 *
 * The card's two groups for a selected local day, top-level tasks only:
 *   dueToday — ACTIVE status AND due_at within the local day (same rule as the
 *              'dueToday' bucket, so the card and the count button always agree);
 *   overdue  — ACTIVE status AND due_at before the selected local day (the
 *              rollup; same rule as the 'overdue' bucket).
 * Deferred tasks remain hidden until their defer date. A date-only `due_at` means
 * a local calendar day; ISO timestamps are compared as instants. Both groups are
 * sorted by due_at ascending (oldest debt first / earliest deadline first).
 * Works for any navigated date, not just today — "overdue" is relative to the
 * SELECTED day, matching the buckets.
 */
export interface DueItems {
  overdue: Task[];
  dueToday: Task[];
  /** The Missed review surface (engine/review.ts): high-priority tasks the nightly
   *  sweep marked `status='missed'` — waiting on an explicit user reschedule.
   *  Recurring INSTANCES are excluded: a missed routine day is genuine history
   *  (recurrence-generate marks stale instances missed itself); only one-off tasks
   *  are revivable via the +N-day reschedule. Date-independent — missed is a state,
   *  not a deadline relation. */
  missed: Task[];
}

export function dueItems(tasks: Task[], date: string): DueItems {
  const top = tasks.filter((t) => !t.parent_id);
  const byDueAt = (a: Task, b: Task) => dueSortValue(a.due_at) - dueSortValue(b.due_at);
  const bySchedFor = (a: Task, b: Task) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? '');
  return {
    overdue: top.filter((t) => isTaskOverdueOnDay(t, date)).sort(byDueAt),
    dueToday: top.filter((t) => isAvailableOnDay(t, date) && isOnDay(t.due_at, date)).sort(byDueAt),
    missed: top.filter((t) => t.status === 'missed' && !t.recurrence_parent_id).sort(bySchedFor),
  };
}

/**
 * A single-step paging window over a list: `size` visible rows starting at
 * `offset`, clamped so the window never runs past the end. Returns the clamped
 * offset, the visible slice, how many rows remain below the window, and whether
 * the up/down steppers are disabled. The stepper advances one item at a time.
 */
export interface PageWindow<T> {
  offset: number;
  visible: T[];
  remaining: number;   // items below the visible window (drives "+N more")
  canUp: boolean;      // false at offset 0
  canDown: boolean;    // false when the window's last row is the list's last row
}

export function pageWindow<T>(items: T[], rawOffset: number, size: number): PageWindow<T> {
  const maxOffset = Math.max(0, items.length - size);
  const offset = Math.min(Math.max(0, rawOffset), maxOffset);
  const end = Math.min(offset + size, items.length);
  return {
    offset,
    visible: items.slice(offset, end),
    remaining: items.length - end,
    canUp: offset > 0,
    canDown: end < items.length,
  };
}
