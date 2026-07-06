import { describe, it, expect } from 'vitest';
import { tasksInBucket, bucketCounts, pageWindow, dueItems, type BucketDeps } from './task-buckets.js';
import { dayRangeUTC } from './dates.js';
import type { Task } from './api.js';

// A minimal Task fixture — only the fields the buckets read matter.
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    priority: 3,
    status: 'open',
    owner_id: 'o1',
    source_kind: 'manual',
    created_at: '2026-07-01T00:00:00Z',
    tags: [],
    ...over,
  } as Task;
}

const DAY = '2026-07-01';
// due_at instants relative to the local day's bounds (host TZ = America/Los_Angeles).
const { from: dayStart, to: dayEnd } = dayRangeUTC(DAY);
const beforeDay = new Date(new Date(dayStart).getTime() - 60_000).toISOString();
const midDay = new Date(new Date(dayStart).getTime() + 12 * 3600_000).toISOString();
const afterDay = new Date(new Date(dayEnd).getTime() + 60_000).toISOString();

const noDeps: BucketDeps = { scheduledIds: new Set(), isRoutine: () => false };

describe('tasksInBucket', () => {
  it('overdue = active status with due_at before the local day', () => {
    const tasks = [
      task({ id: 'a', status: 'open', due_at: beforeDay }),
      task({ id: 'b', status: 'scheduled', due_at: beforeDay }),
      task({ id: 'c', status: 'done', due_at: beforeDay }),      // done → excluded
      task({ id: 'd', status: 'open', due_at: midDay }),          // today → excluded
    ];
    expect(tasksInBucket('overdue', tasks, DAY, noDeps).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('dueToday = active status with due_at within the local day', () => {
    const tasks = [
      task({ id: 'a', due_at: midDay }),
      task({ id: 'b', due_at: beforeDay }),   // overdue, not due today
      task({ id: 'c', due_at: afterDay }),    // tomorrow
      task({ id: 'd', status: 'done', due_at: midDay }), // done → excluded
    ];
    expect(tasksInBucket('dueToday', tasks, DAY, noDeps).map((t) => t.id)).toEqual(['a']);
  });

  it('scheduled = placed on the planner OR status scheduled/in_progress, minus routines', () => {
    const deps: BucketDeps = { scheduledIds: new Set(['placed']), isRoutine: (id) => id === 'routine' };
    const tasks = [
      task({ id: 'placed', status: 'open' }),        // placed on planner
      task({ id: 'sched', status: 'scheduled' }),    // status
      task({ id: 'prog', status: 'in_progress' }),
      task({ id: 'routine', status: 'scheduled' }),  // routine → excluded
      task({ id: 'open', status: 'open' }),          // plain backlog → not scheduled
    ];
    expect(tasksInBucket('scheduled', tasks, DAY, deps).map((t) => t.id)).toEqual(['placed', 'sched', 'prog']);
  });

  it('open = plain backlog (status open, not routine, not placed)', () => {
    const deps: BucketDeps = { scheduledIds: new Set(['placed']), isRoutine: (id) => id === 'routine' };
    const tasks = [
      task({ id: 'a', status: 'open' }),
      task({ id: 'placed', status: 'open' }),   // placed → scheduled instead
      task({ id: 'routine', status: 'open' }),  // routine → excluded
      task({ id: 'sched', status: 'scheduled' }),
    ];
    expect(tasksInBucket('open', tasks, DAY, deps).map((t) => t.id)).toEqual(['a']);
  });

  it('excludes subtasks (parent_id set) from every bucket', () => {
    const tasks = [
      task({ id: 'sub', status: 'open', due_at: beforeDay, parent_id: 'p' }),
      task({ id: 'top', status: 'open', due_at: beforeDay }),
    ];
    expect(tasksInBucket('overdue', tasks, DAY, noDeps).map((t) => t.id)).toEqual(['top']);
  });
});

describe('bucketCounts', () => {
  it('returns the four buckets in display order with counts', () => {
    const tasks = [
      task({ id: 'o', status: 'open', due_at: beforeDay }),  // overdue
      task({ id: 't', status: 'open', due_at: midDay }),     // due today
      task({ id: 'b', status: 'open' }),                     // open
    ];
    const counts = bucketCounts(tasks, DAY, noDeps);
    expect(counts.map((c) => c.key)).toEqual(['overdue', 'dueToday', 'scheduled', 'open']);
    expect(counts.find((c) => c.key === 'overdue')!.count).toBe(1);
    expect(counts.find((c) => c.key === 'dueToday')!.count).toBe(1);
    // The overdue + due-today tasks are also 'open' status → they count in open too.
    expect(counts.find((c) => c.key === 'open')!.count).toBe(3);
  });
});

describe('dueItems (Phase AB · AB4 — the always-visible Due card)', () => {
  it('splits the selected day\'s due tasks from the overdue rollup, active only', () => {
    const tasks = [
      task({ id: 'today', status: 'open', due_at: midDay }),
      task({ id: 'debt', status: 'scheduled', due_at: beforeDay }),
      task({ id: 'done', status: 'done', due_at: midDay }),        // done → excluded
      task({ id: 'future', status: 'open', due_at: afterDay }),    // tomorrow → neither
      task({ id: 'undated', status: 'open' }),                     // no due_at → neither
    ];
    const d = dueItems(tasks, DAY);
    expect(d.dueToday.map((t) => t.id)).toEqual(['today']);
    expect(d.overdue.map((t) => t.id)).toEqual(['debt']);
  });

  it('sorts both groups by due_at ascending (oldest debt / earliest deadline first)', () => {
    const earlier = new Date(new Date(dayStart).getTime() + 9 * 3600_000).toISOString();
    const older = new Date(new Date(dayStart).getTime() - 48 * 3600_000).toISOString();
    const tasks = [
      task({ id: 'noon', due_at: midDay }),
      task({ id: 'nine', due_at: earlier }),
      task({ id: 'yesterday', due_at: beforeDay }),
      task({ id: 'lastWeek', due_at: older }),
    ];
    const d = dueItems(tasks, DAY);
    expect(d.dueToday.map((t) => t.id)).toEqual(['nine', 'noon']);
    expect(d.overdue.map((t) => t.id)).toEqual(['lastWeek', 'yesterday']);
  });

  it('is relative to the SELECTED day (navigating dates moves the boundary)', () => {
    // Viewed from the NEXT day, a task due midDay of DAY rolls into overdue.
    const tasks = [task({ id: 'a', due_at: midDay })];
    const d = dueItems(tasks, '2026-07-02');
    expect(d.dueToday).toEqual([]);
    expect(d.overdue.map((t) => t.id)).toEqual(['a']);
  });

  it('excludes subtasks, matching the buckets', () => {
    const tasks = [
      task({ id: 'sub', due_at: midDay, parent_id: 'p' }),
      task({ id: 'top', due_at: midDay }),
    ];
    expect(dueItems(tasks, DAY).dueToday.map((t) => t.id)).toEqual(['top']);
  });
});

describe('pageWindow', () => {
  const items = [0, 1, 2, 3, 4, 5];

  it('shows `size` rows from offset and reports remaining', () => {
    const w = pageWindow(items, 0, 3);
    expect(w.visible).toEqual([0, 1, 2]);
    expect(w.remaining).toBe(3);
    expect(w.canUp).toBe(false);   // at top
    expect(w.canDown).toBe(true);
  });

  it('advances one item at a time', () => {
    const w = pageWindow(items, 1, 3);
    expect(w.visible).toEqual([1, 2, 3]);
    expect(w.remaining).toBe(2);
    expect(w.canUp).toBe(true);
    expect(w.canDown).toBe(true);
  });

  it('clamps the offset at the end (down disabled)', () => {
    const w = pageWindow(items, 99, 3);
    expect(w.offset).toBe(3);          // clamped to length - size
    expect(w.visible).toEqual([3, 4, 5]);
    expect(w.remaining).toBe(0);
    expect(w.canDown).toBe(false);
    expect(w.canUp).toBe(true);
  });

  it('handles a list shorter than the window', () => {
    const w = pageWindow([0, 1], 0, 3);
    expect(w.visible).toEqual([0, 1]);
    expect(w.remaining).toBe(0);
    expect(w.canUp).toBe(false);
    expect(w.canDown).toBe(false);
  });
});
