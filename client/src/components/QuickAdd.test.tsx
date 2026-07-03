import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

/**
 * QuickAdd — DOM-level proof of the contract the Today view mounts it on
 * (component existed but was rendered nowhere until Today wired it in):
 * Enter sends the text to /tasks/quick, a success refetches the tasks store,
 * fires `onAdded` (Today refreshes its summary resource + flight-plan off it)
 * and clears the input; a failure surfaces a toast and fires NO onAdded.
 *
 * SEAMS mocked: `../lib/api.js` (api.tasks.quick — no network) and
 * `../stores/index.js` (refetchTasks + showToast spies).
 */

const quickMock = vi.fn(async (_t: string): Promise<{ llm: boolean }> => ({ llm: false }));
vi.mock('../lib/api.js', () => ({ api: { tasks: { quick: (t: string) => quickMock(t) } } }));

const refetchTasksMock = vi.fn();
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  refetchTasks: () => refetchTasksMock(),
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { QuickAdd } = await import('./QuickAdd.js');

describe('QuickAdd — quick task entry', () => {
  beforeEach(() => {
    quickMock.mockReset().mockResolvedValue({ llm: false });
    refetchTasksMock.mockReset();
    toastMock.mockReset();
  });

  it('Enter creates via /tasks/quick, refetches tasks, fires onAdded, clears the input', async () => {
    const onAdded = vi.fn();
    const { container } = render(() => <QuickAdd onAdded={onAdded} />);
    const input = container.querySelector('input')!;

    fireEvent.input(input, { target: { value: 'pay invoice fri 3pm #finance ~20m' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(quickMock).toHaveBeenCalledWith('pay invoice fri 3pm #finance ~20m'));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(refetchTasksMock).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(toastMock).toHaveBeenCalledWith('Task added', 'success');
  });

  it('does nothing on empty input, and a failed add toasts an error without onAdded', async () => {
    const onAdded = vi.fn();
    const { container } = render(() => <QuickAdd onAdded={onAdded} />);
    const input = container.querySelector('input')!;

    // Empty → no call at all.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(quickMock).not.toHaveBeenCalled();

    // Failure → error toast, no onAdded, text kept for retry.
    quickMock.mockRejectedValueOnce(new Error('parse failed'));
    fireEvent.input(input, { target: { value: 'do the thing' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('parse failed', 'error'));
    expect(onAdded).not.toHaveBeenCalled();
    expect(input.value).toBe('do the thing');
  });
});
