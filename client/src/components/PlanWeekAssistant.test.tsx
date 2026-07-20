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
type ParseResult = { ok: boolean; date: string; pins: { title: string; start_at: string; end_at: string }[]; hints: { kind: string; tag: string; time?: string }[] };
const parseMock = vi.fn(async (_text: string, _date?: string): Promise<ParseResult> => ({ ok: true, date: '2026-07-18', pins: [], hints: [] }));
vi.mock('../lib/api.js', () => ({
  api: {
    planWeek: {
      session: {
        open: (b: string) => openMock(b),
        close: (id: string, p: { status: string }) => closeMock(id, p),
        append: (id: string, m: unknown) => appendMock(id, m),
      },
      parse: (text: string, date?: string) => parseMock(text, date),
    },
  },
}));

const [planWeekModal, setPlanWeekModal] = createSignal<{ open: boolean }>({ open: false });
const toastMock = vi.fn();
const aiAvailableFlag = { current: true };
vi.mock('../stores/index.js', () => ({
  planWeekModal: () => planWeekModal(),
  setPlanWeekModal: (v: { open: boolean }) => setPlanWeekModal(v),
  showToast: (...a: unknown[]) => toastMock(...a),
  aiAvailable: () => aiAvailableFlag.current,
}));

// The shell test is about the SHELL. T3's branch component has its own test file, and
// stubbing it here keeps this file from needing the branch's api/store seams.
// #387: the Fill stub captures the injected BranchProps so tests can drive
// `reportAiUse` (the truthful llm_used seam) without the real branch's api surface,
// and renders a Back button so a branch-switch flow can be driven from it.
const capturedFill: { props?: { reportAiUse: () => void; onBack: () => void } } = {};
vi.mock('./PlanWeekFill.js', () => ({
  PlanWeekFill: (p: { reportAiUse: () => void; onBack: () => void }) => {
    capturedFill.props = p;
    return <div><span>fill-branch</span><button onClick={() => p.onBack()}>Back</button></div>;
  },
}));
vi.mock('./PlanWeekScheduleTasks.js', () => ({ PlanWeekScheduleTasks: () => <div>schedule-branch</div> }));
// This stub exposes the shell's injected onBack, so "Back returns to the menu" still
// proves something real now that each branch owns its own Back control.
vi.mock('./PlanWeekReviewBranch.js', () => ({
  PlanWeekReviewBranch: (p: { onBack: () => void }) => (
    <div><span>review-branch</span><button onClick={() => p.onBack()}>Back</button></div>
  ),
}));

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
    parseMock.mockReset().mockResolvedValue({ ok: true, date: '2026-07-18', pins: [], hints: [] });
    toastMock.mockReset();
    aiAvailableFlag.current = true;
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
    // The branch's component replaced the menu.
    await screen.findByText('review-branch');
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

  /**
   * Going back and choosing again opens a SECOND session. The first must be closed, or it
   * sits `open` with a null ended_at forever and T6's Logs tab fills with rows that never
   * resolve — the zombie-row problem the abandoned status exists to prevent.
   */
  it('abandons the previous session when a second branch is chosen', async () => {
    openMock.mockResolvedValueOnce({ session: { id: 'sess-A' } })
            .mockResolvedValueOnce({ session: { id: 'sess-B' } });
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');

    fireEvent.click(screen.getByText('Review past data'));
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Back'));
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-A', { status: 'abandoned', llm_used: false }));
  });

  /**
   * The signal holds an object, so re-setting it while open is a new reference that
   * re-fires the reset effect. The Focus trigger stays focusable behind the modal, so a
   * stray re-open must NOT discard the branch the user is in.
   */
  it('a redundant open while already open does not reset the in-progress branch', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));
    await screen.findByText('fill-branch');

    setPlanWeekModal({ open: true }); // new object, same state
    await new Promise((r) => setTimeout(r, 50));

    await screen.findByText('fill-branch');                    // still in the branch
    expect(screen.queryByText('Review past data')).toBeNull(); // not back at the menu
    expect(openMock).toHaveBeenCalledTimes(1);                 // and no second session
  });

  it('Back returns to the menu', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');

    fireEvent.click(screen.getByText('Review past data'));
    await screen.findByText('review-branch');

    // Each branch component owns its own Back; the shell's onBack returns to the menu.
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
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'completed', llm_used: false }));
    expect(planWeekModal().open).toBe(false);

    // Reopen and dismiss mid-flow instead.
    closeMock.mockClear();
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');
    fireEvent.click(screen.getByText('Review past data'));
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'abandoned', llm_used: false }));
    expect(planWeekModal().open).toBe(false);
  });

  it('a backdrop click abandons and closes', async () => {
    const { container } = render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    fireEvent.click(container.querySelector('.modal-backdrop')!);
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'abandoned', llm_used: false }));
    expect(planWeekModal().open).toBe(false);
  });

  // ── #387 — truthful llm_used at close ───────────────────────────────────────
  it('close carries llm_used: true after a branch reports AI use', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));
    await screen.findByText('fill-branch');

    capturedFill.props!.reportAiUse();
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-1', { status: 'completed', llm_used: true }));
  });

  it("a branch-switch abandon carries the PREVIOUS session's own flag and resets for the new one", async () => {
    openMock.mockResolvedValueOnce({ session: { id: 'sess-A' } })
            .mockResolvedValueOnce({ session: { id: 'sess-B' } });
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Fill next week');
    fireEvent.click(screen.getByText('Fill next week'));
    await screen.findByText('fill-branch');
    capturedFill.props!.reportAiUse(); // AI ran in sess-A

    fireEvent.click(screen.getByText('Back'));
    await screen.findByText('Review past data');
    fireEvent.click(screen.getByText('Review past data'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-A', { status: 'abandoned', llm_used: true }));

    // The replacement session starts clean — its close must NOT inherit sess-A's usage.
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(closeMock).toHaveBeenCalledWith('sess-B', { status: 'completed', llm_used: false }));
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
    await screen.findByText('review-branch');
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('offline', 'error'));
  });

  it('reopening resets to the menu and drops the previous session id', async () => {
    render(() => <PlanWeekAssistant />);
    setPlanWeekModal({ open: true });
    await screen.findByText('Review past data');
    fireEvent.click(screen.getByText('Review past data'));
    await screen.findByText('review-branch');

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
  beforeEach(() => {
    parseMock.mockReset().mockResolvedValue({ ok: true, date: '2026-07-18', pins: [], hints: [] });
    aiAvailableFlag.current = true;
  });

  it('caps option chips at three even when passed more', () => {
    const opts = ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, onSelect: vi.fn() }));
    const { container } = render(() => <PromptStep question="Q?" options={opts} />);
    const chips = [...container.querySelectorAll('button')].filter((b) => ['a', 'b', 'c', 'd', 'e'].includes(b.textContent!.trim()));
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.textContent!.trim())).toEqual(['a', 'b', 'c']);
  });

  // T8 (#344) — the free-text box has no deterministic fallback, so it renders iff
  // aiAvailable() is true; option chips are unaffected either way.
  it('hides the free-text box when aiAvailable() is false; chips still render', () => {
    aiAvailableFlag.current = false;
    const opts = [{ label: 'a', onSelect: vi.fn() }];
    const { container } = render(() => <PromptStep question="Q?" options={opts} />);
    expect(container.querySelector('input')).toBeNull();
    expect(screen.getByText('a')).toBeTruthy();
  });

  it('Enter parses the typed text and fires onSubmit with the parsed summary, then clears the input', async () => {
    parseMock.mockResolvedValue({ ok: true, date: '2026-07-18', pins: [{ title: 'Dentist', start_at: 'x', end_at: 'y' }], hints: [] });
    const onSubmit = vi.fn();
    const { container } = render(() => <PromptStep question="Q?" onSubmit={onSubmit} />);
    const input = container.querySelector('input')!;

    fireEvent.input(input, { target: { value: 'dentist 2-3pm' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(parseMock).toHaveBeenCalledWith('dentist 2-3pm', undefined));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('"dentist 2-3pm" → 1 pin(s), 0 hint(s)'));
    expect(input.value).toBe('');
  });

  it('a rejected parse shows an inline error, appends nothing, and leaves chips usable', async () => {
    parseMock.mockRejectedValue(new Error('Could not understand the instruction'));
    const onSubmit = vi.fn();
    const opts = [{ label: 'a', onSelect: vi.fn() }];
    const { container } = render(() => <PromptStep question="Q?" options={opts} onSubmit={onSubmit} />);
    const input = container.querySelector('input')!;

    fireEvent.input(input, { target: { value: 'gibberish' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await screen.findByText("Couldn't turn that into a plan change — rephrase or pick an option.");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('a')).toBeTruthy(); // chips untouched
  });

  it('ignores an empty submit (no parse call) and renders Back only when onBack is given', () => {
    const onSubmit = vi.fn();
    const { container, unmount } = render(() => <PromptStep question="Q?" onSubmit={onSubmit} />);
    fireEvent.keyDown(container.querySelector('input')!, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('Back'))).toBe(false);
    unmount();

    const withBack = render(() => <PromptStep question="Q?" onBack={vi.fn()} />);
    expect([...withBack.container.querySelectorAll('button')].some((b) => b.textContent?.includes('Back'))).toBe(true);
  });
});
