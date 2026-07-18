import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';

/**
 * PlanWeekFill (T3) — the deterministic branch's step flow and, critically, its two
 * contracts with the rest of the system:
 *   1. exactly one transcript entry per step, correctly `kind`-tagged (T1's seam);
 *   2. confirm drives the EXISTING endpoints — fill only when Open tasks is on, then run
 *      with the chosen horizon anchored at selectedDay().
 *
 * SEAMS mocked: `../lib/api.js` (auto.fill / auto.run / planWeek.candidates) and
 * `../stores/index.js` (selectedDay + refetch/toast spies) — mirrors QuickAdd.test.tsx.
 */

const fillMock = vi.fn(async (_b?: unknown) => ({ result: {} }));
const runMock = vi.fn(async (_b?: unknown) => ({ result: { placed: 4, unplaced: 1, days: 3 } }));
const candidatesMock = vi.fn(async (_p: unknown) => ({
  horizon: 7, start: '2026-07-18',
  open_tasks: { count: 9, will_stage: 9, items: [{ id: 't1', title: 'Pay invoice', priority: 3, due_at: null }] },
  flight_plan: { count: 2 }, objectives: { count: 1 }, recurring: { count: 5 },
}));
vi.mock('../lib/api.js', () => ({
  api: {
    auto: { fill: (b?: unknown) => fillMock(b), run: (b?: unknown) => runMock(b) },
    planWeek: { candidates: (p: unknown) => candidatesMock(p) },
  },
}));

const toastMock = vi.fn();
const refetchFlightPlanMock = vi.fn();
const refetchBlocksMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  selectedDay: () => '2026-07-18',
  showToast: (...a: unknown[]) => toastMock(...a),
  refetchFlightPlan: () => refetchFlightPlanMock(),
  refetchBlocks: () => refetchBlocksMock(),
}));

const { PlanWeekFill } = await import('./PlanWeekFill.js');

const appendMock = vi.fn(async (_t: string, _k?: string) => {});
const onBackMock = vi.fn();
const mount = () => render(() => <PlanWeekFill append={appendMock} onBack={onBackMock} />);

/** The candidate list renders as "· <title>", so match loosely. */
const previewItem = () => screen.findByText(/Pay invoice/);

/** The source checkbox for a label — the <label> wraps a nested span, so walk to it. */
function sourceCheckbox(label: string): HTMLInputElement {
  const el = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes(label));
  return el!.querySelector('input[type=checkbox]') as HTMLInputElement;
}

/** Walk horizon → sources → preview → confirm. */
async function stepToConfirm() {
  fireEvent.click(screen.getByText('Next'));
  await screen.findByText('What should I draw from?');
  fireEvent.click(screen.getByText('Preview'));
  await previewItem();   // preview resolved
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('Schedule it');
}

describe('PlanWeekFill — the deterministic fill branch', () => {
  beforeEach(() => {
    fillMock.mockReset().mockResolvedValue({ result: {} });
    runMock.mockReset().mockResolvedValue({ result: { placed: 4, unplaced: 1, days: 3 } });
    candidatesMock.mockClear();
    appendMock.mockReset();
    onBackMock.mockReset();
    toastMock.mockReset();
    refetchFlightPlanMock.mockReset();
    refetchBlocksMock.mockReset();
  });

  it('appends exactly one kind-tagged transcript entry per step, in order', async () => {
    mount();
    await stepToConfirm();
    fireEvent.click(screen.getByText('Schedule it'));
    await waitFor(() => expect(runMock).toHaveBeenCalled());

    await waitFor(() => expect(appendMock).toHaveBeenCalledTimes(4));
    expect(appendMock.mock.calls.map((c) => c[1])).toEqual([
      'plan_week:horizon', 'plan_week:sources', 'plan_week:preview', 'plan_week:confirm',
    ]);
    // The confirm entry carries the run result, so the log explains what happened.
    expect(appendMock.mock.calls[3][0]).toContain('placed 4');
    expect(appendMock.mock.calls[3][0]).toContain('unplaced 1');
  });

  it('confirm calls auto.fill then auto.run, anchored at selectedDay with the chosen horizon', async () => {
    mount();
    const horizonInput = document.querySelector('input[type=number]') as HTMLInputElement;
    fireEvent.input(horizonInput, { target: { value: '3' } });
    await stepToConfirm();

    fireEvent.click(screen.getByText('Schedule it'));

    await waitFor(() => expect(runMock).toHaveBeenCalledWith({ date: '2026-07-18', horizon_days: 3 }));
    expect(fillMock).toHaveBeenCalledTimes(1);
    // Order matters: staging must precede placement.
    expect(fillMock.mock.invocationCallOrder[0]).toBeLessThan(runMock.mock.invocationCallOrder[0]);
    expect(refetchFlightPlanMock).toHaveBeenCalled();
    expect(refetchBlocksMock).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Scheduled 4'), 'success');
  });

  it('with Open tasks off, confirm runs ONLY auto.run', async () => {
    mount();
    fireEvent.click(screen.getByText('Next'));
    await screen.findByText('What should I draw from?');
    fireEvent.click(sourceCheckbox('Open tasks'));
    fireEvent.click(screen.getByText('Preview'));
    await screen.findByText('Continue');
    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Schedule it');

    fireEvent.click(screen.getByText('Schedule it'));

    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(fillMock).not.toHaveBeenCalled();
  });

  it('the horizon input is clamped to the UI range 1..14', async () => {
    mount();
    const input = document.querySelector('input[type=number]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '99' } });
    expect(input.value).toBe('14');
    fireEvent.input(input, { target: { value: '0' } });
    expect(input.value).toBe('1');
  });

  it('Back from the first step leaves the branch; deeper it walks one step back', async () => {
    mount();
    fireEvent.click(screen.getByText('Back'));
    expect(onBackMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Next'));
    await screen.findByText('What should I draw from?');
    fireEvent.click(screen.getByText('Back'));
    await screen.findByText('How far ahead should I plan?'); // back to horizon, not out
    expect(onBackMock).toHaveBeenCalledTimes(1);
  });

  it('a failed run toasts and does not log a confirm entry', async () => {
    runMock.mockRejectedValueOnce(new Error('engine busy'));
    mount();
    await stepToConfirm();

    fireEvent.click(screen.getByText('Schedule it'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('engine busy', 'error'));
    expect(appendMock.mock.calls.map((c) => c[1])).not.toContain('plan_week:confirm');
    expect(refetchBlocksMock).not.toHaveBeenCalled();
  });
});
