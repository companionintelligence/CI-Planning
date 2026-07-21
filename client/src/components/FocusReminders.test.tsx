import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { Reminder, Task } from '../lib/api.js';

/**
 * FocusReminders (#388) — the contracts worth pinning:
 *   1. create sends { taskId, date, time } — NEVER a client-composed fireAt (the
 *      server resolves the owner's timezone);
 *   2. zero reminders → only the "Add reminder" pill (no empty-state chrome);
 *   3. fired rows dim, auto rows badge; delete refetches (404 silently).
 *
 * SEAMS mocked per the DayStarsRow pattern: real Solid signals inside the store
 * mock so the component actually re-renders; api mocked before the dynamic import.
 */

const createMock = vi.fn(async (_b: unknown) => ({ reminder: { id: 'r-new' } }));
const removeMock = vi.fn(async (_id: string) => ({ ok: true }));
vi.mock('../lib/api.js', () => ({
  api: { reminders: { create: (b: unknown) => createMock(b), remove: (id: string) => removeMock(id) } },
}));

const [remindersSig, setRemindersSig] = createSignal<Reminder[]>([]);
const [tasksSig, setTasksSig] = createSignal<Task[]>([]);
const refetchRemindersMock = vi.fn();
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  reminders: () => remindersSig(),
  refetchReminders: () => refetchRemindersMock(),
  tasks: () => tasksSig(),
  taskOf: (id: string) => tasksSig().find((t) => t.id === id),
  blocks: () => [],
  showToast: (...a: unknown[]) => toastMock(...a),
}));
vi.mock('../lib/dates.js', () => ({ localISODate: () => '2026-07-19' }));

const { FocusReminders } = await import('./FocusReminders.js');

const REM = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1', task_id: 't1', block_id: null, fire_at: '2026-07-19T16:00:00.000Z',
  status: 'pending', fired_at: null, source: 'manual', ...over,
});
// Backlog-3 (2026-07-21): the picker offers TODAY's tasks only — the fixture must be
// scheduled for the mocked today or it drops out of the candidate list.
const TASK = { id: 't1', title: 'Write report', status: 'open', scheduled_for: '2026-07-19' } as unknown as Task;

describe('FocusReminders — list, create, delete', () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ reminder: { id: 'r-new' } });
    removeMock.mockReset().mockResolvedValue({ ok: true });
    refetchRemindersMock.mockReset();
    toastMock.mockReset();
    setRemindersSig([]);
    setTasksSig([TASK]);
  });

  it('zero reminders → only the Add-reminder pill renders (no card chrome)', () => {
    const { container } = render(() => <FocusReminders />);
    expect(screen.getByText('Add reminder')).toBeTruthy();
    expect(screen.queryByText('Reminders')).toBeNull(); // no eyebrow, no empty card
    expect(container.querySelectorAll('.rounded-2xl')).toHaveLength(0);
  });

  it('rows render with resolved titles; fired dims; auto badges with the re-derive tooltip', () => {
    setRemindersSig([
      REM(),
      REM({ id: 'r2', status: 'fired', fired_at: '2026-07-19T15:00:00.000Z' }),
      REM({ id: 'r3', source: 'auto' }),
    ]);
    const { container } = render(() => <FocusReminders />);

    expect(screen.getAllByText('Write report')).toHaveLength(3);
    expect(container.querySelectorAll('.opacity-50')).toHaveLength(1); // the fired row only
    const badge = screen.getByText('auto');
    expect(badge.getAttribute('title')).toMatch(/re-created when the task changes/);
  });

  it('create sends { taskId, date, time } — no fireAt key — then refetches and collapses', async () => {
    const { container } = render(() => <FocusReminders />);
    fireEvent.click(screen.getByText('Add reminder'));

    fireEvent.change(container.querySelector('select')!, { target: { value: 't1' } });
    fireEvent.input(container.querySelector('input[type=time]')!, { target: { value: '14:30' } });
    fireEvent.click(screen.getByText('Remind me'));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ taskId: 't1', date: '2026-07-19', time: '14:30' }));
    expect('fireAt' in (createMock.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
    await waitFor(() => expect(refetchRemindersMock).toHaveBeenCalled());
    expect(screen.queryByText('Remind me')).toBeNull(); // form collapsed back to the pill
  });

  it("a 422 surfaces the server's message via toast and keeps the form open", async () => {
    createMock.mockRejectedValue(new Error('fireAt (UTC ISO) or date+time is required'));
    const { container } = render(() => <FocusReminders />);
    fireEvent.click(screen.getByText('Add reminder'));
    fireEvent.change(container.querySelector('select')!, { target: { value: 't1' } });
    fireEvent.click(screen.getByText('Remind me'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('fireAt (UTC ISO) or date+time is required', 'error'));
    expect(screen.getByText('Remind me')).toBeTruthy();
  });

  it('delete calls remove + refetch; an already-gone reminder refetches silently', async () => {
    setRemindersSig([REM()]);
    render(() => <FocusReminders />);
    fireEvent.click(screen.getByTitle('Delete reminder'));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(refetchRemindersMock).toHaveBeenCalled());

    removeMock.mockRejectedValue(new Error('not found'));
    refetchRemindersMock.mockReset();
    fireEvent.click(screen.getByTitle('Delete reminder'));
    await waitFor(() => expect(refetchRemindersMock).toHaveBeenCalled());
    expect(toastMock).not.toHaveBeenCalled();
  });
});
