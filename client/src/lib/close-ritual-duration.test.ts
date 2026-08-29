import { describe, it, expect } from 'vitest';
import { defaultDuration, pickBlock } from './close-ritual-duration.js';
import type { Block, Task } from './api.js';

/**
 * The owner's duration rule (0161), pinned:
 *
 *   "The default end time should be when the completion modal launches, if the time is
 *    less than the allocated task time, and it should be the allocated task time when
 *    the completion modal is launched after the end of task time."
 *
 * i.e. end = min(now, block.end_at). The asymmetry matters — neither finishing early nor
 * finishing late may inflate the number, because this figure feeds estimate-bias
 * calibration and a default that drifts high teaches the scheduler to over-allocate.
 *
 * TZ is pinned to America/Los_Angeles by the vitest unit project, so 21:00Z = 14:00 local.
 */

const START = '2026-08-29T21:00:00.000Z'; // 14:00 local
const END = '2026-08-29T22:00:00.000Z';   // 15:00 local — a 60 minute allocation
const at = (iso: string) => Date.parse(iso);

const block = (over: Partial<Block> = {}): Block =>
  ({ id: 'b1', task_id: 't1', title: 'Work', block_kind: 'task', start_at: START, end_at: END, all_day: false, ...over }) as Block;

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't1', title: 'Work', estimated_minutes: 45, actual_minutes: 0, ...over }) as Task;

describe('defaultDuration — the min(now, allocated end) rule', () => {
  it('credits start → now when the sheet opens inside the block', () => {
    const d = defaultDuration(task(), block(), at('2026-08-29T21:35:00.000Z'));
    expect(d.minutes).toBe(35);
    expect(d.basis).toBe('block-partial');
  });

  it('caps at the allocated end when the sheet opens after it', () => {
    const d = defaultDuration(task(), block(), at('2026-08-29T23:30:00.000Z'));
    expect(d.minutes).toBe(60); // NOT 150 — the extra 90 minutes were never allocated
    expect(d.basis).toBe('block-full');
  });

  it('treats the exact end instant as the full block', () => {
    const d = defaultDuration(task(), block(), at(END));
    expect(d.minutes).toBe(60);
    expect(d.basis).toBe('block-full');
  });

  // Not in the owner's spec: min(now, end) − start would be negative here. The allocated
  // time demonstrably was not used, so there is nothing to credit from the block — and a 0
  // would read as "this took no time" rather than "we don't know".
  it('falls back to the estimate when completed before the block even starts', () => {
    const d = defaultDuration(task(), block(), at('2026-08-29T20:00:00.000Z'));
    expect(d.minutes).toBe(45);
    expect(d.basis).toBe('estimate');
  });

  it('ignores an all-day block — it has no clock span to measure', () => {
    const d = defaultDuration(task(), null, at('2026-08-29T21:35:00.000Z'));
    expect(d.basis).toBe('estimate');
  });

  it('prefers a real timer reading over the estimate when unscheduled', () => {
    const d = defaultDuration(task({ actual_minutes: 22 }), null, at(END));
    expect(d.minutes).toBe(22);
    expect(d.basis).toBe('timer');
  });

  it('falls back to the estimate with no block and no timer', () => {
    const d = defaultDuration(task(), null, at(END));
    expect(d.minutes).toBe(45);
    expect(d.basis).toBe('estimate');
  });

  it('says so rather than inventing a number when there is nothing at all', () => {
    const d = defaultDuration(task({ estimated_minutes: 0, actual_minutes: 0 }), null, at(END));
    expect(d.minutes).toBe(0);
    expect(d.basis).toBe('none');
  });

  // The block wins over the timer: the timer is task-wide (a SUM across sessions), so on a
  // multi-session task it would over-credit the one session just finished.
  it('a block outranks the timer', () => {
    const d = defaultDuration(task({ actual_minutes: 500 }), block(), at('2026-08-29T21:30:00.000Z'));
    expect(d.minutes).toBe(30);
  });
});

describe('pickBlock', () => {
  const early = block({ id: 'early', start_at: '2026-08-29T15:00:00.000Z', end_at: '2026-08-29T16:00:00.000Z' });
  const late = block({ id: 'late', start_at: START, end_at: END });

  it('honours the block the completion came from', () => {
    expect(pickBlock([early, late], 't1', at(START), 'early')?.id).toBe('early');
  });

  it('picks the block containing now', () => {
    expect(pickBlock([early, late], 't1', at('2026-08-29T21:30:00.000Z'))?.id).toBe('late');
  });

  it('picks the latest already-started block when now is in no block', () => {
    expect(pickBlock([early, late], 't1', at('2026-08-29T23:00:00.000Z'))?.id).toBe('late');
  });

  it('falls back to the earliest placement when nothing has started', () => {
    expect(pickBlock([early, late], 't1', at('2026-08-29T10:00:00.000Z'))?.id).toBe('early');
  });

  it('ignores all-day blocks and other tasks', () => {
    const allDay = block({ id: 'ad', all_day: true });
    const other = block({ id: 'other', task_id: 't2' });
    expect(pickBlock([allDay, other], 't1', at(START))).toBeNull();
  });
});
