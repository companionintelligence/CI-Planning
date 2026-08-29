import { describe, it, expect } from 'vitest';
import {
  windowFor, inWindow, targetForWindow, groupByTitle, minutesBetween, hoursLabel,
} from './dimension-rollup.js';

describe('windowFor', () => {
  it('week is the Monday–Sunday week containing the anchor', () => {
    // 2026-08-28 is a Friday
    expect(windowFor('week', '2026-08-28')).toEqual({ from: '2026-08-24', to: '2026-08-30', days: 7 });
  });
  it('treats Sunday as the END of its week, not the start', () => {
    expect(windowFor('week', '2026-08-30')).toEqual({ from: '2026-08-24', to: '2026-08-30', days: 7 });
  });
  it('treats Monday as the start of its own week', () => {
    expect(windowFor('week', '2026-08-24')).toEqual({ from: '2026-08-24', to: '2026-08-30', days: 7 });
  });
  it('month spans the calendar month and reports its real length', () => {
    expect(windowFor('month', '2026-08-28')).toEqual({ from: '2026-08-01', to: '2026-08-31', days: 31 });
    expect(windowFor('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28', days: 28 });
  });
  it('gets February right in a leap year', () => {
    expect(windowFor('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29', days: 29 });
  });
});

describe('inWindow', () => {
  const w = windowFor('week', '2026-08-28');
  it('includes both endpoints', () => {
    expect(inWindow('2026-08-24', w)).toBe(true);
    expect(inWindow('2026-08-30', w)).toBe(true);
  });
  it('excludes the days either side', () => {
    expect(inWindow('2026-08-23', w)).toBe(false);
    expect(inWindow('2026-08-31', w)).toBe(false);
  });
  it('compares on the date part of a full timestamp', () => {
    expect(inWindow('2026-08-30T23:59:00Z', w)).toBe(true);
  });
  it('is false for null/undefined rather than throwing', () => {
    expect(inWindow(null, w)).toBe(false);
    expect(inWindow(undefined, w)).toBe(false);
  });
});

describe('targetForWindow', () => {
  it('leaves a weekly target alone over a week', () => {
    expect(targetForWindow(14, windowFor('week', '2026-08-28'))).toBe(14);
  });
  it('pro-rates across a month by real day count', () => {
    // 14h/wk × 31/7 = 62
    expect(targetForWindow(14, windowFor('month', '2026-08-28'))).toBe(62);
    // 14h/wk × 28/7 = 56
    expect(targetForWindow(14, windowFor('month', '2026-02-10'))).toBe(56);
  });
});

describe('groupByTitle', () => {
  const rows = [
    { id: 'a', title: 'Morning walk', m: 30 },
    { id: 'b', title: 'Call Mum', m: 20 },
    { id: 'c', title: 'Morning walk', m: 30 },
    { id: 'd', title: 'morning walk', m: 15 },
  ];
  const g = groupByTitle(rows, (r) => r.title, (r) => r.m);

  it('collapses repeats into one row carrying the count', () => {
    expect(g).toHaveLength(2);
    expect(g[0].title).toBe('Morning walk');
    expect(g[0].count).toBe(3);
    expect(g[1].count).toBe(1);
  });
  it('folds case so a recurrence instance is not counted twice', () => {
    expect(g[0].count).toBe(3); // includes the lowercased one
  });
  it('sums the minutes across the group', () => {
    expect(g[0].minutes).toBe(75);
  });
  it('keeps the first row so the entry can still link somewhere', () => {
    expect(g[0].first.id).toBe('a');
  });
  it('preserves the order the groups first appeared in', () => {
    expect(g.map((x) => x.title)).toEqual(['Morning walk', 'Call Mum']);
  });
  it('ignores surrounding whitespace when grouping', () => {
    const out = groupByTitle([{ t: 'Ship it' }, { t: '  Ship it  ' }], (r) => r.t);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
    expect(out[0].title).toBe('Ship it');
  });
  it('returns nothing for no rows', () => {
    expect(groupByTitle([], (r: { t: string }) => r.t)).toEqual([]);
  });
});

describe('minutesBetween', () => {
  it('measures a normal span', () => {
    expect(minutesBetween('2026-08-28T09:00:00Z', '2026-08-28T10:30:00Z')).toBe(90);
  });
  it('is 0 for an inverted or zero-length span rather than negative', () => {
    expect(minutesBetween('2026-08-28T10:00:00Z', '2026-08-28T09:00:00Z')).toBe(0);
    expect(minutesBetween('2026-08-28T09:00:00Z', '2026-08-28T09:00:00Z')).toBe(0);
  });
  it('is 0 for unparseable input', () => {
    expect(minutesBetween('nonsense', '2026-08-28T09:00:00Z')).toBe(0);
  });
});

describe('hoursLabel', () => {
  it('shows sub-hour spans in minutes', () => expect(hoursLabel(45)).toBe('45m'));
  it('shows hours with one decimal', () => expect(hoursLabel(90)).toBe('1.5h'));
  it('floors nothing-scheduled to 0h', () => {
    expect(hoursLabel(0)).toBe('0h');
    expect(hoursLabel(-10)).toBe('0h');
  });
});
