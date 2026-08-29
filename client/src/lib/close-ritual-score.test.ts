import { describe, it, expect } from 'vitest';
import { scoreOf, toggleFace, FACE_KEYS } from './close-ritual-score.js';

/**
 * The three-face → 1-5 encoding (0161). One pick is an odd number; an adjacent pair fills
 * the even gap between. The opposite pair must be UNREACHABLE, not merely mapped: scoring
 * "it was both terrible and great" as a 3 would make a conflicted answer indistinguishable
 * from an indifferent one.
 */
describe('scoreOf', () => {
  it('maps single picks to the odd points', () => {
    expect(scoreOf(['frown'])).toBe(1);
    expect(scoreOf(['flat'])).toBe(3);
    expect(scoreOf(['smile'])).toBe(5);
  });

  it('maps adjacent pairs to the even points between them', () => {
    expect(scoreOf(['frown', 'flat'])).toBe(2);
    expect(scoreOf(['flat', 'smile'])).toBe(4);
  });

  it('refuses the opposite pair rather than scoring it', () => {
    expect(scoreOf(['frown', 'smile'])).toBeNull();
  });

  it('has no score for an empty selection', () => {
    expect(scoreOf([])).toBeNull();
  });

  it('covers 1-5 with no gaps and no duplicates', () => {
    const reachable = [['frown'], ['frown', 'flat'], ['flat'], ['flat', 'smile'], ['smile']] as const;
    expect(reachable.map((p) => scoreOf([...p]))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('toggleFace', () => {
  it('adds a face and keeps scale order', () => {
    expect(toggleFace(['smile'], 'flat')).toEqual(['flat', 'smile']);
  });

  it('toggles a picked face back off — a mis-tap is undoable in place', () => {
    expect(toggleFace(['flat', 'smile'], 'smile')).toEqual(['flat']);
  });

  // The invariant that makes the opposite pair unreachable: tapping the far end REPLACES
  // rather than refusing, so there is never an invalid state to explain to the user.
  it('replaces the selection when the tapped face opposes it', () => {
    expect(toggleFace(['frown'], 'smile')).toEqual(['smile']);
    expect(toggleFace(['frown', 'flat'], 'smile')).toEqual(['smile']);
  });

  it('replaces once a pair is already full', () => {
    expect(toggleFace(['flat', 'smile'], 'frown')).toEqual(['frown']);
  });

  it('can never produce a selection scoreOf rejects', () => {
    // Every state reachable in three taps from empty — exhaustive at this size.
    for (const a of FACE_KEYS) for (const b of FACE_KEYS) for (const c of FACE_KEYS) {
      const picked = toggleFace(toggleFace(toggleFace([], a), b), c);
      if (picked.length > 0) expect(scoreOf(picked)).not.toBeNull();
    }
  });
});
