import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen } from '@solidjs/testing-library';
import type { TrialityMetrics } from '../lib/api.js';

/**
 * TrialityMetricsTiles (design §9.2) — the honest-zero tile contracts:
 *   1. flag off → no render AND no fetch;
 *   2. null rate renders "no suggestions decided yet", never 0%;
 *   3. weights: null renders "learning not started" and NO reset button;
 *   4. weights present → rows + the reset button appears;
 *   5. deficit rows say "moved with", and pending counts are disclosed;
 *   6. the reset copy does not promise permanence — the endpoint deletes the
 *      weights but not the log, so the weekly pass re-learns from it.
 */

const metricsMock = vi.fn(async (_d?: number): Promise<TrialityMetrics> => EMPTY);
const resetMock = vi.fn(async () => ({ ok: true }));
vi.mock('../lib/api.js', () => ({
  api: {
    metrics: { triality: (d: number) => metricsMock(d as never) },
    triality: { resetWeights: () => resetMock() },
  },
}));

const prefsBox = { current: { triality_enabled: true } as Record<string, unknown> | undefined };
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  prefs: () => prefsBox.current,
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { TrialityMetricsTiles } = await import('./TrialityMetricsTiles.js');

const EMPTY: TrialityMetrics = {
  windowDays: 30,
  acceptance: {
    habitual: { shown: 0, taken: 0, pending: 0, rate: null },
    contextual: { shown: 0, taken: 0, pending: 0, rate: null },
    novel: { shown: 0, taken: 0, pending: 0, rate: null },
  },
  novelTrend: { current: null, prior: null },
  deficitResponse: [],
  weights: null,
};

const LIVELY: TrialityMetrics = {
  windowDays: 30,
  acceptance: {
    habitual: { shown: 28, taken: 18, pending: 2, rate: 0.643 },
    contextual: { shown: 28, taken: 13, pending: 0, rate: 0.464 },
    novel: { shown: 28, taken: 6, pending: 1, rate: 0.214 },
  },
  novelTrend: { current: 0.214, prior: 0.11 },
  deficitResponse: [
    { category: 'health', takenPicks: 9, currentShare: 0.182, priorShare: 0.15 },
    { category: 'growth', takenPicks: 0, currentShare: null, priorShare: null },
  ],
  weights: [{ slot: 'contextual', weights: { F: 0.57, H: 0.16, N: 0.27 }, sampleCount: 41, computedDate: '2026-07-28' }],
};

beforeEach(() => {
  metricsMock.mockReset().mockResolvedValue(EMPTY);
  resetMock.mockReset().mockResolvedValue({ ok: true });
  toastMock.mockReset();
  prefsBox.current = { triality_enabled: true };
});

describe('gating + honest zeros', () => {
  it('flag off → nothing rendered, nothing fetched', async () => {
    prefsBox.current = { triality_enabled: false };
    const { container } = render(() => <TrialityMetricsTiles days={30} />);
    await Promise.resolve();
    expect(container.querySelector('[data-testid="triality-metrics"]')).toBeNull();
    expect(metricsMock).not.toHaveBeenCalled();
  });

  it('null rates render the no-data copy, never 0%', async () => {
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getAllByText('no suggestions decided yet').length).toBe(3));
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('weights null → "learning not started" and NO reset button', async () => {
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByText(/learning not started/)).toBeTruthy());
    expect(screen.queryByText('Recompute from scratch')).toBeNull();
    expect(screen.queryByTestId('triality-reset-hint')).toBeNull();
  });
});

describe('lively fixture', () => {
  beforeEach(() => metricsMock.mockResolvedValue(LIVELY));

  it('rates, pending disclosure, novel trend, and moved-with copy', async () => {
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByText('64%')).toBeTruthy());
    expect(screen.getByText(/18 of 28 shown/).textContent).toContain('2 pending');
    expect(screen.getByTestId('novel-trend').textContent).toContain('21% vs 11%');
    expect(screen.getByText(/moved with 9 taken picks/)).toBeTruthy();
    // The zero-pick deficit row stays hidden — no confident emptiness.
    expect(screen.queryByText(/growth/)).toBeNull();
  });

  it('weights rows render and the reset button fires the DELETE + refetch', async () => {
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByText(/41 outcomes/)).toBeTruthy());
    const btn = screen.getByText('Recompute from scratch');
    btn.click();
    await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalled();
  });

  it('the reset copy claims a recompute, not a permanent erasure', async () => {
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-reset-hint')).toBeTruthy());
    const hint = screen.getByTestId('triality-reset-hint').textContent!;
    // The two load-bearing facts: the log survives, and the weekly pass re-learns.
    expect(hint).toMatch(/log is kept/i);
    expect(hint).toMatch(/weekly pass/i);
    // And nothing anywhere claims "learning" itself was reset.
    expect(screen.queryByText('Reset learning')).toBeNull();
  });
});
