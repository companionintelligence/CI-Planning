import { describe, it, expect } from 'vitest';
import {
  blockPassesAxes,
  axisPasses,
  emptyAxisDeselected,
  noAxisFilter,
  isAllDay,
  isTimed,
  isTaskBlock,
} from './overlay.js';
import type { AxisDeselected, TagAxis, TagKindLookup } from './overlay.js';
import type { Block, Task } from './api.js';

function blk(o: Partial<Block> = {}): Block {
  return {
    id: 1,
    title: 'B',
    block_kind: 'task',
    start_at: '2026-06-15T16:00:00.000Z',
    end_at: '2026-06-15T17:00:00.000Z',
    is_locked: false,
    is_auto: false,
    source_kind: 'manual',
    status: 'planned',
    created_at: '2026-06-15T00:00:00.000Z',
    ...o,
  };
}
function task(o: Partial<Task> = {}): Task {
  return {
    id: 10,
    title: 'T',
    priority: 3,
    status: 'open',
    owner_id: 1,
    source_kind: 'manual',
    created_at: '2026-06-15T00:00:00.000Z',
    tags: [],
    ...o,
  };
}

// A fixed taxonomy for the tests: three directions, two intentions, two categories.
const kindOf: TagKindLookup = new Map<string, TagAxis>([
  ['home', 'direction'],
  ['work', 'direction'],
  ['community', 'direction'],
  ['deep', 'intention'],
  ['admin', 'intention'],
  ['family', 'category'],
  ['me', 'category'],
]);

/** Build an AxisDeselected from a plain per-axis list of hidden names. */
function deselect(o: Partial<Record<TagAxis, string[]>> = {}): AxisDeselected {
  const d = emptyAxisDeselected();
  for (const axis of ['direction', 'intention', 'category'] as TagAxis[]) {
    for (const n of o[axis] ?? []) d[axis].add(n);
  }
  return d;
}

describe('axisPasses — OR within a group, untagged-on-axis always passes', () => {
  it('all-on (empty deselect) passes everything, tagged or not', () => {
    expect(axisPasses(['home'], 'direction', kindOf, new Set())).toBe(true);
    expect(axisPasses([], 'direction', kindOf, new Set())).toBe(true);
  });

  it('deselecting a direction hides only blocks whose only direction is that one', () => {
    const hidden = new Set(['home']);
    expect(axisPasses(['home'], 'direction', kindOf, hidden)).toBe(false);
    expect(axisPasses(['work'], 'direction', kindOf, hidden)).toBe(true);
  });

  it('OR within group: a block tagged home+work still shows while work is selected', () => {
    const hidden = new Set(['home']);
    expect(axisPasses(['home', 'work'], 'direction', kindOf, hidden)).toBe(true);
    // both of its directions hidden ⇒ gone
    expect(axisPasses(['home', 'work'], 'direction', kindOf, new Set(['home', 'work']))).toBe(false);
  });

  it('untagged-on-axis ALWAYS passes, even with chips deselected', () => {
    // block has an intention but no direction ⇒ passes the direction axis regardless
    expect(axisPasses(['deep'], 'direction', kindOf, new Set(['home', 'work', 'community']))).toBe(true);
    // block with no tags at all passes every axis
    expect(axisPasses([], 'direction', kindOf, new Set(['home']))).toBe(true);
  });
});

