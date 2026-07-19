import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';

/**
 * PlanWeekScheduleTasks (T4) — the deterministic one-task-at-a-time branch.
 *
 * The two contracts worth pinning are both about HONESTY:
 *   1. manual Set only DATES a task (server-verified: syncBlockFromTask no-ops without an
 *      existing block), so its transcript line must not claim a calendar block;
 *   2. "placed" is derived from the task's ABSENCE in the post-run flight_plan, never from
 *      the aggregate `result.placed`, which can count other pre-staged items.
 *
 * SEAMS mocked: `../lib/api.js` and `../stores/index.js`, per the QuickAdd/TaskCard idiom.
 */

const listMock = vi.fn(async (_p?: unknown) => ({ tasks: [] as unknown[] }));
const updateMock = vi.fn(async (_id: string, _b: unknown) => ({ task: {} }));
const addTaskMock = vi.fn(async (_id: string) => ({ flight_plan: [{ task_id: 't1', selected: true }], added: 1 }));
const fpUpdateMock = vi.fn(async (_id: string, _b: unknown) => ({ flight_plan: [] }));
const runMock = vi.fn(async (_b?: unknown) => ({ result: { placed: 1 }, flight_plan: [] as { task_id: string }[] }));
const nextStepMock = vi.fn(async (_input?: unknown): Promise<{ question: string; options: string[]; source: 'model' | 'fallback' }> => ({
  question: 'Which task should I find time for?',
  options: [],
  source: 'fallback',
}));
vi.mock('../lib/api.js', () => ({
  api: {
    tasks: { list: (p?: unknown) => listMock(p), update: (id: string, b: unknown) => updateMock(id, b) },
    flightPlan: { addTask: (id: string) => addTaskMock(id), update: (id: string, b: unknown) => fpUpdateMock(id, b) },
    auto: { run: (b?: unknown) => runMock(b) },
    planWeek: { nextStep: (input?: unknown) => nextStepMock(input) },
  },
}));

const toastMock = vi.fn();
const stagedIds = { current: new Set<string>() };
const aiAvailableFlag = { current: false };
vi.mock('../stores/index.js', () => ({
  showToast: (...a: unknown[]) => toastMock(...a),
  selectedDay: () => '2026-07-18',
  flightPlanTaskIds: () => stagedIds.current,
  aiAvailable: () => aiAvailableFlag.current,
  refetchFlightPlan: vi.fn(),
  refetchBlocks: vi.fn(),
  refetchTasks: vi.fn(),
}));

vi.mock('../lib/dates.js', () => ({ localISODate: () => '2026-07-18' }));

const { PlanWeekScheduleTasks } = await import('./PlanWeekScheduleTasks.js');

const appendMock = vi.fn(async (_t: string, _k?: string) => {});
const onBackMock = vi.fn();
const mount = () => render(() => <PlanWeekScheduleTasks append={appendMock} onBack={onBackMock} />);

const PLAIN = { id: 't1', title: 'Pay invoices', estimated_minutes: 30 };

