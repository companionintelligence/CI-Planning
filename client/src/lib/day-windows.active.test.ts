import { describe, it, expect } from 'vitest';
import { activeWindowsAt, type DayWindows, type TagDef } from './day-windows.js';

/**
 * "What am I inside right now?" for the details drawer's nothing-selected state. A day
 * type alone ("Workday") does not answer that — it does not say whether you are in work
 * hours or the evening.
 */
const TAGS: TagDef[] = [
  { id: 'w', name: 'Work' },
  { id: 'h', name: 'Home' },
  { id: 'c', name: 'Community' },
];
const WINDOWS: DayWindows = {
  w: [{ start_time: '09:30', end_time: '13:00' }, { start_time: '13:30', end_time: '18:00' }],
  h: [{ start_time: '07:00', end_time: '07:30' }, { start_time: '19:15', end_time: '23:00' }],
  c: [{ start_time: '19:15', end_time: '21:00' }],
};
const at = (h: number, m = 0) => activeWindowsAt(WINDOWS, TAGS, h * 60 + m);

describe('activeWindowsAt', () => {
  it('reports the window covering the moment', () => {
    expect(at(10)).toEqual([{ direction: 'work', start: 570, end: 780 }]);
  });

  it('reports every overlapping window, not just the first', () => {
    // Home and Community both run from 19:15 — reporting one would hide the other.
    expect(at(20).map((w) => w.direction)).toEqual(['community', 'home']);
  });

  it('is empty in a gap between windows', () => {
    expect(at(13, 15)).toEqual([]); // 13:00-13:30 lunch gap
  });

  it('treats the end as exclusive so a boundary minute reports one window, not two', () => {
    // 13:00 ends the morning window and 13:30 starts the afternoon one; at exactly
    // 13:00 you are in neither, and crucially never in both.
    expect(at(13, 0)).toEqual([]);
    expect(at(12, 59).map((w) => w.direction)).toEqual(['work']);
  });

  it('ignores windows whose direction tag is unknown', () => {
    expect(activeWindowsAt({ ghost: [{ start_time: '00:00', end_time: '23:59' }] }, TAGS, 600)).toEqual([]);
  });

  it('survives absent or malformed input rather than throwing', () => {
    expect(activeWindowsAt({} as DayWindows, TAGS, 600)).toEqual([]);
    expect(activeWindowsAt({ w: [{ start_time: 'oops', end_time: '18:00' }] }, TAGS, 600)).toEqual([]);
  });
});
