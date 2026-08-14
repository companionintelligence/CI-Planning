import { describe, it, expect } from 'vitest';
import { buildFocusItems, countPastRows, memberPast, type FocusItem } from './focus-sections.js';

/**
 * Phase 2 — Focus groups its list into Time-Block sections. These pin the ordering,
 * the grouping, and the past/upcoming rule; the DOM behaviour (collapse, progress
 * label) rides on top of them.
 */

const NOW = Date.parse('2026-06-22T12:00:00.000Z');
const ms = (min: number) => NOW + min * 60_000;

const member = (over: Partial<Parameters<typeof buildFocusItems>[0][number]> & { key?: string } = {}) => ({
  key: 'm',
  sortMin: 600,
  endMs: ms(60),
  done: false,
  parentBlockId: null,
  ...over,
}) as any;

const container = (over: Record<string, unknown> = {}) => ({
  id: 'tb1',
  sortMin: 590,
  endMs: ms(120),
  ...over,
}) as any;

const kinds = (items: FocusItem<any, any>[]) => items.map((i) => (i.kind === 'section' ? `section:${i.section.container.id}` : `loose:${i.member.key}`));

describe('buildFocusItems — grouping', () => {
  it('a member nests under its container instead of standing as a loose row', () => {
    const items = buildFocusItems(
      [member({ key: 'a', parentBlockId: 'tb1' })],
      [container()],
      NOW,
    );
    expect(kinds(items)).toEqual(['section:tb1']);
    expect(items[0].kind === 'section' && items[0].section.members.map((m: any) => m.key)).toEqual(['a']);
  });

  it('an orphan whose Time Block is not on this list stays a loose row', () => {
    // Same rule as the Calendar's containment split — dropping it would make the
    // task vanish from the day entirely.
    const items = buildFocusItems([member({ key: 'a', parentBlockId: 'gone' })], [], NOW);
    expect(kinds(items)).toEqual(['loose:a']);
  });

  it('a task with no parent is untouched', () => {
    const items = buildFocusItems([member({ key: 'a' })], [container()], NOW);
    expect(kinds(items)).toEqual(['section:tb1', 'loose:a']); // 590 then 600
  });

  it('sections and loose rows interleave chronologically', () => {
    const items = buildFocusItems(
      [member({ key: 'early', sortMin: 300 }), member({ key: 'late', sortMin: 900 }), member({ key: 'in', sortMin: 600, parentBlockId: 'tb1' })],
      [container({ sortMin: 590 })],
      NOW,
    );
    expect(kinds(items)).toEqual(['loose:early', 'section:tb1', 'loose:late']);
  });

  it('members are ordered within their section', () => {
    const items = buildFocusItems(
      [member({ key: 'b', sortMin: 700, parentBlockId: 'tb1' }), member({ key: 'a', sortMin: 610, parentBlockId: 'tb1' })],
      [container()],
      NOW,
    );
    expect(items[0].kind === 'section' && items[0].section.members.map((m: any) => m.key)).toEqual(['a', 'b']);
  });

  it('an empty Time Block still renders as a section', () => {
    const items = buildFocusItems([], [container()], NOW);
    expect(kinds(items)).toEqual(['section:tb1']);
    expect(items[0].kind === 'section' && items[0].section.total).toBe(0);
  });
});

describe('buildFocusItems — progress', () => {
  it('counts done members against the total', () => {
    const items = buildFocusItems(
      [
        member({ key: 'a', parentBlockId: 'tb1', done: true }),
        member({ key: 'b', parentBlockId: 'tb1' }),
        member({ key: 'c', parentBlockId: 'tb1' }),
      ],
      [container()],
      NOW,
    );
    const s = items[0].kind === 'section' ? items[0].section : null;
    expect(s!.doneCount).toBe(1);
    expect(s!.total).toBe(3);
  });
});

describe('buildFocusItems — past vs upcoming', () => {
  it('a section whose members are all done is past', () => {
    const items = buildFocusItems(
      [member({ key: 'a', parentBlockId: 'tb1', done: true, endMs: ms(90) })],
      [container({ endMs: ms(120) })], // still ahead on the clock
      NOW,
    );
    expect(items[0].past).toBe(true);
  });

  it('a section whose span has elapsed is past even with work left in it', () => {
    const items = buildFocusItems(
      [member({ key: 'a', parentBlockId: 'tb1', done: false })],
      [container({ endMs: ms(-10) })],
      NOW,
    );
    expect(items[0].past).toBe(true);
  });

  it('an EMPTY container is not "all done" — it is past only once its time passes', () => {
    // 0 of 0 members done must not read as completion, or an empty Time Block would
    // drop into "earlier" the moment it appeared.
    expect(buildFocusItems([], [container({ endMs: ms(60) })], NOW)[0].past).toBe(false);
    expect(buildFocusItems([], [container({ endMs: ms(-1) })], NOW)[0].past).toBe(true);
  });

  it('a section with work outstanding and time remaining is upcoming', () => {
    const items = buildFocusItems(
      [member({ key: 'a', parentBlockId: 'tb1', done: true }), member({ key: 'b', parentBlockId: 'tb1', done: false })],
      [container({ endMs: ms(60) })],
      NOW,
    );
    expect(items[0].past).toBe(false);
  });

  it('members travel with their section rather than splitting across the two lists', () => {
    // One member finished, one not: the section is upcoming and BOTH stay in it.
    const items = buildFocusItems(
      [member({ key: 'done', parentBlockId: 'tb1', done: true }), member({ key: 'open', parentBlockId: 'tb1' })],
      [container({ endMs: ms(60) })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'section' && items[0].section.members).toHaveLength(2);
  });
});

describe('memberPast', () => {
  it('is past when done, or when the slot has elapsed', () => {
    expect(memberPast({ sortMin: 0, endMs: ms(60), done: true, parentBlockId: null }, NOW)).toBe(true);
    expect(memberPast({ sortMin: 0, endMs: ms(-1), done: false, parentBlockId: null }, NOW)).toBe(true);
    expect(memberPast({ sortMin: 0, endMs: ms(60), done: false, parentBlockId: null }, NOW)).toBe(false);
  });

  it('a time-less row is never past until it is done', () => {
    expect(memberPast({ sortMin: 1440, endMs: null, done: false, parentBlockId: null }, NOW)).toBe(false);
  });
});

describe('countPastRows', () => {
  it('counts a past section by its MEMBERS, so the summary stays truthful', () => {
    const items = buildFocusItems(
      [
        member({ key: 'a', parentBlockId: 'tb1', done: true }),
        member({ key: 'b', parentBlockId: 'tb1', done: true }),
        member({ key: 'loose', done: true, endMs: ms(-5) }),
        member({ key: 'ahead', done: false, endMs: ms(60) }),
      ],
      [container({ endMs: ms(-1) })],
      NOW,
    );
    // 2 members of the elapsed section + 1 past loose row = 3 rows, all done.
    expect(countPastRows(items)).toEqual({ rows: 3, done: 3 });
  });

  it('an empty past section contributes no rows', () => {
    const items = buildFocusItems([], [container({ endMs: ms(-1) })], NOW);
    expect(countPastRows(items)).toEqual({ rows: 0, done: 0 });
  });
});
