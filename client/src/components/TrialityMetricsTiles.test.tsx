import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen } from '@solidjs/testing-library';
import type {
  TrialityCalibration,
  TrialityCalibrationBand,
  TrialityConfidenceBand,
  TrialityMetrics,
} from '../lib/api.js';

/**
 * TrialityMetricsTiles (design §9.2) — the honest-zero tile contracts:
 *   1. flag off → no render AND no fetch;
 *   2. null rate renders "no suggestions decided yet", never 0%;
 *   3. weights: null renders "learning not started" and NO reset button;
 *   4. weights present → rows + the reset button appears;
 *   5. deficit rows say "moved with", and pending counts are disclosed;
 *   6. the reset copy does not promise permanence — the endpoint deletes the
 *      weights but not the log, so the weekly pass re-learns from it.
 *
 * v2.2 adds the calibration block, whose purpose is to FALSIFY the confidence
 * model rather than display it:
 *   7. all four verdicts render, and `inverted` is stated flatly — no hedging,
 *      no "may indicate". That verdict is the result the wave was built to be
 *      able to report;
 *   8. `inverted` names the ADJACENT pair that runs backwards, so a middle-band
 *      inversion cannot be reported as though firm-vs-guess were the problem;
 *   9. no calibration at all → "not measured yet", never an invented number;
 *  10. a band with nothing decided renders an em dash, never 0%.
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

// ── Calibration fixtures ─────────────────────────────────────────────────────
// The server's own thresholds ride on the wire; the fixtures use them rather than
// bare numbers so a retune shows up here as one edit, not as a silent re-baseline.
const FLOOR = 20;
const MIN_GAP = 0.1;
const BANDS = ['firm', 'tentative', 'guess'] as const;

/** `decided` rows at `rate`, with `taken` kept CONSISTENT with the rate — the row copy
 *  prints both, and a fixture where they disagree would let a formatting bug pass. */
const calBand = (
  band: TrialityConfidenceBand,
  decided: number,
  rate: number | null,
  over: Partial<TrialityCalibrationBand> = {},
): TrialityCalibrationBand => ({
  band,
  shown: decided,
  taken: rate == null ? 0 : Math.round(rate * decided),
  pending: 0,
  rate,
  slotMix: { habitual: 0, contextual: 0, novel: 0 },
  ...over,
});

/** Three bands at 40 decided rows each — comfortably over the floor, so every verdict
 *  below is about the RATES and never about the sample size. */
const calibration = (
  rates: [number, number, number],
  verdict: TrialityCalibration['verdict'],
  over: Partial<TrialityCalibration> = {},
): TrialityCalibration => ({
  bands: BANDS.map((b, i) => calBand(b, 2 * FLOOR, rates[i])),
  unbanded: 0,
  otherModel: 0,
  floor: FLOOR,
  minGap: MIN_GAP,
  verdict,
  confounded: false,
  ...over,
});

const withCalibration = (c: TrialityCalibration | null): TrialityMetrics => ({ ...EMPTY, calibration: c });

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

