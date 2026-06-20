import { describe, it, expect } from 'vitest';
import { pickNextUp, nextUpScrollTopPx, scrollTopForBlock, SLOT_MIN } from './planner.js';
import { PX_PER_MIN, instantFor, minutesIntoDay } from './grid.js';

const day = '2026-06-15';
const at = (mins: number) => instantFor(day, mins);
const blk = (startMin: number, endMin: number, status = 'planned') => ({
  start_at: at(startMin), end_at: at(endMin), status,
});

describe('pickNextUp', () => {
  it('returns the earliest block whose end is still in the future', () => {
    const now = at(10 * 60); // 10:00 local
    const items = [blk(11 * 60, 12 * 60), blk(9 * 60, 9 * 60 + 30), blk(10 * 60 + 15, 11 * 60)];
    // 09:00–09:30 is fully past; next up is the 10:15 block, not the 11:00 one.
    expect(pickNextUp(items, now)?.start_at).toBe(at(10 * 60 + 15));
  });

  it('treats a block ending exactly now as past', () => {
    const now = at(10 * 60);
    const items = [blk(9 * 60, 10 * 60), blk(14 * 60, 15 * 60)];
    expect(pickNextUp(items, now)?.start_at).toBe(at(14 * 60));
  });

  it('skips completed / skipped / cancelled blocks', () => {
    const now = at(8 * 60);
    const items = [blk(9 * 60, 10 * 60, 'completed'), blk(9 * 60, 10 * 60, 'skipped'), blk(11 * 60, 12 * 60)];
    expect(pickNextUp(items, now)?.start_at).toBe(at(11 * 60));
  });

  it('returns undefined when the day is empty or fully behind', () => {
    const now = at(20 * 60);
    expect(pickNextUp([], now)).toBeUndefined();
    expect(pickNextUp([blk(9 * 60, 10 * 60)], now)).toBeUndefined();
  });
});

describe('nextUpScrollTopPx — pin to the second slot', () => {
  it('keeps SLOT_MIN of context above the next-up item', () => {
    // 10:00 start → scroll so 09:00 is at the top (one slot of context above).
    expect(nextUpScrollTopPx(10 * 60)).toBeCloseTo((10 * 60 - SLOT_MIN) * PX_PER_MIN, 9);
  });

  it('clamps at the top of the day (never negative)', () => {
    expect(nextUpScrollTopPx(30)).toBe(0);   // 00:30 — less than a slot from midnight
    expect(nextUpScrollTopPx(0)).toBe(0);
  });

  it('scrollTopForBlock is computed in the column local day and undefined-safe', () => {
    const b = blk(13 * 60, 14 * 60);
    expect(scrollTopForBlock(b, day)).toBeCloseTo((minutesIntoDay(b.start_at, day) - SLOT_MIN) * PX_PER_MIN, 9);
    expect(scrollTopForBlock(undefined, day)).toBe(0);
  });
});
