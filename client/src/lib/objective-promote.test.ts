import { describe, it, expect } from 'vitest';
import { isPromotableToObjective } from './objective-promote.js';
import type { Task } from './api.js';

// A minimal Task factory — only the fields the guard reads matter.
function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', owner_id: 'o', title: 'Write the spec', status: 'todo',
    priority: 3, created_at: '', source_kind: 'manual', tags: [],
    subtype: 'standard',
    ...over,
  };
}

describe('isPromotableToObjective', () => {
  it('allows a standard task', () => {
    expect(isPromotableToObjective(task())).toBe(true);
  });

  it('refuses a quick task (ensureTaskPromoted no-ops on subtype quick)', () => {
    expect(isPromotableToObjective(task({ subtype: 'quick' }))).toBe(false);
  });

  it('refuses a materialized recurrence instance', () => {
    expect(isPromotableToObjective(task({ recurrence_parent_id: 'r1' }))).toBe(false);
  });

  it('allows a habit — the server promotes it; hiding it is a per-surface call', () => {
    expect(isPromotableToObjective(task({ subtype: 'habit', is_habit: true }))).toBe(true);
  });

  it('allows a recurrence TEMPLATE (only instances carry recurrence_parent_id)', () => {
    expect(isPromotableToObjective(task({ recurrence_rule: 'FREQ=DAILY' }))).toBe(true);
  });

  it('allows a task whose subtype the payload omits', () => {
    expect(isPromotableToObjective(task({ subtype: undefined }))).toBe(true);
  });

  // dropSourceObjective hard-deletes a thrown-away task's pristine objective ("its work
  // is abandoned"), but the promote route does not re-check status — it answers 200 and
  // rebuilds it. Verified live. The Archive → "Thrown away" list renders full TaskCards,
  // so without this the owner can undo that GC in one click from the picker.
  it('refuses a thrown-away (cancelled) task — never resurrect GC-ed abandoned work', () => {
    expect(isPromotableToObjective(task({ status: 'cancelled' }))).toBe(false);
  });

  it('still allows a DONE task — an objective outlives its task being completed', () => {
    expect(isPromotableToObjective(task({ status: 'done' }))).toBe(true);
  });
});
