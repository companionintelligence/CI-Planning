import { describe, it, expect } from 'vitest';
import { blockPasses, isAllDay, isTimed, isTaskBlock } from './overlay.js';
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

describe('overlay — tag AND priority (combinable)', () => {
  const eng = task({ id: 10, tags: ['eng', 'docs'], priority: 2 });

  it('no filter set → everything passes (including no-task blocks)', () => {
    expect(blockPasses(blk({ task_id: 10 }), eng, [], [])).toBe(true);
    expect(blockPasses(blk({ task_id: undefined }), undefined, [], [])).toBe(true);
  });

  it('tag-only filter passes matching, rejects non-matching', () => {
    expect(blockPasses(blk({ task_id: 10 }), eng, ['eng'], [])).toBe(true);
    expect(blockPasses(blk({ task_id: 10 }), eng, ['home'], [])).toBe(false);
  });

  it('priority-only filter passes matching, rejects non-matching', () => {
    expect(blockPasses(blk({ task_id: 10 }), eng, [], [2])).toBe(true);
    expect(blockPasses(blk({ task_id: 10 }), eng, [], [1])).toBe(false);
  });

  it('combined tag+priority requires BOTH to hold', () => {
    expect(blockPasses(blk({ task_id: 10 }), eng, ['eng'], [2])).toBe(true);  // both match
    expect(blockPasses(blk({ task_id: 10 }), eng, ['eng'], [5])).toBe(false); // prio fails
    expect(blockPasses(blk({ task_id: 10 }), eng, ['home'], [2])).toBe(false); // tag fails
  });

  it('a block with no task_id only appears when no filter is set', () => {
    expect(blockPasses(blk({ task_id: undefined }), undefined, [], [])).toBe(true);
    expect(blockPasses(blk({ task_id: undefined }), undefined, ['eng'], [])).toBe(false);
    expect(blockPasses(blk({ task_id: undefined }), undefined, [], [2])).toBe(false);
  });

  it('clearing the filter restores all blocks', () => {
    const filtered = blockPasses(blk({ task_id: 10 }), eng, ['home'], []);
    expect(filtered).toBe(false);
    const cleared = blockPasses(blk({ task_id: 10 }), eng, [], []);
    expect(cleared).toBe(true);
  });
});

describe('task-block vs container partitioning', () => {
  it('a block_kind="task" WITH a task_id is a task block', () => {
    expect(isTaskBlock(blk({ block_kind: 'task', task_id: 10 }))).toBe(true);
  });

  it('a block_kind="task" WITHOUT a task_id is not a task block (defensive)', () => {
    expect(isTaskBlock(blk({ block_kind: 'task', task_id: undefined }))).toBe(false);
  });

  it('container kinds are never task blocks, even if a task_id is present', () => {
    for (const kind of ['timeblock', 'meeting', 'focus', 'habit', 'break', 'buffer']) {
      expect(isTaskBlock(blk({ block_kind: kind, task_id: 10 }))).toBe(false);
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
