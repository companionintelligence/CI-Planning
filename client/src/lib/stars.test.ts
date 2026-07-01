import { describe, it, expect } from 'vitest';
import { starSlots, isPerfectDay, pipCount, STAR_ORDER, STAR_GOLD, STAR_MUTED } from './stars.js';
import type { DayStars } from './api.js';

function stars(over: Partial<DayStars>): DayStars {
  const base = { objective: false, habits: false, tasks: false, bonus: false, note: false };
  const merged = { ...base, ...over };
  const total = STAR_ORDER.reduce((n, k) => n + (merged[k] ? 1 : 0), 0);
  return { ...merged, total };
}

describe('starSlots', () => {
  it('returns five slots in fixed order', () => {
    expect(starSlots(stars({})).map((s) => s.key)).toEqual(['objective', 'habits', 'tasks', 'bonus', 'note']);
  });

  it('renders n gold (earned) + (5-n) muted (empty)', () => {
    const slots = starSlots(stars({ objective: true, tasks: true })); // 2 earned
    const gold = slots.filter((s) => s.earned);
    const muted = slots.filter((s) => !s.earned);
    expect(gold.length).toBe(2);
    expect(muted.length).toBe(3);
    expect(gold.every((s) => s.color === STAR_GOLD)).toBe(true);
    expect(muted.every((s) => s.color === STAR_MUTED)).toBe(true);
  });

  it('every slot carries a whats-needed hint', () => {
    expect(starSlots(stars({})).every((s) => s.hint.length > 0)).toBe(true);
  });
});

describe('isPerfectDay', () => {
  it('is true only at 5/5', () => {
    expect(isPerfectDay(5)).toBe(true);
    expect(isPerfectDay(4)).toBe(false);
    expect(isPerfectDay(0)).toBe(false);
  });
});

describe('pipCount', () => {
  it('equals the star total for a non-perfect day', () => {
    expect(pipCount(0)).toBe(0);
    expect(pipCount(3)).toBe(3);
    expect(pipCount(4)).toBe(4);
  });

  it('returns 0 pips for a perfect day (uses the single-star treatment instead)', () => {
    expect(pipCount(5)).toBe(0);
  });
});
