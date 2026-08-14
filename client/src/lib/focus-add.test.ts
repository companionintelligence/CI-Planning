import { describe, it, expect } from 'vitest';
import { addCandidates, moveHighlight, describeAddOutcome, MATCH_CAP } from './focus-add.js';

/**
 * Phase 3 — the add box's matching, its keyboard cursor, and how a full Time Block
 * is reported.
 */

const task = (id: string, title: string, over: Record<string, unknown> = {}) =>
  ({ id, title, status: 'open', ...over }) as any;

describe('addCandidates', () => {
  const backlog = [task('1', 'Draft the spec'), task('2', 'Review notes'), task('3', 'Draft the email')];

  it('matches on a case-insensitive substring', () => {
    expect(addCandidates(backlog, 'draft', new Set()).map((t) => t.id)).toEqual(['1', '3']);
    expect(addCandidates(backlog, 'DRAFT THE', new Set()).map((t) => t.id)).toEqual(['1', '3']);
  });

  it('yields nothing for an empty query — the dropdown only exists once you type', () => {
    expect(addCandidates(backlog, '', new Set())).toEqual([]);
    expect(addCandidates(backlog, '   ', new Set())).toEqual([]);
  });

  it('excludes tasks already in this block, so it never offers a duplicate', () => {
    expect(addCandidates(backlog, 'draft', new Set(['1'])).map((t) => t.id)).toEqual(['3']);
  });

  it('excludes recurrence instances — generated occurrences are not backlog items', () => {
    const withInstance = [...backlog, task('4', 'Draft weekly', { recurrence_parent_id: 'r1' })];
    expect(addCandidates(withInstance, 'draft', new Set()).map((t) => t.id)).toEqual(['1', '3']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => task(String(i), `Draft ${i}`));
    expect(addCandidates(many, 'draft', new Set())).toHaveLength(MATCH_CAP);
  });
});

describe('moveHighlight', () => {
  it('moves and wraps at both ends', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });

  it('stays at 0 with no matches, so Enter unambiguously means "create"', () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
    expect(moveHighlight(5, -1, 0)).toBe(0);
  });
});

describe('describeAddOutcome', () => {
  it('reports a placement', () => {
    expect(describeAddOutcome('Spec', { placed: 1, unplaced: 0, skipped: 0 }))
      .toEqual({ message: 'Added "Spec"', kind: 'success' });
  });

  it('a FULL block is reported, not routed around — decision 7 forbids auto-extending', () => {
    const out = describeAddOutcome('Spec', { placed: 0, unplaced: 1, skipped: 0 });
    expect(out.message).toMatch(/no room/i);
    expect(out.kind).toBe('default'); // an outcome, not an error
  });

  it('a duplicate says so rather than claiming success', () => {
    expect(describeAddOutcome('Spec', { placed: 0, unplaced: 0, skipped: 1 }).message)
      .toMatch(/already in this Time Block/i);
  });

  it('an all-zero result is a real failure', () => {
    expect(describeAddOutcome('Spec', { placed: 0, unplaced: 0, skipped: 0 }).kind).toBe('error');
  });
});