describe('PlanWeekScheduleTasks — deterministic one-at-a-time placement', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue({ tasks: [PLAIN] });
    updateMock.mockReset().mockResolvedValue({ task: {} });
    addTaskMock.mockReset().mockResolvedValue({ flight_plan: [{ task_id: 't1', selected: true }], added: 1 });
    fpUpdateMock.mockReset().mockResolvedValue({ flight_plan: [] });
    runMock.mockReset().mockResolvedValue({ result: { placed: 1 }, flight_plan: [] });
    nextStepMock.mockReset().mockResolvedValue({
      question: 'Which task should I find time for?', options: [], source: 'fallback',
    });
    appendMock.mockReset(); onBackMock.mockReset(); toastMock.mockReset();
    stagedIds.current = new Set();
    aiAvailableFlag.current = false;
  });

  it('lists only undated, non-habit, non-recurring, unstaged open tasks', async () => {
    stagedIds.current = new Set(['t5']);
    listMock.mockResolvedValue({ tasks: [
      PLAIN,
      { id: 't2', title: 'Already dated', scheduled_for: '2026-07-20' },
      { id: 't3', title: 'A habit', is_habit: true },
      { id: 't4', title: 'An instance', recurrence_parent_id: 'tpl' },
      { id: 't5', title: 'Already staged' },
      { id: 't6', title: 'A template', recurrence_rule: 'FREQ=DAILY' },
    ] });

    mount();
    await screen.findByText('Pay invoices');
    for (const hidden of ['Already dated', 'A habit', 'An instance', 'Already staged', 'A template']) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
  });

  it('shows an empty state with a way out when nothing is schedulable', async () => {
    listMock.mockResolvedValue({ tasks: [] });
    mount();
    await screen.findByText(/Nothing to schedule/);
    fireEvent.click(screen.getByText('Back to menu'));
    expect(onBackMock).toHaveBeenCalled();
  });

  it('manual Set dates the task and never claims a calendar block', async () => {
    mount();
    fireEvent.click(await screen.findByText('Pay invoices'));

    const time = document.querySelector('input[type=time]') as HTMLInputElement;
    fireEvent.input(time, { target: { value: '09:30' } });
    fireEvent.click(screen.getByText('Set'));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('t1', { scheduled_for: '2026-07-18', task_time: '09:30' }));
    await waitFor(() => expect(appendMock).toHaveBeenCalledTimes(1));
    const [text, kind] = appendMock.mock.calls[0];
    expect(kind).toBe('plan_week:schedule_set');
    expect(text).toContain('Scheduled');
    expect(text).not.toMatch(/placed|block/i);   // the honesty rule
  });

  it('manual Set with no time sends explicit null, not undefined', async () => {
    mount();
    fireEvent.click(await screen.findByText('Pay invoices'));
    fireEvent.click(screen.getByText('Set'));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const body = updateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body.task_time).toBeNull();
    expect('task_time' in body).toBe(true);  // present-and-null, so the server clears it
  });

  it('Auto place stages, ensures selection, runs, and reports a real placement', async () => {
    addTaskMock.mockResolvedValue({ flight_plan: [{ task_id: 't1', selected: false }], added: 1 });
    runMock.mockResolvedValue({ result: { placed: 1 }, flight_plan: [] }); // absent ⇒ placed

    mount();
    fireEvent.click(await screen.findByText('Pay invoices'));
    fireEvent.click(screen.getByText('Let Auto place it'));

    await waitFor(() => expect(runMock).toHaveBeenCalledWith({ date: '2026-07-18' }));
    expect(addTaskMock).toHaveBeenCalledWith('t1');
    // It came back unselected, so the branch had to fix that before running.
    expect(fpUpdateMock).toHaveBeenCalledWith('t1', { selected: true });
    await waitFor(() => expect(appendMock).toHaveBeenCalledWith(expect.stringContaining('Auto placed'), 'plan_week:schedule_auto'));
  });

  it('reports "didn\'t fit" when the task is still staged after the run', async () => {
    // The aggregate says something was placed — but not THIS task, which is still listed.
    runMock.mockResolvedValue({ result: { placed: 3 }, flight_plan: [{ task_id: 't1' }] });

    mount();
    fireEvent.click(await screen.findByText('Pay invoices'));
    fireEvent.click(screen.getByText('Let Auto place it'));

    await waitFor(() => expect(appendMock).toHaveBeenCalled());
    const [text] = appendMock.mock.calls[0];
    expect(text).toContain('could not fit');
    expect(text).not.toContain('Auto placed');
  });

  it('a failed update toasts and logs no success line', async () => {
    updateMock.mockRejectedValueOnce(new Error('server said no'));
    mount();
    fireEvent.click(await screen.findByText('Pay invoices'));
    fireEvent.click(screen.getByText('Set'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('server said no', 'error'));
    expect(appendMock).not.toHaveBeenCalled();
  });

  // ── T7 (#343) — the hybrid top-3 AI chip layer, wired only into this branch ──────
  describe('T7 hybrid follow-up', () => {
    const THREE = [
      PLAIN,
      { id: 't2', title: 'Second thing' },
      { id: 't3', title: 'Third thing' },
    ];

    it('never calls nextStep when aiAvailable() is false', async () => {
      aiAvailableFlag.current = false;
      listMock.mockResolvedValue({ tasks: THREE });
      mount();
      await screen.findByText('Pay invoices');
      expect(nextStepMock).not.toHaveBeenCalled();
      expect(screen.getByText('Which task should I find time for?')).toBeTruthy();
    });

    it('never calls nextStep when fewer than 3 candidates are eligible', async () => {
      aiAvailableFlag.current = true;
      listMock.mockResolvedValue({ tasks: [PLAIN] });
      mount();
      await screen.findByText('Pay invoices');
      expect(nextStepMock).not.toHaveBeenCalled();
    });

    it('fetches the top-3 as fallbackOptions, renders the model question + chips, and records source', async () => {
      aiAvailableFlag.current = true;
      listMock.mockResolvedValue({ tasks: THREE });
      nextStepMock.mockResolvedValue({
        question: 'Which of these matters most?',
        options: ['Pick A', 'Pick B', 'Pick C'],
        source: 'model',
      });

      mount();
      await screen.findByText('Which of these matters most?');

      expect(nextStepMock).toHaveBeenCalledWith({
        branch: 'schedule_tasks',
        context: { openCount: 3 },
        fallbackQuestion: 'Which task should I find time for?',
        fallbackOptions: ['Pay invoices', 'Second thing', 'Third thing'],
      });
      await waitFor(() =>
        expect(appendMock).toHaveBeenCalledWith('Suggested: Which of these matters most? (model)', 'plan_week:next_step'),
      );

      // Chip index 1 ("Pick B") must resolve to the SECOND task by array position —
      // a model rewrite of the label must never pick the wrong task.
      fireEvent.click(screen.getByText('Pick B'));
      await screen.findByText('Second thing');
    });

    it('a suggestion fetch error leaves the static question and full list intact', async () => {
      aiAvailableFlag.current = true;
      listMock.mockResolvedValue({ tasks: THREE });
      nextStepMock.mockRejectedValue(new Error('down'));

      mount();
      await screen.findByText('Pay invoices');
      expect(screen.getByText('Which task should I find time for?')).toBeTruthy();
      expect(screen.getAllByText(/Second thing|Third thing/)).toHaveLength(2);
    });
  });
});
