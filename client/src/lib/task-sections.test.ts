import { describe, expect, it } from 'vitest';
import type { Task } from './api.js';
import { headerOpenCount, isCreatedOnDay, isTopLevelTask, partitionTaskSections } from './task-sections.js';

// Minimal Task factory — only the fields the partition reads matter.
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    status: 'open',
    priority: 3,
    created_at: '2026-07-11T09:00:00.000Z',
    ...over,
  } as Task;
}

describe('isCreatedOnDay', () => {
  it('matches an instant that lands on the given local day', () => {
    // Fixed instant; compared against the LOCAL calendar day of that instant so the
    // assertion is stable regardless of the runner's TZ (reproduce flakes with TZ=UTC).
    const iso = '2026-07-11T15:00:00.000Z';
    const localDay = new Date(iso);
    const today = `${localDay.getFullYear()}-${String(localDay.getMonth() + 1).padStart(2, '0')}-${String(localDay.getDate()).padStart(2, '0')}`;
    expect(isCreatedOnDay(iso, today)).toBe(true);
  });

  it('does not match a different day', () => {
    expect(isCreatedOnDay('2026-07-10T12:00:00.000Z', '2026-07-11')).toBe(false);
    expect(isCreatedOnDay('2026-07-12T12:00:00.000Z', '2026-07-11')).toBe(false);
  });

  it('is false for empty / invalid input', () => {
    expect(isCreatedOnDay(undefined, '2026-07-11')).toBe(false);
    expect(isCreatedOnDay(null, '2026-07-11')).toBe(false);
    expect(isCreatedOnDay('', '2026-07-11')).toBe(false);
    expect(isCreatedOnDay('not-a-date', '2026-07-11')).toBe(false);
  });

  it('compares against the LOCAL day of the instant, regardless of runner TZ', () => {
    // Deterministic under any TZ (incl. TZ=UTC, our flake-repro zone): derive the local
    // day FROM the instant, then assert it matches — a near-midnight instant can never
    // drift into the wrong bucket because both sides use the same local conversion.
    for (const iso of ['2026-07-11T00:30:00.000Z', '2026-07-11T23:30:00.000Z', '2026-07-11T12:00:00.000Z']) {
      const d = new Date(iso);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      expect(isCreatedOnDay(iso, day)).toBe(true);
    }
  });
});

describe('isTopLevelTask', () => {
  it('excludes subtasks and recurrence instances', () => {
    expect(isTopLevelTask(task({ id: 'a' }))).toBe(true);
    expect(isTopLevelTask(task({ id: 'b', parent_id: 'a' }))).toBe(false);
    expect(isTopLevelTask(task({ id: 'c', recurrence_parent_id: 'r' }))).toBe(false);
  });
});

describe('partitionTaskSections', () => {
  const TODAY = '2026-07-11';
  const preds = {
    isRoutine: (t: Task) => t.id.startsWith('routine'),
    isScheduled: (t: Task) => t.status === 'scheduled' || t.id.startsWith('sched'),
    todayISO: TODAY,
  };

  it('routes a task created today into New Today (not Open/Scheduled)', () => {
    const t = task({ id: 'new1', created_at: '2026-07-11T08:00:00.000Z' });
    const s = partitionTaskSections([t], preds);
    expect(s.newToday.map((x) => x.id)).toEqual(['new1']);
    expect(s.open).toEqual([]);
    expect(s.scheduled).toEqual([]);
  });

  it('a task created before today falls into Open once the day rolls over — pure derivation', () => {
    // Same task, two different "today" values: created 2026-07-10 → New Today on the
    // 10th, plain Open on the 11th. No mutation, no job — just the boundary moving.
    const t = task({ id: 'roll', created_at: '2026-07-10T14:00:00.000Z' });
    expect(partitionTaskSections([t], { ...preds, todayISO: '2026-07-10' }).newToday.map((x) => x.id)).toEqual(['roll']);
    const after = partitionTaskSections([t], { ...preds, todayISO: '2026-07-11' });
    expect(after.newToday).toEqual([]);
    expect(after.open.map((x) => x.id)).toEqual(['roll']);
  });

  it('New Today wins over Scheduled for a task both created-today and scheduled', () => {
    const t = task({ id: 'both', status: 'scheduled', created_at: '2026-07-11T08:00:00.000Z' });
    const s = partitionTaskSections([t], preds);
    expect(s.newToday.map((x) => x.id)).toEqual(['both']);
    expect(s.scheduled).toEqual([]);
  });

  it('Routine wins over New Today (a routine task created today stays in Routine)', () => {
    const t = task({ id: 'routine-a', created_at: '2026-07-11T08:00:00.000Z' });
    const s = partitionTaskSections([t], preds);
    expect(s.routine.map((x) => x.id)).toEqual(['routine-a']);
    expect(s.newToday).toEqual([]);
  });

  it('partitions a mixed backlog with every task in exactly one section', () => {
    const list = [
      task({ id: 'new1', created_at: '2026-07-11T08:00:00.000Z' }),
      task({ id: 'open1', created_at: '2026-07-01T08:00:00.000Z' }),
      task({ id: 'sched1', status: 'scheduled', created_at: '2026-07-02T08:00:00.000Z' }),
      task({ id: 'routine1', created_at: '2026-07-03T08:00:00.000Z' }),
    ];
    const s = partitionTaskSections(list, preds);
    expect(s.newToday.map((x) => x.id)).toEqual(['new1']);
    expect(s.open.map((x) => x.id)).toEqual(['open1']);
    expect(s.scheduled.map((x) => x.id)).toEqual(['sched1']);
    expect(s.routine.map((x) => x.id)).toEqual(['routine1']);
    // Exclusivity: the four sections re-cover the input with no duplication.
    const total = s.newToday.length + s.open.length + s.scheduled.length + s.routine.length;
    expect(total).toBe(list.length);
    const ids = [...s.newToday, ...s.open, ...s.scheduled, ...s.routine].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops subtasks and recurrence instances from every section', () => {
    const list = [
      task({ id: 'sub', parent_id: 'p', created_at: '2026-07-11T08:00:00.000Z' }),
      task({ id: 'rec', recurrence_parent_id: 'r', created_at: '2026-07-11T08:00:00.000Z' }),
      task({ id: 'top', created_at: '2026-07-11T08:00:00.000Z' }),
    ];
    const s = partitionTaskSections(list, preds);
    expect(s.newToday.map((x) => x.id)).toEqual(['top']);
    expect([...s.open, ...s.scheduled, ...s.routine]).toEqual([]);
  });

  it('preserves incoming order within a section', () => {
    const list = [
      task({ id: 'open-a', created_at: '2026-07-01T08:00:00.000Z' }),
      task({ id: 'open-b', created_at: '2026-07-02T08:00:00.000Z' }),
      task({ id: 'open-c', created_at: '2026-07-03T08:00:00.000Z' }),
    ];
    const s = partitionTaskSections(list, preds);
    expect(s.open.map((x) => x.id)).toEqual(['open-a', 'open-b', 'open-c']);
  });
});

