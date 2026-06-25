import { describe, it, expect } from 'vitest';
import { byPriority, byDueDateAsc, byDirection, type Sortable } from './sort.js';

describe('byPriority', () => {
  it('orders P1 before P3 (ascending, 1 = highest)', () => {
    const list: Sortable[] = [{ priority: 3 }, { priority: 1 }, { priority: 2 }];
    expect([...list].sort(byPriority).map((t) => t.priority)).toEqual([1, 2, 3]);
  });

  it('sorts a missing priority last', () => {
    const list: Sortable[] = [{ priority: null }, { priority: 2 }];
    expect([...list].sort(byPriority).map((t) => t.priority)).toEqual([2, null]);
  });
});

describe('byDueDateAsc', () => {
  it('orders nearest due date first', () => {
    const list: Sortable[] = [
      { due_at: '2026-07-10T00:00:00Z' },
      { due_at: '2026-07-01T00:00:00Z' },
    ];
    expect([...list].sort(byDueDateAsc).map((t) => t.due_at)).toEqual([
      '2026-07-01T00:00:00Z',
      '2026-07-10T00:00:00Z',
    ]);
  });

  it('sorts undated items last and keeps both-missing stable (returns 0)', () => {
    const a: Sortable = { due_at: null };
    const b: Sortable = { due_at: undefined };
    expect(byDueDateAsc(a, b)).toBe(0);
    const list: Sortable[] = [{ due_at: null }, { due_at: '2026-07-01T00:00:00Z' }];
    expect([...list].sort(byDueDateAsc).map((t) => t.due_at)).toEqual([
      '2026-07-01T00:00:00Z',
      null,
    ]);
  });
});

describe('byDirection', () => {
  const nameOf = (t: { dir?: string }) => t.dir;
  it('groups alphabetically by direction name', () => {
    const list = [{ dir: 'Work' }, { dir: 'Home' }, { dir: 'Community' }];
    expect([...list].sort(byDirection(nameOf)).map((t) => t.dir)).toEqual([
      'Community',
      'Home',
      'Work',
    ]);
  });

  it('sorts undirected items last', () => {
    const list = [{ dir: undefined }, { dir: 'Home' }];
    expect([...list].sort(byDirection(nameOf)).map((t) => t.dir)).toEqual(['Home', undefined]);
  });
});
