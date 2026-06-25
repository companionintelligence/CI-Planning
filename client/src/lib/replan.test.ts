import { describe, it, expect } from 'vitest';
import { replanToastMessage } from './replan.js';
import type { ReplanDiff } from './api.js';

const diff = (over: Partial<ReplanDiff> = {}): ReplanDiff => ({
  reason: 'task:updated',
  moved: [],
  removed: [],
  added: [],
  unplaced: [],
  ...over,
});
const move = (id: string) => ({
  block_id: id,
  task_id: `t-${id}`,
  before: { start_at: '2026-06-24T09:00:00Z', end_at: '2026-06-24T10:00:00Z' },
  after: { start_at: '2026-06-24T10:00:00Z', end_at: '2026-06-24T11:00:00Z' },
});

describe('replanToastMessage', () => {
  it('returns null when nothing changed (low-noise — no toast on a no-op reflow)', () => {
    expect(replanToastMessage(diff())).toBeNull();
  });

  it('singular phrasing for one moved block', () => {
    expect(replanToastMessage(diff({ moved: [move('a')] }))).toBe('Re-planned: 1 block moved');
  });

  it('plural phrasing for several moved blocks', () => {
    expect(replanToastMessage(diff({ moved: [move('a'), move('b'), move('c')] }))).toBe('Re-planned: 3 blocks moved');
  });

  it('headline counts moves; removed/added alone show the generic message', () => {
    expect(replanToastMessage(diff({ removed: [{ block_id: 'x', task_id: 't' }] }))).toBe('Re-planned');
    expect(replanToastMessage(diff({ added: [{ block_id: 'y', task_id: 't' }] }))).toBe('Re-planned');
  });

  it('moved drives the headline even when removed/added are also present', () => {
    expect(
      replanToastMessage(diff({ moved: [move('a')], removed: [{ block_id: 'x', task_id: 't' }], added: [{ block_id: 'y', task_id: 't' }] })),
    ).toBe('Re-planned: 1 block moved');
  });

  it('unplaced alone does not trigger a toast', () => {
    expect(replanToastMessage(diff({ unplaced: ['t1', 't2'] }))).toBeNull();
  });

  it('tolerates a legacy/diff-less payload without throwing (returns null)', () => {
    // The legacy runScheduler path broadcast a ScheduleResult: no moved/removed/added arrays.
    const legacy = { date: '2026-06-24', blocksCreated: 4, blocksRemoved: 1, tasksScheduled: 3 };
    expect(replanToastMessage(legacy)).toBeNull();
  });

  it('tolerates null / undefined / non-object payloads', () => {
    expect(replanToastMessage(null)).toBeNull();
    expect(replanToastMessage(undefined)).toBeNull();
    expect(replanToastMessage('garbage')).toBeNull();
    expect(replanToastMessage({ moved: 'not-an-array' })).toBeNull();
  });
});
