import { describe, it, expect } from 'vitest';
import { proposeSlot } from './propose-slot.js';

/**
 * The wizard NL line's preview-only slot proposal: first open workday gap that
 * fits the duration, flowing around busy spans; today never proposes the past
 * (next quarter-hour); null when the window can't fit it.
 */
const WORK = { workStartMin: 9 * 60, workEndMin: 18 * 60 };

describe('proposeSlot', () => {
  it('proposes workday start on an empty day', () => {
    expect(proposeSlot({ busy: [], durationMin: 30, ...WORK })).toBe('09:00');
  });

  it('flows past busy spans to the first gap that fits', () => {
    const busy = [
      { startMin: 9 * 60, endMin: 10 * 60 },       // 9-10
      { startMin: 10 * 60 + 15, endMin: 11 * 60 }, // 10:15-11 (the 15m gap at 10:00 doesn't fit 30m)
    ];
    expect(proposeSlot({ busy, durationMin: 30, ...WORK })).toBe('11:00');
  });

  it('uses a gap between spans when it fits', () => {
    const busy = [
      { startMin: 9 * 60, endMin: 10 * 60 },
      { startMin: 11 * 60, endMin: 12 * 60 },
    ];
    expect(proposeSlot({ busy, durationMin: 45, ...WORK })).toBe('10:00');
  });

  it('on today, never proposes the past — rounds now up to the next quarter-hour', () => {
    expect(proposeSlot({ busy: [], durationMin: 30, ...WORK, nowMin: 13 * 60 + 7 })).toBe('13:15');
  });

  it('handles unsorted + overlapping busy input', () => {
    const busy = [
      { startMin: 11 * 60, endMin: 12 * 60 },
      { startMin: 9 * 60, endMin: 11 * 60 + 30 }, // overlaps the first
    ];
    expect(proposeSlot({ busy, durationMin: 30, ...WORK })).toBe('12:00');
  });

  it('returns null when the workday cannot fit the duration', () => {
    const busy = [{ startMin: 9 * 60, endMin: 17 * 60 + 45 }];
    expect(proposeSlot({ busy, durationMin: 30, ...WORK })).toBeNull();
  });
});
