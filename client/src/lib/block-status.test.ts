import { describe, it, expect } from 'vitest';
import { SETTLED_BLOCK, isSettled, isCompleted } from './block-status.js';

/**
 * This module exists to stop the settled-status list being re-typed per component. The
 * Planner already carried a literal copy with a comment saying the views must agree with
 * the server's TERMINAL_BLOCK_STATUSES; a third copy in the drawer is what these tests
 * are here to make unnecessary.
 */

describe('isSettled — terminal history vs live work', () => {
  it('covers every terminal status the server settles a block into', () => {
    for (const s of ['completed', 'skipped', 'cancelled', 'missed']) {
      expect(isSettled(s), s).toBe(true);
    }
  });

  it('leaves live statuses alone', () => {
    for (const s of ['planned', 'overrun', 'in_progress']) {
      expect(isSettled(s), s).toBe(false);
    }
  });

  it('mirrors the server list exactly — no more, no less', () => {
    // Pinned as a set so a status added on one side and not the other trips here rather
    // than silently making the client disagree about what is still on the board.
    expect([...SETTLED_BLOCK].sort()).toEqual(['cancelled', 'completed', 'missed', 'skipped']);
  });
});

describe('isCompleted — finished on purpose', () => {
  it('is narrower than settled: cancelled and missed never read as done', () => {
    expect(isCompleted('completed')).toBe(true);
    expect(isCompleted('skipped')).toBe(true);
    // Both are settled, but neither was finished — conflating them is what would make an
    // abandoned task show up as a completed one.
    expect(isCompleted('cancelled')).toBe(false);
    expect(isCompleted('missed')).toBe(false);
    expect(isSettled('cancelled') && isSettled('missed')).toBe(true);
  });

  it('is false for live work', () => {
    expect(isCompleted('planned')).toBe(false);
    expect(isCompleted('in_progress')).toBe(false);
  });
});