describe('headerOpenCount', () => {
  const TODAY = '2026-07-11';
  const preds = {
    isRoutine: (t: Task) => t.id.startsWith('routine'),
    isScheduled: (t: Task) => t.status === 'scheduled' || t.status === 'in_progress' || t.id.startsWith('sched'),
    todayISO: TODAY,
  };
  // Mirrors production: partition once, count from the shared result.
  const count = (list: Task[], p = preds) => headerOpenCount(partitionTaskSections(list, p), p.isScheduled);

  it('counts a created-today open task immediately (New Today section)', () => {
    const t = task({ id: 'new1', created_at: '2026-07-11T08:00:00.000Z' });
    expect(count([t])).toBe(1);
  });

  it('sums Open + New Today without double-counting', () => {
    const list = [
      task({ id: 'new1', created_at: '2026-07-11T08:00:00.000Z' }),
      task({ id: 'old-open', created_at: '2026-07-01T08:00:00.000Z' }),
    ];
    expect(count(list)).toBe(2);
  });

  it('excludes scheduled tasks — even one sitting in New Today because it was created today', () => {
    const list = [
      task({ id: 'sched-new', status: 'scheduled', created_at: '2026-07-11T08:00:00.000Z' }), // → New Today section
      task({ id: 'sched-old', status: 'scheduled', created_at: '2026-07-01T08:00:00.000Z' }), // → Scheduled section
      task({ id: 'plain-new', created_at: '2026-07-11T08:00:00.000Z' }),
    ];
    // plain-new is open-status and created today → counts; both scheduled tasks don't.
    expect(count(list)).toBe(1);
  });

  it('excludes a done-today task (rendered checked in the list, but not open)', () => {
    const t = task({ id: 'done1', status: 'done', completed_at: '2026-07-11T10:00:00.000Z', created_at: '2026-07-11T08:00:00.000Z' });
    expect(count([t])).toBe(0);
  });

  it('excludes routine tasks and non-top-level rows', () => {
    const list = [
      task({ id: 'routine1', created_at: '2026-07-11T08:00:00.000Z' }),
      task({ id: 'sub', parent_id: 'p', created_at: '2026-07-11T08:00:00.000Z' }),
    ];
    expect(count(list)).toBe(0);
  });

  it('day rollover leaves the total unchanged when nothing else changes', () => {
    // Created on the 10th: New Today on the 10th, Open on the 11th — same count both
    // days. This is also the pure half of the midnight day-tick: the component bumps
    // todayISO at local midnight and the partition simply responds to the new value.
    const list = [
      task({ id: 'roll', created_at: '2026-07-10T14:00:00.000Z' }),
      task({ id: 'old-open', created_at: '2026-07-01T08:00:00.000Z' }),
    ];
    const onCreationDay = count(list, { ...preds, todayISO: '2026-07-10' });
    const nextDay = count(list, { ...preds, todayISO: '2026-07-11' });
    expect(onCreationDay).toBe(2);
    expect(nextDay).toBe(2);
  });
});
