import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

/**
 * Phase 7 — the conflict banner and its confirmation.
 *
 * The contract worth pinning at the DOM seam is the negative one: looking at the
 * preview must not move anything, and cancelling must leave the day alone. A feature
 * that reflows a day on its own is worse than one that never offers to.
 */

const conflictsFn = vi.fn();
const previewFn = vi.fn();
const applyFn = vi.fn();
const refetchBlocks = vi.fn();
const refetchTasks = vi.fn();
const refetchDayConflicts = vi.fn();
const showToast = vi.fn();
let conflictList: unknown[] = [];

vi.mock('../lib/api.js', () => ({
  api: {
    dayReflow: {
      conflicts: (...a: unknown[]) => conflictsFn(...a),
      preview: (...a: unknown[]) => previewFn(...a),
      apply: (...a: unknown[]) => applyFn(...a),
    },
  },
}));
vi.mock('../stores/index.js', () => ({
  selectedDay: () => '2026-06-22',
  dayConflicts: () => conflictList,
  refetchDayConflicts: (...a: unknown[]) => refetchDayConflicts(...a),
  refetchBlocks: (...a: unknown[]) => refetchBlocks(...a),
  refetchTasks: (...a: unknown[]) => refetchTasks(...a),
  showToast: (...a: unknown[]) => showToast(...a),
}));

const { DayReflowBanner } = await import('./DayReflowBanner.js');

const conflict = (id: string, title: string) => ({
  block_id: id, task_id: `t-${id}`, title,
  start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T17:00:00.000Z',
  directions: ['work'], is_locked: false,
});

const proposal = (over: Record<string, unknown> = {}) => ({
  date: '2026-06-22', day_type: 'light',
  moves: [], unschedule: [], kept_locked: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  conflictList = [];
  applyFn.mockResolvedValue({ moved: 1, unscheduled: 0, restaged: 0 });
  previewFn.mockResolvedValue(proposal());
});

describe('DayReflowBanner — the offer', () => {
  it('renders nothing when the day has no conflicts', () => {
    const { container } = render(() => <DayReflowBanner />);
    expect(container.textContent).toBe('');
  });

  it('states how many tasks fall outside the day’s windows', () => {
    conflictList = [conflict('b1', 'Write spec'), conflict('b2', 'Review')];
    const { container } = render(() => <DayReflowBanner />);
    expect(container.textContent).toContain('2 tasks fall outside');
  });

  it('is singular for one', () => {
    conflictList = [conflict('b1', 'Write spec')];
    const { container } = render(() => <DayReflowBanner />);
    expect(container.textContent).toContain('1 task falls outside');
  });

  it('does not preview or apply anything just by rendering', () => {
    conflictList = [conflict('b1', 'Write spec')];
    render(() => <DayReflowBanner />);
    expect(previewFn).not.toHaveBeenCalled();
    expect(applyFn).not.toHaveBeenCalled();
  });
});

describe('DayReflowBanner — the preview', () => {
  beforeEach(() => { conflictList = [conflict('b1', 'Write spec')]; });

  it('lists every move and every unschedule', async () => {
    previewFn.mockResolvedValue(proposal({
      moves: [{
        block_id: 'b1', task_id: 't1', title: 'Write spec',
        from: { start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T17:00:00.000Z' },
        to: { start_at: '2026-06-22T10:00:00.000Z', end_at: '2026-06-22T11:00:00.000Z' },
      }],
      unschedule: [{ block_id: 'b2', task_id: 't2', title: 'Review notes', reason: 'no_room' }],
    }));
    const { getByText, container } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => expect(container.textContent).toContain('Write spec'));
    expect(container.textContent).toContain('Review notes');
    expect(container.textContent).toMatch(/won't fit/i);
  });

  it('names the locked blocks it is leaving alone', async () => {
    previewFn.mockResolvedValue(proposal({ kept_locked: [conflict('b9', 'Pinned thing')] }));
    const { getByText, container } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => expect(container.textContent).toContain('Pinned thing'));
    expect(container.textContent).toMatch(/staying put/i);
  });

  it('opening the preview mutates NOTHING', async () => {
    const { getByText } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => expect(previewFn).toHaveBeenCalledWith('2026-06-22'));
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('cancelling leaves the day untouched', async () => {
    const { getByText } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => getByText('Cancel'));
    fireEvent.click(getByText('Cancel'));
    expect(applyFn).not.toHaveBeenCalled();
    expect(refetchBlocks).not.toHaveBeenCalled();
  });

  it('cannot be confirmed when there is nothing it can do', async () => {
    previewFn.mockResolvedValue(proposal({ kept_locked: [conflict('b9', 'Pinned')] }));
    const { getByText } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => getByText('Confirm'));
    expect((getByText('Confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DayReflowBanner — the confirmation', () => {
  beforeEach(() => { conflictList = [conflict('b1', 'Write spec')]; });

  it('applies only on Confirm, then refreshes the day', async () => {
    previewFn.mockResolvedValue(proposal({
      moves: [{
        block_id: 'b1', task_id: 't1', title: 'Write spec',
        from: { start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T17:00:00.000Z' },
        to: { start_at: '2026-06-22T10:00:00.000Z', end_at: '2026-06-22T11:00:00.000Z' },
      }],
    }));
    const { getByText } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => getByText('Confirm'));
    fireEvent.click(getByText('Confirm'));

    await waitFor(() => expect(applyFn).toHaveBeenCalledWith('2026-06-22'));
    await waitFor(() => expect(refetchBlocks).toHaveBeenCalled());
    expect(refetchDayConflicts).toHaveBeenCalled();
  });

  it('surfaces a failure instead of pretending it worked', async () => {
    previewFn.mockResolvedValue(proposal({
      moves: [{
        block_id: 'b1', task_id: 't1', title: 'Write spec',
        from: { start_at: '2026-06-22T16:00:00.000Z', end_at: '2026-06-22T17:00:00.000Z' },
        to: { start_at: '2026-06-22T10:00:00.000Z', end_at: '2026-06-22T11:00:00.000Z' },
      }],
    }));
    applyFn.mockRejectedValue(new Error('boom'));
    const { getByText } = render(() => <DayReflowBanner />);
    fireEvent.click(getByText('Reflow…'));
    await waitFor(() => getByText('Confirm'));
    fireEvent.click(getByText('Confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('boom', 'error'));
  });
});
