import type { Task } from './api.js';
import { dayRangeUTC } from './dates.js';

/**
 * Phase O · O3 — the Today-header count buttons.
 *
 * Four single-select buckets over the loaded task set, mirroring the server's
 * summary stats (server/src/agents/summarize.ts) so the header counts and the
 * revealed lists agree:
 *
 *   overdue    — status IN (open, scheduled) AND due_at < the local day start
 *   due today  — status IN (open, scheduled) AND due_at within the local day
 *   scheduled  — placed on the planner for the day (scheduledIds) OR status='scheduled'
 *   open       — a plain backlog task (status='open'), not routine
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

/** True when `due_at` (ISO instant) falls before the local `date`'s midnight. */
function isBeforeDay(dueAt: string | undefined, date: string): boolean {
  if (!dueAt) return false;
  return dueAt < dayRangeUTC(date).from;
}

/** True when `due_at` (ISO instant) falls within the local `date`. */
function isOnDay(dueAt: string | undefined, date: string): boolean {
  if (!dueAt) return false;
  const { from, to } = dayRangeUTC(date);
  return dueAt >= from && dueAt <= to;
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
      return top.filter((t) => ACTIVE.has(t.status) && isBeforeDay(t.due_at, date));
    case 'dueToday':
      return top.filter((t) => ACTIVE.has(t.status) && isOnDay(t.due_at, date));
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
