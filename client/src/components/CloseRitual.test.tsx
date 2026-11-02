import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor, cleanup } from '@solidjs/testing-library';
import type { Block, Task } from '../lib/api.js';

/**
 * CloseRitual and the duration it records.
 *
 * The field is PRE-FILLED from the block the work was allocated (or the timer, or the
 * estimate), but that number is derived from the schedule: the block was sized from the
 * estimate. Sending it as the actual would feed the plan back into estimate calibration
 * as if it were measured. So the contract pinned here is:
 *   1. an untouched pre-fill is shown but NOT sent;
 *   2. a number the owner typed IS sent, even if it equals the pre-fill;
 *   3. a timed run keeps its measured value (nothing is sent over it);
 *   4. the sheet says which it is, so the owner is never guessing.
 */

const closeMock = vi.fn(async (_id: string, _body: Record<string, unknown>) => ({ task: {}, closed: {} }));
vi.mock('../lib/api.js', () => ({
  api: { tasks: { close: (id: string, body: Record<string, unknown>) => closeMock(id, body) } },
  DECLINED_SCORE: 0,
}));

const blocksBox = { current: [] as Block[] };
vi.mock('../stores/index.js', () => ({
  blocks: () => blocksBox.current,
  refetchTasks: vi.fn(),
  showToast: vi.fn(),
}));

import { CloseRitual } from './CloseRitual.js';

// 17:00-18:00Z block (a 60 minute allocation); the sheet opens an hour after it ends, so the
// pre-fill is the whole block, 60 minutes, basis 'block-full'.
const BLOCK = { id: 'b1', task_id: 't1', title: 'Write', block_kind: 'task', all_day: false,
  start_at: '2026-11-02T17:00:00.000Z', end_at: '2026-11-02T18:00:00.000Z' } as Block;
const NOW = Date.parse('2026-11-02T19:00:00.000Z');

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't1', title: 'Write the draft', estimated_minutes: 60, actual_minutes: 0, ...over }) as Task;

function open(t: Task) {
  render(() => <CloseRitual task={t} remaining={0} onAdvance={() => {}} onSkipAll={() => {}} nowMs={NOW} />);
}

const lastBody = () => closeMock.mock.calls.at(-1)![1];

beforeEach(() => {
  cleanup();
  closeMock.mockClear();
  blocksBox.current = [BLOCK];
});

describe('CloseRitual — which minutes get recorded', () => {
  it('shows the schedule-derived pre-fill but does not send it when the field is untouched', async () => {
    open(task());
    expect(screen.getByDisplayValue('60')).toBeTruthy();       // the suggestion is visible…
    fireEvent.click(screen.getByTitle('Good'));
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ score: 5 });                   // …but not recorded
    expect(lastBody()).not.toHaveProperty('actual_minutes');
  });

  it('sends the number the owner typed', async () => {
    open(task());
    fireEvent.input(screen.getByDisplayValue('60'), { target: { value: '95' } });
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ actual_minutes: 95 });
  });

  it('counts typing the pre-filled number back as an answer', async () => {
    open(task());
    fireEvent.input(screen.getByDisplayValue('60'), { target: { value: '60' } });
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ actual_minutes: 60 });
  });

  it('keeps a timed run\'s measured value: nothing is sent over it', async () => {
    blocksBox.current = [];                                     // no block, so the timer is the basis
    open(task({ actual_minutes: 40 }));
    expect(screen.getByDisplayValue('40')).toBeTruthy();
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).not.toHaveProperty('actual_minutes');
  });

  it('a note on its own sends no minutes either', async () => {
    open(task());
    fireEvent.input(screen.getByPlaceholderText(/what made it easy or hard/i), { target: { value: 'went fine' } });
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ note: 'went fine' });
  });

  it('Skip records the decline and no minutes', async () => {
    open(task());
    fireEvent.click(screen.getByText('Skip'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({ score: 0 });
  });
});

describe('CloseRitual — the sheet says what will be recorded', () => {
  it('tells the owner an untouched pre-fill is recorded only if changed', () => {
    open(task());
    expect(screen.getByText(/recorded only if you change it/i)).toBeTruthy();
  });

  it('drops that line once the owner edits the field', () => {
    open(task());
    fireEvent.input(screen.getByDisplayValue('60'), { target: { value: '30' } });
    expect(screen.queryByText(/recorded only if you change it/i)).toBeNull();
  });

  it('does not say it for a timed run: that value is already recorded', () => {
    blocksBox.current = [];
    open(task({ actual_minutes: 40 }));
    expect(screen.getByText(/from the timer/i)).toBeTruthy();
    expect(screen.queryByText(/recorded only if you change it/i)).toBeNull();
  });
});