describe('confidence calibration (v2.2 §4)', () => {
  /** Mount with `c` as the whole calibration payload and hand back the verdict sentence. */
  async function verdictFor(c: TrialityCalibration): Promise<string> {
    metricsMock.mockResolvedValue(withCalibration(c));
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration-verdict')).toBeTruthy());
    return screen.getByTestId('triality-calibration-verdict').textContent!;
  }

  it('null calibration → the not-measured line, and no verdict at all', async () => {
    metricsMock.mockResolvedValue(withCalibration(null));
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration')).toBeTruthy());
    expect(screen.getByTestId('triality-calibration').textContent).toContain(
      "Confidence isn't measured yet — these suggestions were shown before confidence scoring.",
    );
    // No bands, no rates, no verdict — nothing that could be read as a measurement.
    expect(screen.queryByTestId('triality-calibration-verdict')).toBeNull();
    expect(screen.queryByTestId('triality-calibration-counts')).toBeNull();
  });

  it('an absent field reads the same as null — an older payload is not a measurement', async () => {
    metricsMock.mockResolvedValue(EMPTY); // no `calibration` key at all
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration')).toBeTruthy());
    expect(screen.getByTestId('triality-calibration').textContent).toContain("Confidence isn't measured yet");
    expect(screen.queryByTestId('triality-calibration-verdict')).toBeNull();
  });

  it('insufficient names the floor rather than comparing what it has', async () => {
    const thin = calibration([0.6, 0.4, 0.2], 'insufficient', {
      bands: BANDS.map((b) => calBand(b, 5, 0.6)),
    });
    expect(await verdictFor(thin)).toBe(
      `Not enough decided suggestions to compare bands yet — ${FLOOR} needed in at least two bands.`,
    );
  });

  it('ordered says so, with all three rates', async () => {
    expect(await verdictFor(calibration([0.6, 0.4, 0.2], 'ordered'))).toBe(
      'Firm picks taken 60% · tentative 40% · guess 20% — the bands are ordering outcomes correctly.',
    );
  });

  it('flat admits the bands are telling the owner nothing', async () => {
    expect(await verdictFor(calibration([0.4, 0.38, 0.35], 'flat'))).toBe(
      'Firm, tentative and guess picks are taken at about the same rate (40% · 38% · 35%). ' +
        "Confidence isn't telling you anything yet.",
    );
  });

  it('inverted is stated FLATLY — no "may indicate", and it names the pair', async () => {
    // firm 20% / tentative 60% / guess 10%: the extremes look fine, the first
    // adjacent pair does not. The sentence must point at that pair.
    const line = await verdictFor(calibration([0.2, 0.6, 0.1], 'inverted'));
    expect(line).toBe(
      'tentative picks are taken MORE often than firm ones (60% vs 20%). ' +
        'The confidence model is wrong — treat the bands as decoration until this flips.',
    );
    expect(line).not.toMatch(/may indicate|might|seems|possibly/i);
  });

  it('a MIDDLE-band inversion is named, not reported as firm vs guess', async () => {
    expect(await verdictFor(calibration([0.6, 0.2, 0.45], 'inverted'))).toContain(
      'guess picks are taken MORE often than tentative ones (45% vs 20%).',
    );
  });

  it('the confound note is appended, and says "may be" rather than "because"', async () => {
    const confounded = calibration([0.6, 0.4, 0.2], 'ordered', {
      confounded: true,
      bands: [
        calBand('firm', 2 * FLOOR, 0.6, { slotMix: { habitual: 30, contextual: 6, novel: 4 } }),
        calBand('tentative', 2 * FLOOR, 0.4, { slotMix: { habitual: 10, contextual: 22, novel: 8 } }),
        calBand('guess', 2 * FLOOR, 0.2, { slotMix: { habitual: 4, contextual: 8, novel: 28 } }),
      ],
    });
    const line = await verdictFor(confounded);
    expect(line).toContain('the bands are ordering outcomes correctly.');
    expect(line).toContain(
      ' Most firm picks are habitual and most guess picks are novel, so this may be the slot difference ' +
        'the tiles above already show, not confidence working.',
    );
    expect(line).not.toMatch(/because/i);
  });

  it('a band with nothing decided renders an em dash and its own copy — never 0%', async () => {
    metricsMock.mockResolvedValue(withCalibration(calibration([0.6, 0.4, 0.2], 'ordered', {
      bands: [
        calBand('firm', 0, null, { pending: 3 }),
        calBand('tentative', 2 * FLOOR, 0.4),
        calBand('guess', 2 * FLOOR, 0.2),
      ],
    })));
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration-verdict')).toBeTruthy());
    expect(screen.getByText('no firm suggestions decided yet · 3 pending')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    // …and the sentence carries the same em dash rather than manufacturing a rate.
    expect(screen.getByTestId('triality-calibration-verdict').textContent).toContain('Firm picks taken — ·');
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('band rows print taken-of-decided, and pending is disclosed not hidden', async () => {
    metricsMock.mockResolvedValue(withCalibration(calibration([0.6, 0.4, 0.2], 'ordered', {
      bands: [
        calBand('firm', 2 * FLOOR, 0.6, { pending: 2 }),
        calBand('tentative', 2 * FLOOR, 0.4),
        calBand('guess', 2 * FLOOR, 0.2),
      ],
    })));
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration')).toBeTruthy());
    expect(screen.getByText('24 of 40 decided · 2 pending')).toBeTruthy();
    expect(screen.getByText('16 of 40 decided')).toBeTruthy();
  });

  it('the excluded cohorts are DISCLOSED — a pre-v2.2 row is never coerced into a band', async () => {
    metricsMock.mockResolvedValue(withCalibration(
      calibration([0.6, 0.4, 0.2], 'ordered', { unbanded: 7, otherModel: 3 }),
    ));
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration-counts')).toBeTruthy());
    const counts = screen.getByTestId('triality-calibration-counts').textContent!;
    expect(counts).toContain('firm 40 · tentative 40 · guess 40 decided');
    expect(counts).toContain(' · 7 shown before confidence scoring, not counted');
    expect(counts).toContain(' · 3 scored by an earlier confidence model, not counted');
  });

  it('neither exclusion line appears when there is nothing to exclude', async () => {
    metricsMock.mockResolvedValue(withCalibration(calibration([0.6, 0.4, 0.2], 'ordered')));
    render(() => <TrialityMetricsTiles days={30} />);
    await waitFor(() => expect(screen.getByTestId('triality-calibration-counts')).toBeTruthy());
    const counts = screen.getByTestId('triality-calibration-counts').textContent!;
    expect(counts).toBe('firm 40 · tentative 40 · guess 40 decided');
  });
});
