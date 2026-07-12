import { describe, expect, it } from 'vitest';
import { TASKS_TABS, parseTasksTab } from './tasks-tabs.js';

describe('TASKS_TABS', () => {
  it('renders in the AF-1 order: Tasks, Objectives, Habits, Routines, Timeblock', () => {
    expect(TASKS_TABS).toEqual(['tasks', 'objectives', 'habits', 'routines', 'timeblocks']);
  });
});

describe('parseTasksTab', () => {
  it('accepts every valid tab value round-trip', () => {
    for (const tab of TASKS_TABS) expect(parseTasksTab(tab)).toBe(tab);
  });

  it('falls back to tasks when the param is absent', () => {
    expect(parseTasksTab(undefined)).toBe('tasks');
  });

  it('falls back to tasks for unknown values', () => {
    expect(parseTasksTab('bogus')).toBe('tasks');
    expect(parseTasksTab('')).toBe('tasks');
    expect(parseTasksTab('TASKS')).toBe('tasks'); // case-sensitive
    expect(parseTasksTab('objectives ')).toBe('tasks');
  });

  it('falls back to tasks for non-string shapes (router can yield string[])', () => {
    expect(parseTasksTab(['objectives', 'habits'])).toBe('tasks');
    expect(parseTasksTab(null)).toBe('tasks');
    expect(parseTasksTab(42)).toBe('tasks');
    expect(parseTasksTab({})).toBe('tasks');
  });
});
