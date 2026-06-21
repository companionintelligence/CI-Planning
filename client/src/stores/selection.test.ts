import { describe, it, expect, beforeEach } from 'vitest';
import { isSelected, toggleSelection, clearSelection, selection } from './selection.js';

describe('selection store (Phase F)', () => {
  beforeEach(() => clearSelection());

  it('toggle: add → remove → empty', () => {
    expect(selection().size).toBe(0);
    toggleSelection({ kind: 'block', id: 42 });
    expect(isSelected({ kind: 'block', id: 42 })).toBe(true);
    expect(selection().size).toBe(1);
    toggleSelection({ kind: 'block', id: 42 });
    expect(isSelected({ kind: 'block', id: 42 })).toBe(false);
    expect(selection().size).toBe(0);
  });

  it('same id under different kinds are independent (block vs flight-plan-task)', () => {
    toggleSelection({ kind: 'block', id: 1 });
    toggleSelection({ kind: 'flight-plan-task', id: 1 });
    expect(selection().size).toBe(2);
    toggleSelection({ kind: 'block', id: 1 });
    expect(isSelected({ kind: 'block', id: 1 })).toBe(false);
    expect(isSelected({ kind: 'flight-plan-task', id: 1 })).toBe(true);
  });

  it('clearSelection empties the map and is a no-op when already empty', () => {
    toggleSelection({ kind: 'block', id: 7 });
    clearSelection();
    expect(selection().size).toBe(0);
    clearSelection(); // no-op
    expect(selection().size).toBe(0);
  });
});
