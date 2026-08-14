import { describe, it, expect } from 'vitest';
import { buildFocusItems, countPastRows, memberPast, itemPast, type FocusItem } from './focus-sections.js';

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
    );
    expect(kinds(items)).toEqual(['section:tb1']);
    expect(items[0].kind === 'section' && items[0].section.members.map((m: any) => m.key)).toEqual(['a']);
  });

  it('an orphan whose Time Block is not on this list stays a loose row', () => {
    // Same rule as the Calendar's containment split — dropping it would make the
    // task vanish from the day entirely.
    const items = buildFocusItems([member({ key: 'a', parentBlockId: 'gone' })], []);
    expect(kinds(items)).toEqual(['loose:a']);
  });

  it('a task with no parent is untouched', () => {
    const items = buildFocusItems([member({ key: 'a' })], [container()]);
    expect(kinds(items)).toEqual(['section:tb1', 'loose:a']); // 590 then 600
  });

  it('sections and loose rows interleave chronologically', () => {
    const items = buildFocusItems(
      [member({ key: 'early', sortMin: 300 }), member({ key: 'late', sortMin: 900 }), member({ key: 'in', sortMin: 600, parentBlockId: 'tb1' })],
      [container({ sortMin: 590 })]);
    expect(kinds(items)).toEqual(['loose:early', 'section:tb1', 'loose:late']);
  });

  it('members are ordered within their section', () => {
    const items = buildFocusItems(
      [member({ key: 'b', sortMin: 700, parentBlockId: 'tb1' }), member({ key: 'a', sortMin: 610, parentBlockId: 'tb1' })],
      [container()],
    );
    expect(items[0].kind === 'section' && items[0].section.members.map((m: any) => m.key)).toEqual(['a', 'b']);
  });

  it('an empty Time Block still renders as a section', () => {
    const items = buildFocusItems([], [container()]);
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
    );
    expect(itemPast(items[0], NOW)).toBe(true);
  });

  it('a section whose span has elapsed is past even with work left in it', () => {
    const items = buildFocusItems(
      [member({ key: 'a', parentBlockId: 'tb1', done: false })],
      [container({ endMs: ms(-10) })],
    );
    expect(itemPast(items[0], NOW)).toBe(true);
  });

  it('an EMPTY container is not "all done" — it is past only once its time passes', () => {
    // 0 of 0 members done must not read as completion, or an empty Time Block would
    // drop into "earlier" the moment it appeared.
    expect(itemPast(buildFocusItems([], [container({ endMs: ms(60) })])[0], NOW)).toBe(false);
    expect(itemPast(buildFocusItems([], [container({ endMs: ms(-1) })])[0], NOW)).toBe(true);
  });

  it('a section with work outstanding and time remaining is upcoming', () => {
    const items = buildFocusItems(
      [member({ key: 'a', parentBlockId: 'tb1', done: true }), member({ key: 'b', parentBlockId: 'tb1', done: false })],
      [container({ endMs: ms(60) })],
    );
    expect(itemPast(items[0], NOW)).toBe(false);
  });

  it('members travel with their section rather than splitting across the two lists', () => {
    // One member finished, one not: the section is upcoming and BOTH stay in it.
    const items = buildFocusItems(
      [member({ key: 'done', parentBlockId: 'tb1', done: true }), member({ key: 'open', parentBlockId: 'tb1' })],
      [container({ endMs: ms(60) })],
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'section' && items[0].section.members).toHaveLength(2);
  });
});

describe('identity stability (the contract `<For>` depends on)', () => {
  // Regression: grouping used to take `nowMs` and bake a `past` flag into every item,
  // so the 30-second Focus tick produced all-new objects. Solid's `<For>` keys by
  // reference, so every row was destroyed and rebuilt — wiping whatever was being
  // typed into a section's add box. Grouping must not depend on the clock.
  const members = [member({ key: 'a', parentBlockId: 'tb1' }), member({ key: 'loose', sortMin: 800 })];
  const containers = [container()];

  it('returns equal items for equal inputs regardless of the clock', () => {
    const first = buildFocusItems(members, containers);
    const second = buildFocusItems(members, containers);
    expect(second).toEqual(first);
  });

  it('carries the SAME member references through, so rows are not re-created', () => {
    const items = buildFocusItems(members, containers);
    const section = items.find((i) => i.kind === 'section')!;
    const loose = items.find((i) => i.kind === 'loose')!;
    expect(section.kind === 'section' && section.section.members[0]).toBe(members[0]);
    expect(loose.kind === 'loose' && loose.member).toBe(members[1]);
  });

  it('takes no clock argument at all — pastness is asked, not stored', () => {
    // Two arguments only. A third would mean the clock is back inside the memo.
    expect(buildFocusItems.length).toBe(2);
    expect('past' in buildFocusItems(members, containers)[0]).toBe(false);
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
    );
    // 2 members of the elapsed section + 1 past loose row = 3 rows, all done.
    expect(countPastRows(items, NOW)).toEqual({ rows: 3, done: 3 });
  });

  it('an empty past section contributes no rows', () => {
    const items = buildFocusItems([], [container({ endMs: ms(-1) })]);
    expect(countPastRows(items, NOW)).toEqual({ rows: 0, done: 0 });
  });
});
