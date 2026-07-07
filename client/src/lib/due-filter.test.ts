import { describe, it, expect } from 'vitest';
import { passesDueFilter, dueFilterActive, type DueFilterState } from './due-filter.js';
import type { Task } from './api.js';

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

const base: DueFilterState = { directions: [], hideHabits: true, hideRoutines: true };

describe('passesDueFilter', () => {
  it('hides habits when hideHabits is set (the default)', () => {
    expect(passesDueFilter(task({ id: 'a', is_habit: true }), false, base)).toBe(false);
    expect(passesDueFilter(task({ id: 'b', is_habit: false }), false, base)).toBe(true);
  });

  it('shows habits once hideHabits is turned off', () => {
    const f = { ...base, hideHabits: false };
    expect(passesDueFilter(task({ id: 'a', is_habit: true }), false, f)).toBe(true);
  });

  it('hides routine-member tasks when hideRoutines is set (the default)', () => {
    expect(passesDueFilter(task({ id: 'a' }), true, base)).toBe(false);
    expect(passesDueFilter(task({ id: 'b' }), false, base)).toBe(true);
  });

  it('shows routine tasks once hideRoutines is turned off', () => {
    const f = { ...base, hideRoutines: false };
    expect(passesDueFilter(task({ id: 'a' }), true, f)).toBe(true);
  });

  it('empty direction set does not narrow by direction', () => {
    const f = { ...base, hideHabits: false, hideRoutines: false };
    expect(passesDueFilter(task({ id: 'a', tags: ['work'] }), false, f)).toBe(true);
    expect(passesDueFilter(task({ id: 'b', tags: [] }), false, f)).toBe(true);
  });

  it('direction include-set keeps only tasks carrying a selected direction (OR)', () => {
    const f = { directions: ['work', 'home'], hideHabits: false, hideRoutines: false };
    expect(passesDueFilter(task({ id: 'a', tags: ['work'] }), false, f)).toBe(true);
    expect(passesDueFilter(task({ id: 'b', tags: ['home', 'x'] }), false, f)).toBe(true);
    expect(passesDueFilter(task({ id: 'c', tags: ['community'] }), false, f)).toBe(false);
    expect(passesDueFilter(task({ id: 'd', tags: [] }), false, f)).toBe(false); // untagged excluded when narrowing
  });

  it('AND-combines direction with the hide toggles', () => {
    const f = { directions: ['work'], hideHabits: true, hideRoutines: true };
    // Right direction but a habit → still hidden.
    expect(passesDueFilter(task({ id: 'a', tags: ['work'], is_habit: true }), false, f)).toBe(false);
    expect(passesDueFilter(task({ id: 'b', tags: ['work'] }), false, f)).toBe(true);
  });
});

describe('dueFilterActive', () => {
  it('is false for the plain defaults', () => {
    expect(dueFilterActive(base)).toBe(false);
  });
  it('is true when a direction is selected or a hide toggle is off', () => {
    expect(dueFilterActive({ ...base, directions: ['work'] })).toBe(true);
    expect(dueFilterActive({ ...base, hideHabits: false })).toBe(true);
    expect(dueFilterActive({ ...base, hideRoutines: false })).toBe(true);
  });
});
