import { describe, it, expect } from 'vitest';
import {
  groupFlightPlan, buildRows, pageSlice, filterByName,
  nextQuarterHourHHMM, localDayTimeToISO, PAGE_SIZE,
  type Groupable,
} from './flight-plan-view.js';

const item = (id: string, ref: string | null = null): Groupable & { task_id: string; title: string } => ({
  task_id: id,
  title: `Task ${id}`,
  source_kind: ref ? 'pattern' : 'manual',
  source_ref: ref,
});

describe('groupFlightPlan', () => {
  it('splits pattern-sourced items into groups and the rest into solo', () => {
    const items = [item('a', 'p1'), item('b'), item('c', 'p1'), item('d', 'p2')];
    const g = groupFlightPlan(items);
    expect(g.groups.map(([id, its]) => [id, its.length])).toEqual([['p1', 2], ['p2', 1]]);
    expect(g.solo.map((i) => i.task_id)).toEqual(['b']);
  });

  it('treats a pattern item with no source_ref as solo', () => {
    const odd = { source_kind: 'pattern', source_ref: null };
    expect(groupFlightPlan([odd]).solo).toHaveLength(1);
  });
});

describe('buildRows', () => {
  const grouped = groupFlightPlan([item('a', 'p1'), item('b', 'p1'), item('c')]);

  it('collapsed group counts as ONE row', () => {
    const rows = buildRows(grouped, () => false);
    expect(rows.map((r) => r.kind)).toEqual(['group', 'item']); // header + solo
  });

  it('expanded group contributes header + one row per member', () => {
    const rows = buildRows(grouped, () => true);
    expect(rows.map((r) => r.kind)).toEqual(['group', 'item', 'item', 'item']);
    expect(rows.filter((r) => r.kind === 'item' && r.inGroup)).toHaveLength(2);
  });

  it('expanding a group pushes later rows onto the next page', () => {
    // 1 group of 12 + 1 solo. Collapsed: 2 rows, one page. Expanded: 14 rows, two pages.
    const many = groupFlightPlan([...Array.from({ length: 12 }, (_, i) => item(`g${i}`, 'p1')), item('solo')]);
    const collapsed = pageSlice(buildRows(many, () => false), 0);
    expect(collapsed.total).toBe(2);
    expect(collapsed.showPager).toBe(false);

    const expanded = pageSlice(buildRows(many, () => true), 0);
    expect(expanded.total).toBe(14);
    expect(expanded.totalPages).toBe(2);
    expect(expanded.showPager).toBe(true);
    // The solo item fell off page 0…
    expect(expanded.rows.some((r) => r.kind === 'item' && r.item.task_id === 'solo')).toBe(false);
    // …and shows on page 1.
    const page1 = pageSlice(buildRows(many, () => true), 1);
    expect(page1.rows.some((r) => r.kind === 'item' && r.item.task_id === 'solo')).toBe(true);
  });
});

describe('pageSlice', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);

  it('slices 10 per page with correct page count', () => {
    expect(pageSlice(rows, 0).rows).toEqual(rows.slice(0, 10));
    expect(pageSlice(rows, 2).rows).toEqual(rows.slice(20));
    expect(pageSlice(rows, 0).totalPages).toBe(3);
    expect(PAGE_SIZE).toBe(10);
  });

  it('clamps an out-of-range page (stale index after list shrinks)', () => {
    expect(pageSlice(rows, 99).page).toBe(2);
    expect(pageSlice(rows, -5).page).toBe(0);
    expect(pageSlice([], 3)).toMatchObject({ page: 0, totalPages: 1, total: 0, showPager: false });
  });

  it('hides the pager at exactly one page', () => {
    expect(pageSlice(rows.slice(0, 10), 0).showPager).toBe(false);
    expect(pageSlice(rows.slice(0, 11), 0).showPager).toBe(true);
  });
});

describe('filterByName', () => {
  const items = [{ n: 'Morning routine' }, { n: 'Deep Work' }, { n: 'email sweep' }];

  it('is a case-insensitive substring match', () => {
    expect(filterByName(items, 'WORK', (i) => i.n)).toEqual([{ n: 'Deep Work' }]);
    expect(filterByName(items, 'e', (i) => i.n)).toHaveLength(3);
  });

  it('empty or whitespace query returns everything', () => {
    expect(filterByName(items, '', (i) => i.n)).toHaveLength(3);
    expect(filterByName(items, '   ', (i) => i.n)).toHaveLength(3);
  });
});

describe('nextQuarterHourHHMM', () => {
  it('rounds up to the next quarter boundary', () => {
    expect(nextQuarterHourHHMM(new Date(2026, 6, 3, 10, 7))).toBe('10:15');
    expect(nextQuarterHourHHMM(new Date(2026, 6, 3, 10, 16))).toBe('10:30');
    expect(nextQuarterHourHHMM(new Date(2026, 6, 3, 10, 59))).toBe('11:00');
  });

  it('moves strictly forward when already on a boundary', () => {
    expect(nextQuarterHourHHMM(new Date(2026, 6, 3, 10, 0))).toBe('10:15');
    expect(nextQuarterHourHHMM(new Date(2026, 6, 3, 23, 45))).toBe('00:00'); // rolls past midnight
  });
});

describe('localDayTimeToISO', () => {
  it('round-trips a local wall time to the same instant', () => {
    const iso = localDayTimeToISO('2026-07-03', '09:30');
    const d = new Date(iso);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });
});
