import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * PlanWeekAssistant (T2) — DOM-level proof of the shell contract T3/T4/T5 build on:
 * the fixed top-3 menu, the step machine, and the session bracketing.
 *
 * The session-open timing here differs from the ticket's DoD on purpose — see the
 * component's header comment. `entry_branch` is required by T1, so the session opens on
 * the branch pick, not on the modal's false→true edge. These tests pin that behavior.
 *
 * SEAMS mocked: `../lib/api.js` (planWeek.session.* — no network) and
 * `../stores/index.js` (a real signal for the modal + a showToast spy).
 */

const openMock = vi.fn(async (_b: string) => ({ session: { id: 'sess-1' } }));
const closeMock = vi.fn(async (_id: string, _p: { status: string }) => ({ session: { id: 'sess-1' } }));
const appendMock = vi.fn(async (_id: string, _m: unknown) => ({ session: { id: 'sess-1' } }));
vi.mock('../lib/api.js', () => ({
  api: {
    planWeek: {
      session: {
        open: (b: string) => openMock(b),
        close: (id: string, p: { status: string }) => closeMock(id, p),
        append: (id: string, m: unknown) => appendMock(id, m),
      },
    },
  },
}));

const [planWeekModal, setPlanWeekModal] = createSignal<{ open: boolean }>({ open: false });
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  planWeekModal: () => planWeekModal(),
  setPlanWeekModal: (v: { open: boolean }) => setPlanWeekModal(v),
  showToast: (...a: unknown[]) => toastMock(...a),
}));

// The shell test is about the SHELL. T3's branch component has its own test file, and
// stubbing it here keeps this file from needing the branch's api/store seams.
vi.mock('./PlanWeekFill.js', () => ({ PlanWeekFill: () => <div>fill-branch</div> }));
vi.mock('./PlanWeekScheduleTasks.js', () => ({ PlanWeekScheduleTasks: () => <div>schedule-branch</div> }));

const { PlanWeekAssistant, PromptStep } = await import('./PlanWeekAssistant.js');

const LABELS = ['Fill next week', 'Schedule tasks', 'Review past data'];
/** Menu buttons render label + subtitle, so match on containment, not equality. */
const menuLabels = (root: ParentNode) =>
  LABELS.filter((l) => [...root.querySelectorAll('button')].some((b) => b.textContent?.includes(l)));

describe('PlanWeekAssistant — the shell', () => {
  beforeEach(() => {
    openMock.mockReset().mockResolvedValue({ session: { id: 'sess-1' } });
    closeMock.mockReset().mockResolvedValue({ session: { id: 'sess-1' } });
    appendMock.mockReset().mockResolvedValue({ session: { id: 'sess-1' } });
    toastMock.mockReset();
    setPlanWeekModal({ open: false });
  });

  it('renders nothing while closed, and the fixed top-3 menu when opened', async () => {
    const { container } = render(() => <PlanWeekAssistant />);
    expect(container.querySelector('.modal-backdrop')).toBeNull();

    setPlanWeekModal({ open: true });
    await waitFor(() => expect(container.querySelector('.modal-backdrop')).not.toBeNull());

    // Exactly these three, in this order.
    expect(menuLabels(container)).toEqual(LABELS);

    // No session until a branch is chosen — the menu itself has no entry_branch to send.
    expect(openMock).not.toHaveBeenCalled();
  });

  it('picking a branch opens the session with that entry_branch and advances the step', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');

    fireEvent.click(screen.getByText('Review past data'));

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    expect(openMock).toHaveBeenCalledWith('review');
    // The branch question replaced the menu.
    await screen.findByText('What would you like to review?');
    expect(screen.queryByText('Fill next week')).toBeNull();
    // The choice is logged to the transcript.
    await waitFor(() => expect(appendMock).toHaveBeenCalledWith('sess-1', { role: 'user', text: 'Review past data', kind: 'plan_week:review' }));
  });

  it('a branch with a component renders it instead of a PromptStep (T3 slot)', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');

    fireEvent.click(screen.getByText('Fill next week'));

    await screen.findByText('fill-branch');      // the registered component, not a stub
    expect(openMock).toHaveBeenCalledWith('fill_week');
    expect(screen.queryByText('Or type your answer…')).toBeNull(); // no PromptStep input
  });

  it('Back returns to the menu', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');

    fireEvent.click(screen.getByText('Review past data'));
    await screen.findByText('What would you like to review?');

    fireEvent.click(screen.getByText('Back'));
    await screen.findByText('Schedule tasks'); // menu is back
  });

  it('Done closes the session as completed; the X abandons it', async () => {
    render(() => <PlanWeekAssistant />);

    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'completed' }));
    expect(planWeekModal().open).toBe(false);

    // Reopen and dismiss mid-flow instead.
    closeMock.mockClear();
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');
    fireEvent.click(screen.getByText('Review past data'));
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'abandoned' }));
    expect(planWeekModal().open).toBe(false);
  });

  it('a backdrop click abandons and closes', async () => {
    const { container } = render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    fireEvent.click(container.querySelector('.modal-backdrop')!);
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'abandoned' }));
    expect(planWeekModal().open).toBe(false);
  });

  it('dismissing from the menu writes no session at all', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');

    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(planWeekModal().open).toBe(false));
    expect(openMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('a rejected session.open still advances the shell and toasts', async () => {
    openMock.mockRejectedValueOnce(new Error('offline'));
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');

    fireEvent.click(screen.getByText('Review past data'));

    // The user is not stranded on the menu by a failed log write.
    await screen.findByText('What would you like to review?');
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('offline', 'error'));
  });

  it('reopening resets to the menu and drops the previous session id', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');
    fireEvent.click(screen.getByText('Review past data'));
    await screen.findByText('What would you like to review?');

    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(planWeekModal().open).toBe(false));

    closeMock.mockClear();
    setPlanWeekModal({ open: true });
    await screen.findByText('Schedule tasks'); // back at the menu, not the old branch

    // No stale id: dismissing without picking closes nothing server-side.
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(planWeekModal().open).toBe(false));
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe('PromptStep — the reusable primitive', () => {
  it('caps option chips at three even when passed more', () => {
    const opts = ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, onSelect: vi.fn() }));
    const { container } = render(() => <PromptStep question="Q?" options={opts} />);
    const chips = [...container.querySelectorAll('button')].filter((b) => ['a', 'b', 'c', 'd', 'e'].includes(b.textContent!.trim()));
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.textContent!.trim())).toEqual(['a', 'b', 'c']);
  });

  it('Enter fires onSubmit with the typed text and clears the input', async () => {
    const onSubmit = vi.fn();
    const { container } = render(() => <PromptStep question="Q?" onSubmit={onSubmit} />);
    const input = container.querySelector('input')!;

    fireEvent.input(input, { target: { value: 'next monday' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('next monday'));
    expect(input.value).toBe('');
  });

  it('ignores an empty submit and renders Back only when onBack is given', () => {
    const onSubmit = vi.fn();
    const { container, unmount } = render(() => <PromptStep question="Q?" onSubmit={onSubmit} />);
    fireEvent.keyDown(container.querySelector('input')!, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Back'))).toBe(false);
    unmount();

    const withBack = render(() => <PromptStep question="Q?" onBack={vi.fn()} />);
    expect([...withBack.container.querySelectorAll('button')].some((b) => b.textContent?.includes('Back'))).toBe(true);
  });
});
