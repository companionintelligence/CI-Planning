import { describe, expect, it } from 'vitest';
import {
  formatClock, formatDuration, mergeRanges, minutesOfDay, openTime,
  parseHHMM, subtractBusy, totalOpen, MIN_OPEN_MINUTES,
} from './open-time.js';

const at = (h: number, m = 0) => h * 60 + m;
/** Just the shape assertions care about, so failures read as times not objects. */
const shape = (segs: ReturnType<typeof openTime>) =>
  segs.map((s) => `${s.direction} ${formatClock(s.start)}-${formatClock(s.end)}`);

describe('parseHHMM', () => {
  it('parses a window bound', () => {
    expect(parseHHMM('09:00')).toBe(540);
    expect(parseHHMM('9:05')).toBe(545);
    expect(parseHHMM('23:59')).toBe(1439);
  });

  it('returns null rather than NaN for junk', () => {
    // A malformed window must not silently become minute NaN and poison the maths.
    for (const bad of ['', 'noon', '25:00', '09:60', '0900', '09:0']) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });
});

describe('mergeRanges', () => {
  it('merges overlapping and touching ranges', () => {
    expect(mergeRanges([{ start: 60, end: 120 }, { start: 90, end: 180 }]))
      .toEqual([{ start: 60, end: 180 }]);
    expect(mergeRanges([{ start: 60, end: 120 }, { start: 120, end: 180 }]))
      .toEqual([{ start: 60, end: 180 }]);
  });

  it('drops zero and negative-length ranges', () => {
    expect(mergeRanges([{ start: 60, end: 60 }, { start: 120, end: 90 }])).toEqual([]);
  });

  it('sorts before merging, so input order does not matter', () => {
    expect(mergeRanges([{ start: 300, end: 360 }, { start: 60, end: 120 }]))
      .toEqual([{ start: 60, end: 120 }, { start: 300, end: 360 }]);
  });
});

describe('subtractBusy', () => {
  const window = { start: at(9), end: at(17) };

  it('returns the whole window when nothing is busy', () => {
    expect(subtractBusy(window, [])).toEqual([window]);
  });

  it('splits the window around a meeting in the middle', () => {
    expect(subtractBusy(window, [{ start: at(12), end: at(13) }]))
      .toEqual([{ start: at(9), end: at(12) }, { start: at(13), end: at(17) }]);
  });

  it('removes the window when a block covers it', () => {
    expect(subtractBusy(window, [{ start: at(8), end: at(18) }])).toEqual([]);
  });

  it('ignores busy intervals outside the window', () => {
    expect(subtractBusy(window, [{ start: at(6), end: at(7) }, { start: at(20), end: at(21) }]))
      .toEqual([window]);
  });

  it('trims from each edge', () => {
    expect(subtractBusy(window, [{ start: at(8), end: at(10) }]))
      .toEqual([{ start: at(10), end: at(17) }]);
    expect(subtractBusy(window, [{ start: at(16), end: at(19) }]))
      .toEqual([{ start: at(9), end: at(16) }]);
  });
});

describe('openTime', () => {
  // The shape the app actually resolves: work 09:00–18:00, home 07:00–08:00 and
  // 18:00–23:00, community unconfigured.
  const windows = {
    work: [{ start: at(9), end: at(18) }],
    home: [{ start: at(7), end: at(8) }, { start: at(18), end: at(23) }],
    community: [],
  };

  it('reports the whole work window when nothing is scheduled', () => {
    expect(shape(openTime(windows, []))).toEqual(['work 9:00am-6:00pm']);
  });

  it('never offers home hours as open time', () => {
    // Home windows exist and are free, but they are not placement capacity.
    const segs = openTime(windows, []);
    expect(segs.every((s) => s.direction !== 'home')).toBe(true);
  });

  it('subtracts the day’s blocks', () => {
    const segs = openTime(windows, [
      { start: at(9), end: at(10, 30) },
      { start: at(10, 30), end: at(10, 45) },
    ]);
    expect(shape(segs)).toEqual(['work 10:45am-6:00pm']);
    expect(totalOpen(segs)).toBe(at(7, 15));
  });

  it('does not double-subtract overlapping blocks', () => {
    // Two meetings 9–11 and 10–12 leave 12:00, not 11:00 — subtracting the second
    // from an already-advanced cursor would eat an extra hour.
    expect(shape(openTime(windows, [
      { start: at(9), end: at(11) },
      { start: at(10), end: at(12) },
    ]))).toEqual(['work 12:00pm-6:00pm']);
  });

  it(`drops gaps shorter than ${MIN_OPEN_MINUTES} minutes`, () => {
    const segs = openTime(windows, [
      { start: at(9), end: at(12) },
      { start: at(12, 10), end: at(18) },
    ]);
    expect(segs).toEqual([]);
  });

  it('includes community windows when they are configured', () => {
    const withCommunity = { ...windows, community: [{ start: at(18, 30), end: at(20) }] };
    expect(shape(openTime(withCommunity, []))).toEqual([
      'work 9:00am-6:00pm',
      'community 6:30pm-8:00pm',
    ]);
  });

  it('orders segments by start time across directions', () => {
    const w = {
      work: [{ start: at(13), end: at(17) }],
      community: [{ start: at(8), end: at(9) }],
    };
    expect(shape(openTime(w))).toEqual(['community 8:00am-9:00am', 'work 1:00pm-5:00pm']);
  });

  it('is empty when no relevant window is configured', () => {
    expect(openTime({ home: [{ start: at(7), end: at(23) }] }, [])).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats clock times around noon and midnight', () => {
    expect(formatClock(0)).toBe('12:00am');
    expect(formatClock(at(12))).toBe('12:00pm');
    expect(formatClock(at(13, 5))).toBe('1:05pm');
  });

  it('formats durations without empty units', () => {
    expect(formatDuration(75)).toBe('1h 15m');
    expect(formatDuration(240)).toBe('4h');
    expect(formatDuration(30)).toBe('30m');
    expect(formatDuration(0)).toBe('0m');
  });
});

describe('minutesOfDay', () => {
  it('reads the local wall clock of a timestamp', () => {
    const d = new Date(2026, 7, 14, 9, 30);
    expect(minutesOfDay(d.toISOString())).toBe(at(9, 30));
  });

  it('returns null for an unparseable timestamp', () => {
    expect(minutesOfDay('not-a-date')).toBeNull();
  });
});
