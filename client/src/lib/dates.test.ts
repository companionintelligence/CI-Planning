import { describe, it, expect } from 'vitest';
import { isoWeekKey, weekDaysOf, addDays, durationLabel } from './dates.js';

describe('durationLabel', () => {
  it('splits into hours and minutes past the hour', () => {
    expect(durationLabel(430)).toBe('7h 10m');
    expect(durationLabel(540)).toBe('9h');
  });

  it('stays in minutes below an hour', () => {
    expect(durationLabel(45)).toBe('45m');
    expect(durationLabel(0)).toBe('0m');
  });

  it('clamps negatives and rounds fractions rather than printing them', () => {
    expect(durationLabel(-30)).toBe('0m');
    expect(durationLabel(90.4)).toBe('1h 30m');
  });

  it('treats null/undefined capacity as zero', () => {
    expect(durationLabel(null)).toBe('0m');
    expect(durationLabel(undefined)).toBe('0m');
  });
});

describe('isoWeekKey', () => {
  it('ordinary mid-year date', () => {
    // 2026-06-15 is a Monday — W25 of 2026.
    expect(isoWeekKey('2026-06-15')).toBe('2026-W25');
  });

  it('Friday of the same week', () => {
    expect(isoWeekKey('2026-06-19')).toBe('2026-W25');
  });

  it('Sunday belongs to the PREVIOUS week (Monday-start)', () => {
    // 2026-06-21 (Sunday) is the last day of W25, NOT the first day of W26.
    expect(isoWeekKey('2026-06-21')).toBe('2026-W25');
  });

  it('Monday starts the next week', () => {
    expect(isoWeekKey('2026-06-22')).toBe('2026-W26');
  });

  // ISO 8601 Thursday rule: W53 / year-boundary cases
  it('2021-01-01 (Friday) → W53 of 2020 (Thursday of its week is 2020-12-31)', () => {
    expect(isoWeekKey('2021-01-01')).toBe('2020-W53');
  });

  it('2021-01-03 (Sunday) → W53 of 2020', () => {
    expect(isoWeekKey('2021-01-03')).toBe('2020-W53');
  });

  it('2021-01-04 (Monday) → W01 of 2021', () => {
    expect(isoWeekKey('2021-01-04')).toBe('2021-W01');
  });

  it('2020-12-31 (Thursday) → W53 of 2020', () => {
    expect(isoWeekKey('2020-12-31')).toBe('2020-W53');
  });

  it('2015-12-28 (Monday, last week of 2015 = W53)', () => {
    expect(isoWeekKey('2015-12-28')).toBe('2015-W53');
  });

  it('2016-01-03 (Sunday, still W53 of 2015)', () => {
    expect(isoWeekKey('2016-01-03')).toBe('2015-W53');
  });

  it('2016-01-04 (Monday) → W01 of 2016', () => {
    expect(isoWeekKey('2016-01-04')).toBe('2016-W01');
  });

  it('W01 of a year always starts on a Monday', () => {
    const key = isoWeekKey('2026-01-01'); // Thursday, W01
    const [yearStr, wStr] = key.split('-W');
    const year = Number(yearStr);
    const week = Number(wStr);
    // Find the Monday of W01 for this year: Jan 4 anchor
    const jan4 = `${year}-01-04`;
    const monday = weekDaysOf(jan4)[0]; // weekDaysOf returns [Mon .. Sun]
    // isoWeekKey of that Monday must equal the original key (same week)
    expect(isoWeekKey(monday)).toBe(key);
    // And week number must be 1
    expect(week).toBe(1);
  });

  it('Monday of the returned week matches weekDaysOf()[0]', () => {
    const dates = [
      '2026-06-15', // Mon
      '2026-06-19', // Fri
      '2026-06-21', // Sun
      '2021-01-01', // Fri (W53)
      '2021-01-04', // Mon (W01)
    ];
    for (const d of dates) {
      const weekMonday = weekDaysOf(d)[0];
      expect(isoWeekKey(d)).toBe(isoWeekKey(weekMonday));
    }
  });

  it('all 7 days of a week share the same key', () => {
    const monday = '2026-06-15';
    const key = isoWeekKey(monday);
    for (let i = 0; i < 7; i++) {
      expect(isoWeekKey(addDays(monday, i))).toBe(key);
    }
  });

  it('consecutive weeks produce consecutive W-numbers (same year)', () => {
    const w25 = isoWeekKey('2026-06-15');
    const w26 = isoWeekKey('2026-06-22');
    const n25 = Number(w25.split('-W')[1]);
    const n26 = Number(w26.split('-W')[1]);
    expect(n26 - n25).toBe(1);
  });
});
