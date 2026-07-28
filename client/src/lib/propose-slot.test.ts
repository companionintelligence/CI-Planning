import { describe, it, expect } from 'vitest';
import { proposeSlot, narrowToBand } from './propose-slot.js';

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

/**
 * D3 — the enrichment's best-time band narrows the search window. The band is a
 * PREFERENCE: it must never turn a proposal the user would have received into "No time".
 */
const WINDOW = { startMin: 9 * 60, endMin: 18 * 60 };

describe('narrowToBand', () => {
  it('clips the window to the band where they overlap', () => {
    expect(narrowToBand(WINDOW, 'morning', 30)).toEqual({ startMin: 9 * 60, endMin: 12 * 60 });
    expect(narrowToBand(WINDOW, 'afternoon', 30)).toEqual({ startMin: 12 * 60, endMin: 17 * 60 });
  });

  it('returns the window untouched when there is no band', () => {
    expect(narrowToBand(WINDOW, undefined, 30)).toEqual(WINDOW);
  });

  it('falls back to the full window when the band cannot fit the duration', () => {
    // evening ∩ workday = 17:00-18:00; a 120m task does not fit, so do not narrow.
    expect(narrowToBand(WINDOW, 'evening', 120)).toEqual(WINDOW);
  });

  it('keeps the band when the duration exactly fits', () => {
    expect(narrowToBand(WINDOW, 'evening', 60)).toEqual({ startMin: 17 * 60, endMin: 18 * 60 });
  });

  it('falls back when band and window do not overlap at all', () => {
    const nightShift = { startMin: 22 * 60, endMin: 23 * 60 };
    expect(narrowToBand(nightShift, 'morning', 30)).toEqual(nightShift);
  });

  it('composes with proposeSlot: an afternoon hint moves the proposal past noon', () => {
    const b = narrowToBand(WINDOW, 'afternoon', 30);
    expect(proposeSlot({ busy: [], durationMin: 30, workStartMin: b.startMin, workEndMin: b.endMin })).toBe('12:00');
    // ...where the unhinted window would have proposed the top of the workday.
    expect(proposeSlot({ busy: [], durationMin: 30, ...WORK })).toBe('09:00');
  });

  it('composes with proposeSlot: a band still flows around busy spans', () => {
    const b = narrowToBand(WINDOW, 'afternoon', 30);
    const busy = [{ startMin: 12 * 60, endMin: 13 * 60 }];
    expect(proposeSlot({ busy, durationMin: 30, workStartMin: b.startMin, workEndMin: b.endMin })).toBe('13:00');
  });
});