describe('blockPassesAxes — AND across the three axes + priority', () => {
  const allOn = emptyAxisDeselected();
  const hw = task({ id: 10, tags: ['home', 'deep', 'family'], priority: 2 });

  it('all-on passes everything (tagged block and break/buffer alike)', () => {
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, allOn, [])).toBe(true);
    expect(blockPassesAxes(blk({ task_id: undefined }), undefined, kindOf, allOn, [])).toBe(true);
  });

  it('deselecting one direction hides only blocks matching that direction', () => {
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, deselect({ direction: ['home'] }), [])).toBe(false);
    const work = task({ id: 11, tags: ['work', 'deep'], priority: 2 });
    expect(blockPassesAxes(blk({ task_id: 11 }), work, kindOf, deselect({ direction: ['home'] }), [])).toBe(true);
  });

  it('AND across groups: pass Direction but fail Intention ⇒ hidden', () => {
    // still-selected direction (work), but its only intention (deep) is hidden
    const work = task({ id: 11, tags: ['work', 'deep'], priority: 2 });
    expect(blockPassesAxes(blk({ task_id: 11 }), work, kindOf, deselect({ intention: ['deep'] }), [])).toBe(false);
  });

  it('untagged-on-axis still passes when OTHER axes are filtered', () => {
    // task has a direction but no intention/category; hiding intentions must not hide it
    const dirOnly = task({ id: 12, tags: ['work'], priority: 2 });
    expect(blockPassesAxes(blk({ task_id: 12 }), dirOnly, kindOf, deselect({ intention: ['deep', 'admin'] }), [])).toBe(true);
  });

  it('priority still ANDs with the tag axes', () => {
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, allOn, [2])).toBe(true);  // prio matches
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, allOn, [5])).toBe(false); // prio fails
    // tag ok but priority fails
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, deselect(), [5])).toBe(false);
  });

  it('a break/buffer (no task) passes all tag axes but is hidden by any priority filter', () => {
    expect(blockPassesAxes(blk({ task_id: undefined }), undefined, kindOf, deselect({ direction: ['home'] }), [])).toBe(true);
    expect(blockPassesAxes(blk({ task_id: undefined }), undefined, kindOf, allOn, [2])).toBe(false);
  });

  it('clearing the filter (reset to all-on) restores a hidden block', () => {
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, deselect({ direction: ['home'] }), [])).toBe(false);
    expect(blockPassesAxes(blk({ task_id: 10 }), hw, kindOf, emptyAxisDeselected(), [])).toBe(true);
  });
});

describe('noAxisFilter helper', () => {
  it('true only when nothing is deselected on any axis', () => {
    expect(noAxisFilter(emptyAxisDeselected())).toBe(true);
    expect(noAxisFilter(deselect({ category: ['me'] }))).toBe(false);
  });
});

describe('task-block vs container partitioning', () => {
  it('a block_kind="task" WITH a task_id is a task block', () => {
    expect(isTaskBlock(blk({ block_kind: 'task', task_id: '10' }))).toBe(true);
  });

  it('a block_kind="task" WITHOUT a task_id is not a task block (defensive)', () => {
    expect(isTaskBlock(blk({ block_kind: 'task', task_id: undefined }))).toBe(false);
  });

  it('container kinds are never task blocks, even if a task_id is present', () => {
    for (const kind of ['timeblock', 'meeting', 'focus', 'habit', 'break', 'buffer']) {
      expect(isTaskBlock(blk({ block_kind: kind, task_id: '10' }))).toBe(false);
    }
  });
});

describe('all-day partitioning', () => {
  it('isAllDay / isTimed split blocks by the all_day flag', () => {
    expect(isAllDay(blk({ all_day: true }))).toBe(true);
    expect(isTimed(blk({ all_day: true }))).toBe(false);
    expect(isAllDay(blk({ all_day: false }))).toBe(false);
    expect(isTimed(blk({ all_day: false }))).toBe(true);
  });

  it('pre-migration (all_day absent) degrades to a timed block, never all-day', () => {
    const noCol = blk(); // no all_day key at all
    expect(noCol.all_day).toBeUndefined();
    expect(isAllDay(noCol)).toBe(false); // absent ⇒ false
    expect(isTimed(noCol)).toBe(true);   // stays on the minute axis
  });

  it('a header lane shows only all-day blocks; the minute axis shows only timed', () => {
    const list = [
      blk({ id: 1, all_day: true }),
      blk({ id: 2, all_day: false }),
      blk({ id: 3 }), // no column
    ];
    const lane = list.filter(isAllDay).map((b) => b.id);
    const axis = list.filter(isTimed).map((b) => b.id);
    expect(lane).toEqual([1]);
    expect(axis).toEqual([2, 3]);
  });
});
