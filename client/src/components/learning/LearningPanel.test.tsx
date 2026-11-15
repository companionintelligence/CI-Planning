import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import type {
  ClassificationAccuracyResponse,
  DismissalTrendResponse,
  LearningResetResult,
  PlacementSurvivalResponse,
  PlanLoopTrendResponse,
} from '../../lib/api.js';
import { clearedMemory } from '../../lib/learning-cleared.js';
import { COMMON, copyProblems } from '../../lib/learning-copy.js';
import { LEARNING_LIMITS } from '../../lib/learning-stats.js';
import { textWithoutChart } from './learning-test-helpers.js';

/**
 * LearningPanel: the Settings → Learning tab body. The four tiles have their own tests; this
 * file pins what only the panel does:
 *
 *   1. it fetches nothing itself and nothing until it is mounted; each tile reads its own
 *      endpoint exactly once with the contract limit, and a reopen reads again;
 *   2. the four cards, in order, under one heading and one intro;
 *   3. one failing card never blanks the others, and a failure is never shown as emptiness;
 *   4. the context it derives from the stores: the model-off lines only on an exact `false`
 *      (never while integrations load, never on an errored resource), reactive, and `now`
 *      taken at mount;
 *   5. canReset is tri-state (unknown shows nothing, false shows the read-only note), a 403
 *      from any clear flips every card for the session, and no clear refetches;
 *   6. every button is type="button" and there is no form (Settings renders the panel
 *      outside its own <form>, so a stray untyped button must not exist anyway);
 *   7. rendered-text sweeps over empty, all-null and all-measured data: no banned wording and
 *      no standalone 0% where nothing was measured.
 *
 * The real tiles, the real useReadout and the real LearningCard render; only the api module
 * and the stores are mocked.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  classificationAccuracy: vi.fn(),
  resetClassification: vi.fn(),
  dismissalTrend: vi.fn(),
  resetDismissal: vi.fn(),
  placementSurvival: vi.fn(),
  resetPlacement: vi.fn(),
  planLoopTrend: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    learning: {
      classificationAccuracy: (...a: unknown[]) => m.classificationAccuracy(...a),
      resetClassification: (...a: unknown[]) => m.resetClassification(...a),
      dismissalTrend: (...a: unknown[]) => m.dismissalTrend(...a),
      resetDismissal: (...a: unknown[]) => m.resetDismissal(...a),
      placementSurvival: (...a: unknown[]) => m.placementSurvival(...a),
      resetPlacement: (...a: unknown[]) => m.resetPlacement(...a),
      planLoopTrend: (...a: unknown[]) => m.planLoopTrend(...a),
    },
  },
}));

type ResState = 'unresolved' | 'pending' | 'ready' | 'refreshing' | 'errored';
interface StoreState {
  integrations: ResState;
  ollama: { ready?: boolean; available?: boolean } | undefined;
  prefs: ResState;
  planningMode: string | undefined;
}
const store = vi.hoisted(() => ({
  set: (_patch: Partial<StoreState>): void => {},
  reset: (): void => {},
}));

// The stores are mocked with the same shapes the panel reads: createResource accessors with a
// `.state`, and `aiAvailable()` that is false (fail-closed) until integrations have loaded.
// An errored resource THROWS when read, as a real one does, so a panel that reads it without
// checking `.state` fails here instead of in a browser.
vi.mock('../../stores/index.js', async () => {
  const { createSignal: signal } = await import('solid-js');
  const INITIAL: StoreState = { integrations: 'pending', ollama: undefined, prefs: 'pending', planningMode: undefined };
  const [s, setS] = signal<StoreState>({ ...INITIAL });
  store.set = (patch) => setS({ ...s(), ...patch });
  store.reset = () => setS({ ...INITIAL });

  const integrations = () => {
    const st = s();
    if (st.integrations === 'errored') throw new Error('integrations errored');
    return st.integrations === 'ready' || st.integrations === 'refreshing' ? { ollama: st.ollama } : undefined;
  };
  Object.defineProperty(integrations, 'state', { get: () => s().integrations });

  const prefs = () => {
    const st = s();
    if (st.prefs === 'errored') throw new Error('prefs errored');
    return st.prefs === 'ready' || st.prefs === 'refreshing' ? { planning_mode: st.planningMode } : undefined;
  };
  Object.defineProperty(prefs, 'state', { get: () => s().prefs });

  const aiAvailable = () => {
    const o = integrations()?.ollama;
    return o?.ready ?? o?.available ?? false;
  };
  return { integrations, prefs, aiAvailable, showToast: (...a: unknown[]) => m.showToast(...a) };
});

const { LearningPanel, LEARNING_HEADING, LEARNING_INTRO } = await import('./LearningPanel.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Built in the order the SERVER sends them: dismissal OLDEST first, the other three NEWEST
// first. The newest reading is 2026-10-26 in all four, and each older reading has different
// counts, so a headline taken from the wrong end shows up as the wrong fraction.

const CLASSIFICATION_MEASURED: ClassificationAccuracyResponse = {
  fields: ['category', 'motivation'],
  runs: [
    { field: 'category', computed_date: '2026-10-26', held_out: 12, correct: 9, accuracy: 0.75 },
    { field: 'motivation', computed_date: '2026-10-26', held_out: 4, correct: 3, accuracy: 0.75 },
    { field: 'category', computed_date: '2026-10-19', held_out: 5, correct: 2, accuracy: 0.4 },
    { field: 'motivation', computed_date: '2026-10-19', held_out: 6, correct: 6, accuracy: 1 },
  ],
};
const DISMISSAL_MEASURED: DismissalTrendResponse = {
  trend: [
    { computed_date: '2026-10-12', period_days: 7, created: 9, decided: 6, dismissed: 4, rate: 0.667, exemplars: 0, hinted: 0 },
    { computed_date: '2026-10-19', period_days: 7, created: 9, decided: 8, dismissed: 3, rate: 0.375, exemplars: 12, hinted: 0 },
    { computed_date: '2026-10-26', period_days: 7, created: 9, decided: 14, dismissed: 5, rate: 0.357, exemplars: 23, hinted: 1 },
  ],
};
const PLACEMENT_MEASURED: PlacementSurvivalResponse = {
  runs: [
    { computed_date: '2026-10-26', period_days: 28, decided: 28, accepted: 20, corrected: 8, survival_rate: 0.714, keys_learned: 2, biased: 1 },
    { computed_date: '2026-10-19', period_days: 28, decided: 7, accepted: 5, corrected: 2, survival_rate: 0.714, keys_learned: 0, biased: 0 },
  ],
};
const PLANLOOP_MEASURED: PlanLoopTrendResponse = {
  runs: [
    { stage: 'order', computed_date: '2026-10-26', period_days: 7, runs: 15, passed: 12, escaped: 3, first_try_pass: 9, avg_iterations: 1.6, pass_rate: 0.8 },
    { stage: 'order', computed_date: '2026-10-19', period_days: 7, runs: 7, passed: 5, escaped: 2, first_try_pass: 3, avg_iterations: 1.9, pass_rate: 0.714 },
  ],
};
const MEASURED = {
  classification: CLASSIFICATION_MEASURED,
  dismissal: DISMISSAL_MEASURED,
  placement: PLACEMENT_MEASURED,
  planloop: PLANLOOP_MEASURED,
};

// Rows exist but nothing was measured: a null rate everywhere. (The plan-loop server never
// writes such a row; the panel defends against one anyway.)
const NULL_RATES = {
  classification: {
    fields: ['category', 'motivation'],
    runs: [
      { field: 'category', computed_date: '2026-10-26', held_out: 0, correct: 0, accuracy: null },
      { field: 'motivation', computed_date: '2026-10-26', held_out: 0, correct: 0, accuracy: null },
    ],
  } as ClassificationAccuracyResponse,
  dismissal: {
    trend: [{ computed_date: '2026-10-26', period_days: 7, created: 3, decided: 0, dismissed: 0, rate: null, exemplars: 0, hinted: 0 }],
  } as DismissalTrendResponse,
  placement: {
    runs: [{ computed_date: '2026-10-26', period_days: 28, decided: 0, accepted: 0, corrected: 0, survival_rate: null, keys_learned: 0, biased: 0 }],
  } as PlacementSurvivalResponse,
  planloop: {
    runs: [{ stage: 'order', computed_date: '2026-10-26', period_days: 7, runs: 0, passed: 0, escaped: 0, first_try_pass: 0, avg_iterations: null, pass_rate: null }],
  } as PlanLoopTrendResponse,
};

const EMPTY = {
  classification: { fields: ['category', 'motivation'], runs: [] } as ClassificationAccuracyResponse,
  dismissal: { trend: [] } as DismissalTrendResponse,
  placement: { runs: [] } as PlacementSurvivalResponse,
  planloop: { runs: [] } as PlanLoopTrendResponse,
};

type Fixture = typeof MEASURED;
function serve(f: Fixture) {
  m.classificationAccuracy.mockResolvedValue(f.classification);
  m.dismissalTrend.mockResolvedValue(f.dismissal);
  m.placementSurvival.mockResolvedValue(f.placement);
  m.planLoopTrend.mockResolvedValue(f.planloop);
}
const OK = (cleared: number): LearningResetResult => ({ ok: true, cleared });
const failure = (status: number, message = 'server said no') => Object.assign(new Error(message), { status });

const LOOPS = ['classification', 'dismissal', 'placement', 'planloop'] as const;
type Loop = (typeof LOOPS)[number];
const READ: Record<Loop, typeof m.classificationAccuracy> = {
  classification: m.classificationAccuracy,
  dismissal: m.dismissalTrend,
  placement: m.placementSurvival,
  planloop: m.planLoopTrend,
};
const RESET_BUTTON: Record<'classification' | 'dismissal' | 'placement', string> = {
  classification: 'Clear learned examples',
  dismissal: 'Clear learned dismissals',
  placement: 'Clear learned hours',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const card = (loop: Loop) => screen.getByTestId(`learning-card-${loop}`);
const CARD_ID = /^learning-card-(classification|dismissal|placement|planloop)$/;

/** Every card has left its loading state (its read settled, either way). */
async function settled() {
  await waitFor(() => {
    expect(screen.getAllByTestId(CARD_ID)).toHaveLength(4);
    expect(screen.queryAllByText(COMMON.loading)).toHaveLength(0);
  });
}

const headlineOf = (loop: Loop, series: string) => screen.getByTestId(`learning-headline-${loop}-${series}`);

async function mount(props: Parameters<typeof LearningPanel>[0] = {}) {
  const view = render(() => <LearningPanel {...props} />);
  await settled();
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The memory of clears lives in sessionStorage, which outlives a test.
  clearedMemory.bind('');
  clearedMemory.forget();
  store.reset();
  serve(MEASURED);
  m.resetClassification.mockResolvedValue(OK(7));
  m.resetDismissal.mockResolvedValue(OK(23));
  m.resetPlacement.mockResolvedValue(OK(2));
  vi.stubGlobal('confirm', vi.fn(() => true));
  // Fake only the clock, so the panel's `now` is known and timers stay real for waitFor.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0)); // Wed 28 Oct 2026, two days after the newest reading
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Fetching ─────────────────────────────────────────────────────────────────

describe('LearningPanel: fetching', () => {
  it('reads nothing until it is mounted, the way Settings gates it behind the Learning tab', async () => {
    // Settings renders <Show when={activeTab() === 'learning'}><LearningPanel /></Show>. This is the
    // same gate: a closed tab makes no read, opening it makes one each, and a reopen makes them again.
    const [open, setOpen] = createSignal(false);
    render(() => (
      <Show when={open()}>
        <LearningPanel canReset />
      </Show>
    ));
    await Promise.resolve();
    expect(screen.queryByTestId('learning-panel')).toBeNull();
    for (const loop of LOOPS) expect(READ[loop]).not.toHaveBeenCalled();

    setOpen(true);
    await settled();
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(1);

    setOpen(false);
    await waitFor(() => expect(screen.queryByTestId('learning-panel')).toBeNull());
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(1);

    setOpen(true);
    await settled();
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(2);
  });

  it('reads each endpoint exactly once with its contract limit, and clears nothing', async () => {
    await mount();
    expect(m.classificationAccuracy).toHaveBeenCalledTimes(1);
    expect(m.classificationAccuracy).toHaveBeenCalledWith(LEARNING_LIMITS.classification);
    expect(m.dismissalTrend).toHaveBeenCalledTimes(1);
    expect(m.dismissalTrend).toHaveBeenCalledWith(LEARNING_LIMITS.dismissal);
    expect(m.placementSurvival).toHaveBeenCalledTimes(1);
    expect(m.placementSurvival).toHaveBeenCalledWith(LEARNING_LIMITS.placement);
    expect(m.planLoopTrend).toHaveBeenCalledTimes(1);
    expect(m.planLoopTrend).toHaveBeenCalledWith(LEARNING_LIMITS.planLoop);
    expect(m.resetClassification).not.toHaveBeenCalled();
    expect(m.resetDismissal).not.toHaveBeenCalled();
    expect(m.resetPlacement).not.toHaveBeenCalled();
  });

  it('uses the limits the spec fixes: rows, not weeks (24, 12, 12, 24)', () => {
    expect(LEARNING_LIMITS).toEqual({ classification: 24, dismissal: 12, placement: 12, planLoop: 24 });
  });

  it('reads again on every mount, so a reopened tab never shows a cached reading', async () => {
    const first = await mount();
    first.unmount();
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(1);

    // The newest reading changes between the two opens; the second open must show it.
    m.dismissalTrend.mockResolvedValue({
      trend: [...DISMISSAL_MEASURED.trend, { computed_date: '2026-11-02', period_days: 7, created: 2, decided: 3, dismissed: 1, rate: 0.333, exemplars: 23, hinted: 1 }],
    });
    await mount();
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(2);
    expect(headlineOf('dismissal', 'rate').textContent).toContain('1 of 3');
  });

  it('does not read again when the account loads or a clear is answered', async () => {
    const [canReset, setCanReset] = createSignal<boolean | null>(null);
    render(() => <LearningPanel canReset={canReset()} />);
    await settled();
    setCanReset(true);
    fireEvent.click(await screen.findByTestId('learning-reset-classification'));
    await waitFor(() => expect(m.resetClassification).toHaveBeenCalledTimes(1));
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(1);
  });
});

// ── Layout ───────────────────────────────────────────────────────────────────

describe('LearningPanel: layout', () => {
  it('shows the heading and the intro, then the four cards in the fixed order', async () => {
    const { container } = await mount();
    expect(screen.getByTestId('learning-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: LEARNING_HEADING })).toBeInTheDocument();
    expect(LEARNING_HEADING).toBe('What the app has measured');
    expect(screen.getByText(LEARNING_INTRO)).toBeInTheDocument();

    const order = Array.from(container.querySelectorAll('[data-testid^="learning-card-"]'))
      .map((e) => e.getAttribute('data-testid') ?? '')
      .filter((id) => CARD_ID.test(id));
    expect(order).toEqual(['learning-card-classification', 'learning-card-dismissal', 'learning-card-placement', 'learning-card-planloop']);

    // The heading and intro come before the first card.
    const panel = screen.getByTestId('learning-panel');
    const heading = screen.getByRole('heading', { name: LEARNING_HEADING });
    expect(heading.compareDocumentPosition(card('classification')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.firstElementChild?.contains(heading)).toBe(true);
  });

  it('keeps its own words free of banned wording, dashes and the 0 trap', () => {
    expect(copyProblems(LEARNING_HEADING)).toEqual([]);
    expect(copyProblems(LEARNING_INTRO)).toEqual([]);
    expect(LEARNING_INTRO).toContain('never shown as zero');
    expect(LEARNING_INTRO).toContain('evidence, not proof');
  });

  it('does not say all four readings come from the owner: the day ordering check is a model scoring the app\'s own plans', () => {
    expect(LEARNING_INTRO).toContain('the first three come from your corrections and choices');
    expect(LEARNING_INTRO).toContain("the fourth is the app's own plans scored by a model, not anything you did");
    // The first three are the owner's; the claim must not be attached to all four.
    expect(LEARNING_INTRO).not.toMatch(/recalculated[^:]*from your corrections and choices/);
    expect(LEARNING_INTRO).toContain('recalculated early on Monday (server time)');
  });

  it('keeps the intro to two sentences, so the first card is not pushed down the screen', () => {
    expect(LEARNING_INTRO.match(/\./g)).toHaveLength(2);
    expect(LEARNING_INTRO.endsWith('.')).toBe(true);
    expect(LEARNING_INTRO.length).toBeLessThan(500);
    expect(LEARNING_INTRO).toContain('how many cases are behind it');
    expect(LEARNING_INTRO).toContain('each card says what its number does not show');
  });

  it('puts the always-visible caveat on every card, before the data has loaded and after it', async () => {
    // Held open: the reads never settle, so every card is still loading.
    for (const loop of LOOPS) READ[loop].mockReturnValue(new Promise(() => {}));
    const { unmount } = render(() => <LearningPanel />);
    for (const loop of LOOPS) expect(within(card(loop)).getByTestId(`learning-primary-caveat-${loop}`)).toBeInTheDocument();
    expect(screen.getAllByText(COMMON.loading)).toHaveLength(4);
    unmount();

    serve(MEASURED);
    await mount();
    for (const loop of LOOPS) expect(within(card(loop)).getByTestId(`learning-primary-caveat-${loop}`).textContent?.length).toBeGreaterThan(20);
  });
});

// ── Headlines ────────────────────────────────────────────────────────────────

describe('LearningPanel: each headline is the newest reading, whatever order the wire used', () => {
  function expectNewest() {
    // The newest reading of each loop, by its counts (older readings carry different counts).
    expect(headlineOf('classification', 'category').textContent).toContain('9 of 12');
    expect(headlineOf('classification', 'motivation').textContent).toContain('3 of 4');
    expect(headlineOf('dismissal', 'rate').textContent).toContain('5 of 14');
    expect(headlineOf('placement', 'survival').textContent).toContain('20 of 28');
    expect(headlineOf('planloop', 'order').textContent).toContain('12 of 15');
    for (const [loop, series] of [['classification', 'category'], ['classification', 'motivation'], ['dismissal', 'rate'], ['placement', 'survival'], ['planloop', 'order']] as const) {
      expect(headlineOf(loop, series)).toHaveAttribute('data-state', 'measured');
      expect(headlineOf(loop, series).textContent).toContain('Oct 26');
    }
  }

  it('as the server sends them (dismissal oldest first, the others newest first)', async () => {
    await mount();
    expectNewest();
  });

  it('with every order reversed', async () => {
    serve({
      classification: { ...CLASSIFICATION_MEASURED, runs: [...CLASSIFICATION_MEASURED.runs].reverse() },
      dismissal: { trend: [...DISMISSAL_MEASURED.trend].reverse() },
      placement: { runs: [...PLACEMENT_MEASURED.runs].reverse() },
      planloop: { runs: [...PLANLOOP_MEASURED.runs].reverse() },
    });
    await mount();
    expectNewest();
  });

  it('shows a percent only at 10 or more cases, and then with its range', async () => {
    await mount();
    // 9 of 12 and 20 of 28 and 12 of 15 are at or over 10; 3 of 4 and the older weeks are not.
    expect(headlineOf('classification', 'category').textContent).toMatch(/75%/);
    expect(headlineOf('classification', 'category').textContent).toMatch(/\d+% to \d+%/);
    expect(headlineOf('classification', 'motivation').textContent).not.toMatch(/%/);
    expect(headlineOf('dismissal', 'rate').textContent).toMatch(/36%/);
    expect(headlineOf('placement', 'survival').textContent).toMatch(/71%/);
    expect(headlineOf('planloop', 'order').textContent).toMatch(/80%/);
  });

  it('gives plan loop no direction word and no comparison, and the other two a comparison line', async () => {
    await mount();
    expect(within(card('planloop')).queryByTestId('learning-comparison-planloop-order')).toBeNull();
    expect(card('planloop').textContent).not.toMatch(/(higher|lower) is better/i);
    // Classification has only the fixed no-verdict sentence, never a computed one.
    expect(within(card('classification')).getByTestId('learning-comparison-classification-category').textContent).toMatch(/No week-to-week verdict/);
    expect(within(card('dismissal')).getByTestId('learning-comparison-dismissal-rate')).toBeInTheDocument();
    expect(within(card('placement')).getByTestId('learning-comparison-placement-survival')).toBeInTheDocument();
  });
});

// ── Failure ──────────────────────────────────────────────────────────────────

describe('LearningPanel: a failing card never blanks the others', () => {
  const MESSAGE = { 500: COMMON.errorFailed, 0: COMMON.errorOffline, 404: COMMON.errorUnsupported } as const;

  it.each(LOOPS)('%s fails: its card shows the error and Try again; the other three still show data', async (failing) => {
    READ[failing].mockRejectedValue(failure(500));
    await mount();

    const bad = card(failing);
    expect(within(bad).getByTestId(`learning-error-${failing}`).textContent).toContain(COMMON.errorFailed);
    expect(within(bad).getByTestId(`learning-retry-${failing}`)).toHaveTextContent(COMMON.tryAgain);
    expect(bad.textContent).not.toMatch(/No readings yet/i);
    expect(bad.textContent).not.toMatch(/no reading yet/i);
    expect(within(bad).queryAllByTestId(/^learning-headline-/)).toHaveLength(0);
    expect(within(bad).queryAllByTestId(/^learning-empty-/)).toHaveLength(0);
    // The raw server text is never shown.
    expect(bad.textContent).not.toContain('server said no');

    for (const other of LOOPS.filter((l) => l !== failing)) {
      const good = card(other);
      expect(within(good).queryByTestId(`learning-error-${other}`)).toBeNull();
      expect(within(good).queryAllByTestId(/^learning-headline-/).length).toBeGreaterThan(0);
    }
  });

  it('Try again re-reads only the card that failed', async () => {
    m.dismissalTrend.mockRejectedValueOnce(failure(500));
    await mount();
    expect(m.dismissalTrend).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('learning-retry-dismissal'));
    await waitFor(() => expect(headlineOf('dismissal', 'rate').textContent).toContain('5 of 14'));

    expect(m.dismissalTrend).toHaveBeenCalledTimes(2);
    expect(m.classificationAccuracy).toHaveBeenCalledTimes(1);
    expect(m.placementSurvival).toHaveBeenCalledTimes(1);
    expect(m.planLoopTrend).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('learning-error-dismissal')).toBeNull();
  });

  it.each([
    [0, 'offline'],
    [404, 'unsupported'],
    [500, 'failed'],
  ] as const)('status %i reads as %s, in plain words and not as "no readings yet"', async (status, _kind) => {
    // The 404 is what an older server answers: an ApiError-shaped object with only a status.
    m.placementSurvival.mockRejectedValue(failure(status));
    await mount();
    const text = within(card('placement')).getByTestId('learning-error-placement').textContent ?? '';
    expect(text).toContain(MESSAGE[status]);
    if (status === 404) expect(text).toContain('This server does not report this yet');
    expect(card('placement').textContent).not.toMatch(/No readings yet/i);
  });

  it('every card failing at once leaves four errors, four Try again buttons and no data', async () => {
    for (const loop of LOOPS) READ[loop].mockRejectedValue(failure(0));
    await mount();
    for (const loop of LOOPS) {
      expect(within(card(loop)).getByTestId(`learning-error-${loop}`).textContent).toContain(COMMON.errorOffline);
      expect(within(card(loop)).getByTestId(`learning-retry-${loop}`)).toBeInTheDocument();
    }
    expect(screen.queryAllByTestId(/^learning-headline-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^learning-empty-/)).toHaveLength(0);
    expect(screen.getByTestId('learning-panel').textContent).not.toMatch(/No readings yet/i);
  });
});

// ── Buttons ──────────────────────────────────────────────────────────────────

describe('LearningPanel: every button is type="button" and there is no form', () => {
  it('with data and every clear offered', async () => {
    const { container } = await mount({ canReset: true });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button');
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input[type="submit"], button[type="submit"]')).toBeNull();
  });

  it('with every card in its error state (Try again buttons)', async () => {
    for (const loop of LOOPS) READ[loop].mockRejectedValue(failure(500));
    const { container } = await mount({ canReset: true });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b.getAttribute('type')).toBe('button');
  });

  it('inside a form, a click on a clear or Try again button submits nothing', async () => {
    // Mimics Settings if someone ever moved the panel into its <form onSubmit={save}>.
    const submit = vi.fn((e: Event) => e.preventDefault());
    m.dismissalTrend.mockRejectedValueOnce(failure(500));
    const { container } = render(() => (
      <form onSubmit={submit}>
        <LearningPanel canReset />
      </form>
    ));
    await settled();
    fireEvent.click(screen.getByTestId('learning-retry-dismissal'));
    await waitFor(() => expect(screen.queryByTestId('learning-retry-dismissal')).toBeNull());
    fireEvent.click(screen.getByTestId('learning-reset-classification'));
    await waitFor(() => expect(m.resetClassification).toHaveBeenCalledTimes(1));
    expect(container.querySelector('form')).not.toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});

// ── Rendered text sweeps ─────────────────────────────────────────────────────

describe('LearningPanel: rendered text', () => {
  const FIXTURES: [string, Fixture][] = [
    ['empty', EMPTY],
    ['null rates', NULL_RATES],
    ['measured', MEASURED],
  ];

  it.each(FIXTURES)('%s: no banned wording, no em or en dash', async (_name, fixture) => {
    serve(fixture);
    const { container } = await mount({ canReset: true });
    expect(copyProblems(container.textContent ?? '')).toEqual([]);
  });

  it('empty: every series says there is no reading yet, and not one shows a headline or a chart', async () => {
    serve(EMPTY);
    await mount();
    for (const id of ['classification-category', 'classification-motivation', 'dismissal-rate', 'placement-survival', 'planloop-order']) {
      expect(screen.getByTestId(`learning-empty-${id}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`learning-headline-${id}`)).toBeNull();
      expect(screen.queryByTestId(`learning-chart-${id}`)).toBeNull();
    }
    expect(screen.getByTestId('learning-empty-dismissal-rate').textContent).toMatch(/No readings yet/);
    // Nothing was measured, so nothing may look like a result.
    expect(textWithoutChart(screen.getByTestId('learning-panel'))).not.toMatch(/(^|[^0-9])0%/);
  });

  it('null rates: every series is "not measured", never a number, and no standalone 0% anywhere', async () => {
    serve(NULL_RATES);
    await mount();
    for (const [loop, series] of [['classification', 'category'], ['classification', 'motivation'], ['dismissal', 'rate'], ['placement', 'survival'], ['planloop', 'order']] as const) {
      expect(headlineOf(loop, series)).toHaveAttribute('data-state', 'not-measured');
      expect(headlineOf(loop, series).textContent).toMatch(/^(Day order: )?Not measured/);
      expect(screen.queryByTestId(`learning-empty-${loop}-${series}`)).toBeNull();
    }
    const text = textWithoutChart(screen.getByTestId('learning-panel'));
    expect(text).not.toMatch(/(^|[^0-9])0%/);
    expect(text).toMatch(/not measured/i);
    // The readings tables say it in their cells too.
    expect(within(screen.getByTestId('learning-readings-dismissal-rate')).getAllByText(COMMON.notMeasured).length).toBeGreaterThan(0);
  });

  it('null rates: a card with nothing measured opens its "More about this number" block', async () => {
    serve(NULL_RATES);
    await mount();
    for (const loop of LOOPS) expect((screen.getByTestId(`learning-more-${loop}`) as HTMLDetailsElement).open).toBe(true);
  });

  it('measured: the block stays closed and a real number is shown', async () => {
    await mount();
    for (const loop of LOOPS) expect((screen.getByTestId(`learning-more-${loop}`) as HTMLDetailsElement).open).toBe(false);
    expect(textWithoutChart(screen.getByTestId('learning-panel'))).not.toMatch(/No readings yet/);
  });

  it('a real zero is printed as a zero, and only a missing measurement is a gap', async () => {
    serve({
      ...MEASURED,
      dismissal: { trend: [{ computed_date: '2026-10-26', period_days: 7, created: 12, decided: 12, dismissed: 0, rate: 0, exemplars: 0, hinted: 0 }] },
    });
    await mount();
    expect(headlineOf('dismissal', 'rate')).toHaveAttribute('data-state', 'measured');
    expect(headlineOf('dismissal', 'rate').textContent).toMatch(/0% dismissed \(0 of 12 decisions\)/);
  });

  it('never prints a suggestion count from "created", which is not the denominator of the rate', async () => {
    serve({
      ...MEASURED,
      dismissal: { trend: [{ computed_date: '2026-10-26', period_days: 7, created: 4242, decided: 14, dismissed: 5, rate: 0.357, exemplars: 23, hinted: 1 }] },
    });
    await mount();
    expect(screen.getByTestId('learning-card-dismissal').textContent).not.toContain('4242');
  });
});

// ── Context from the stores ──────────────────────────────────────────────────

describe('LearningPanel: the model-off and AI-ordering-off lines', () => {
  const modelLine = (loop: 'classification' | 'planloop') => screen.queryAllByTestId(`learning-context-${loop}`).map((e) => e.textContent ?? '');
  const MODEL_OFF = /local model is not ready/;

  it('shows nothing while integrations are still loading (aiAvailable() is false then, but unknown)', async () => {
    store.set({ integrations: 'pending', prefs: 'pending' });
    await mount();
    expect(modelLine('classification')).toEqual([]);
    expect(modelLine('planloop')).toEqual([]);
  });

  it('shows nothing when integrations failed to load, and does not read the errored resource', async () => {
    store.set({ integrations: 'errored', prefs: 'errored' });
    await mount(); // the mocked resources throw when read; a panel that read them would not render
    expect(modelLine('classification')).toEqual([]);
    expect(modelLine('planloop')).toEqual([]);
  });

  it('keeps saying the model is off while integrations and prefs are being refetched: refreshing is still known', async () => {
    // createResource reports 'refreshing' during a refetch, with the old value still readable. A
    // panel that took that for "not loaded" would drop both lines on every refetch.
    store.set({ integrations: 'refreshing', ollama: { ready: false }, prefs: 'refreshing', planningMode: 'manual' });
    await mount();
    expect(modelLine('classification')).toHaveLength(1);
    expect(modelLine('classification')[0]).toMatch(MODEL_OFF);
    expect(modelLine('planloop').some((t) => MODEL_OFF.test(t))).toBe(true);
    expect(modelLine('planloop').some((t) => /AI day ordering is off/.test(t))).toBe(true);
  });

  it('does not drop the lines when a loaded store starts refreshing', async () => {
    store.set({ integrations: 'ready', ollama: { ready: false }, prefs: 'ready', planningMode: 'manual' });
    await mount();
    expect(modelLine('classification')).toHaveLength(1);
    store.set({ integrations: 'refreshing', prefs: 'refreshing' });
    await Promise.resolve();
    expect(modelLine('classification')).toHaveLength(1);
    expect(modelLine('planloop').some((t) => /AI day ordering is off/.test(t))).toBe(true);
  });

  it('shows the model line on the classification and plan-loop cards once the local model is known to be off', async () => {
    store.set({ integrations: 'ready', ollama: { ready: false, available: false } });
    await mount();
    expect(modelLine('classification')).toHaveLength(1);
    expect(modelLine('classification')[0]).toMatch(MODEL_OFF);
    expect(modelLine('planloop').some((t) => MODEL_OFF.test(t))).toBe(true);
    // The two weekly loops that need no model say nothing about it.
    expect(screen.queryAllByTestId('learning-context-placement')).toHaveLength(0);
    expect(screen.queryAllByTestId('learning-context-dismissal')).toHaveLength(0);
  });

  it('uses `ready` before `available`, as aiAvailable() does', async () => {
    store.set({ integrations: 'ready', ollama: { ready: false, available: true } });
    await mount();
    expect(modelLine('classification')[0]).toMatch(MODEL_OFF);
  });

  it('shows nothing when the local model is reachable', async () => {
    store.set({ integrations: 'ready', ollama: { ready: true } });
    await mount();
    expect(modelLine('classification')).toEqual([]);
    expect(modelLine('planloop')).toEqual([]);
  });

  it('appears without a new read when integrations finish loading after the panel is open', async () => {
    await mount();
    expect(modelLine('classification')).toEqual([]);
    store.set({ integrations: 'ready', ollama: { ready: false } });
    await waitFor(() => expect(modelLine('classification')).toHaveLength(1));
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(1);
    store.set({ ollama: { ready: true } });
    await waitFor(() => expect(modelLine('classification')).toEqual([]));
  });

  it('says AI day ordering is off only when the preference is known and is not smart', async () => {
    const OFF = /AI day ordering is off/;
    store.set({ prefs: 'pending' });
    const first = await mount();
    expect(modelLine('planloop').some((t) => OFF.test(t))).toBe(false);
    first.unmount();

    store.set({ prefs: 'ready', planningMode: 'smart' });
    const second = await mount();
    expect(modelLine('planloop').some((t) => OFF.test(t))).toBe(false);
    second.unmount();

    store.set({ prefs: 'ready', planningMode: 'manual' });
    await mount();
    expect(modelLine('planloop').some((t) => OFF.test(t))).toBe(true);
  });

  it('lets a test override win over the derived context', async () => {
    store.set({ integrations: 'ready', ollama: { ready: false } });
    await mount({ context: { aiAvailable: null } });
    expect(modelLine('classification')).toEqual([]);
  });
});

describe('LearningPanel: "now" is taken when the panel opens', () => {
  it('reads the age of the latest reading from the open time, and a reopen counts again', async () => {
    const first = await mount();
    expect(headlineOf('dismissal', 'rate')).toBeInTheDocument();
    expect(screen.getByTestId('learning-detail-dismissal-rate').textContent).toMatch(/Latest reading: Oct 26 \(2 days ago\)/);
    expect(screen.queryAllByTestId('learning-context-dismissal')).toHaveLength(0); // 2 days: not stale
    first.unmount();

    vi.setSystemTime(new Date(2026, 10, 10, 12, 0, 0)); // 15 days after the newest reading
    await mount();
    expect(screen.getByTestId('learning-detail-dismissal-rate').textContent).toMatch(/Latest reading: Oct 26 \(15 days ago\)/);
    expect(screen.getByTestId('learning-context-dismissal').textContent).toMatch(/No new reading for 15 days/);
    expect(screen.getByTestId('learning-context-placement').textContent).toMatch(/No new reading for 15 days/);
    // Classification and plan loop write no row in a quiet week, so an old reading there is no alarm.
    expect(screen.queryAllByTestId('learning-context-classification')).toHaveLength(0);
    expect(screen.queryAllByTestId('learning-context-planloop')).toHaveLength(0);
  });
});

// ── Clearing ─────────────────────────────────────────────────────────────────

describe('LearningPanel: who can clear', () => {
  const noButtons = () => {
    for (const loop of ['classification', 'dismissal', 'placement'] as const) expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull();
    expect(screen.queryByRole('button', { name: /clear|reset/i })).toBeNull();
  };
  const readOnly = (loop: Loop) => screen.queryByTestId(`learning-readonly-${loop}`);

  it('canReset true (and omitted): the three buttons, each with its literal label, and none for plan loop', async () => {
    for (const props of [{ canReset: true }, {}]) {
      const { unmount } = await mount(props);
      for (const loop of ['classification', 'dismissal', 'placement'] as const) {
        expect(within(card(loop)).getByTestId(`learning-reset-${loop}`)).toHaveTextContent(RESET_BUTTON[loop]);
        expect(within(card(loop)).getByTestId(`learning-reset-hint-${loop}`).textContent).toMatch(/Monday/);
        expect(readOnly(loop)).toBeNull();
      }
      expect(within(card('planloop')).queryByRole('button', { name: /clear|reset/i })).toBeNull();
      expect(readOnly('planloop')).toBeNull();
      unmount();
    }
  });

  it('plan loop says there is nothing to clear, and why, to everyone', async () => {
    for (const canReset of [true, false, null]) {
      const { unmount } = await mount({ canReset });
      expect(card('planloop').textContent).toMatch(/Nothing to clear\. This readout does not change how plans are made/);
      expect(within(card('planloop')).queryByRole('button', { name: /clear|reset/i })).toBeNull();
      unmount();
    }
  });

  it('canReset false (a viewer): the read-only note on the three clearable cards, none on plan loop, no buttons', async () => {
    await mount({ canReset: false });
    noButtons();
    for (const loop of ['classification', 'dismissal', 'placement'] as const) {
      expect(readOnly(loop)).toHaveTextContent(COMMON.readOnlyNote);
    }
    expect(readOnly('planloop')).toBeNull();
    // The readings are still all there to read.
    expect(headlineOf('dismissal', 'rate').textContent).toContain('5 of 14');
  });

  it('canReset null (account still loading): neither a button nor the read-only note', async () => {
    await mount({ canReset: null });
    noButtons();
    for (const loop of LOOPS) expect(readOnly(loop)).toBeNull();
    expect(screen.getByTestId('learning-panel').textContent).not.toContain(COMMON.readOnlyNote);
  });

  it('follows the account as it loads, with no new read: unknown, then allowed, then a viewer', async () => {
    const [canReset, setCanReset] = createSignal<boolean | null>(null);
    render(() => <LearningPanel canReset={canReset()} />);
    await settled();
    noButtons();

    setCanReset(true);
    await waitFor(() => expect(screen.getByTestId('learning-reset-dismissal')).toBeInTheDocument());

    setCanReset(false);
    await waitFor(() => expect(readOnly('dismissal')).toBeInTheDocument());
    noButtons();
    for (const loop of LOOPS) expect(READ[loop]).toHaveBeenCalledTimes(1);
  });

  it('shows no clear button where nothing is stored, and says so', async () => {
    serve(EMPTY);
    await mount({ canReset: true });
    noButtons();
    expect(screen.getByTestId('learning-nothing-to-clear-classification')).toBeInTheDocument();
    expect(screen.getByTestId('learning-nothing-to-clear-dismissal').textContent).toMatch(/nothing to clear/i);
    expect(screen.getByTestId('learning-nothing-to-clear-placement').textContent).toMatch(/nothing to clear/i);
  });

  it('offers no clear for dismissal or placement when the newest reading shows nothing stored', async () => {
    serve({
      ...MEASURED,
      dismissal: { trend: [{ ...DISMISSAL_MEASURED.trend[2], exemplars: 0 }] },
      placement: { runs: [{ ...PLACEMENT_MEASURED.runs[0], keys_learned: 0 }] },
    });
    await mount({ canReset: true });
    expect(screen.queryByTestId('learning-reset-dismissal')).toBeNull();
    expect(screen.queryByTestId('learning-reset-placement')).toBeNull();
    expect(screen.getByTestId('learning-reset-classification')).toBeInTheDocument();
  });
});

describe('LearningPanel: clearing', () => {
  it.each([
    ['classification', 'resetClassification', 7],
    ['dismissal', 'resetDismissal', 23],
    ['placement', 'resetPlacement', 2],
  ] as const)('%s: Cancel on the confirm makes no request', async (loop, fn, _cleared) => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    await mount({ canReset: true });
    fireEvent.click(screen.getByTestId(`learning-reset-${loop}`));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(m[fn]).not.toHaveBeenCalled();
    expect(m.showToast).not.toHaveBeenCalled();
    expect(screen.getByTestId(`learning-reset-${loop}`)).toBeInTheDocument();
  });

  it.each([
    ['classification', 'resetClassification', 7],
    ['dismissal', 'resetDismissal', 23],
    ['placement', 'resetPlacement', 2],
  ] as const)('%s: a confirmed clear makes one request, toasts, and re-reads nothing', async (loop, fn, cleared) => {
    await mount({ canReset: true });
    fireEvent.click(screen.getByTestId(`learning-reset-${loop}`));
    await waitFor(() => expect(m.showToast).toHaveBeenCalledTimes(1));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(m[fn]).toHaveBeenCalledTimes(1);
    expect(m.showToast.mock.calls[0][0]).toContain(String(cleared));
    expect(m.showToast.mock.calls[0][1]).toBe('success');
    // The readings cannot change before Monday, so no card is read again and the button is gone.
    for (const l of LOOPS) expect(READ[l]).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull());
    // The other two cards are untouched.
    for (const other of (['classification', 'dismissal', 'placement'] as const).filter((l) => l !== loop)) {
      expect(screen.getByTestId(`learning-reset-${other}`)).toBeInTheDocument();
    }
  });

  it('a clear that finds nothing says so and stops offering the button', async () => {
    m.resetPlacement.mockResolvedValue(OK(0));
    await mount({ canReset: true });
    fireEvent.click(screen.getByTestId('learning-reset-placement'));
    await waitFor(() => expect(m.showToast).toHaveBeenCalledTimes(1));
    expect(m.showToast.mock.calls[0][0]).toMatch(/Nothing to clear/);
    expect(m.showToast.mock.calls[0][1]).not.toBe('error');
    await waitFor(() => expect(screen.getByTestId('learning-nothing-to-clear-placement')).toBeInTheDocument());
    expect(screen.queryByTestId('learning-reset-placement')).toBeNull();
  });

  it('a failed clear toasts one fixed sentence as an error, says it beside the button, and leaves the button to try again', async () => {
    m.resetDismissal.mockRejectedValue(failure(500, 'database is locked'));
    await mount({ canReset: true });
    fireEvent.click(screen.getByTestId('learning-reset-dismissal'));
    await waitFor(() => expect(m.showToast).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    expect(m.showToast).not.toHaveBeenCalledWith('database is locked', expect.anything());
    expect(screen.getByTestId('learning-reset-dismissal-error').textContent).toBe(COMMON.clearFailed);
    expect(screen.getByTestId('learning-reset-dismissal')).toBeInTheDocument();
    expect(screen.queryByTestId('learning-readonly-dismissal')).toBeNull();
  });

  it('a 403 from one clear turns every card read-only for the session, with one toast', async () => {
    m.resetDismissal.mockRejectedValue(failure(403, 'forbidden'));
    const onResetForbidden = vi.fn();
    await mount({ canReset: true, context: { onResetForbidden } });

    fireEvent.click(screen.getByTestId('learning-reset-dismissal'));
    await waitFor(() => expect(screen.getByTestId('learning-readonly-dismissal')).toBeInTheDocument());

    for (const loop of ['classification', 'dismissal', 'placement'] as const) {
      expect(screen.getByTestId(`learning-readonly-${loop}`)).toHaveTextContent(COMMON.readOnlyNote);
      expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull();
    }
    expect(screen.queryByTestId('learning-readonly-planloop')).toBeNull();

    expect(m.showToast).toHaveBeenCalledTimes(1);
    expect(m.showToast).toHaveBeenCalledWith(COMMON.forbiddenToast, 'error');
    expect(onResetForbidden).toHaveBeenCalledTimes(1);
    // Only the one that was refused was ever tried.
    expect(m.resetDismissal).toHaveBeenCalledTimes(1);
    expect(m.resetClassification).not.toHaveBeenCalled();
    expect(m.resetPlacement).not.toHaveBeenCalled();
    // The readings stay.
    expect(headlineOf('classification', 'category').textContent).toContain('9 of 12');
  });

  it('after a 403 a later "allowed" from the account does not bring the buttons back', async () => {
    m.resetClassification.mockRejectedValue(failure(403, 'forbidden'));
    const [canReset, setCanReset] = createSignal<boolean | null>(true);
    render(() => <LearningPanel canReset={canReset()} />);
    await settled();
    fireEvent.click(screen.getByTestId('learning-reset-classification'));
    await waitFor(() => expect(screen.getByTestId('learning-readonly-classification')).toBeInTheDocument());

    setCanReset(null);
    setCanReset(true);
    await Promise.resolve();
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
    expect(screen.getByTestId('learning-readonly-classification')).toBeInTheDocument();
  });
});

describe('LearningPanel: a refused clear lasts for the browser session', () => {
  // Settings mounts the panel inside a <Show>, so leaving the tab and coming back is a NEW panel. A flag
  // held only in the panel would be gone, the buttons would come back, and the next click would be
  // refused again, with another toast. The comments say "for the session"; this is what makes that true.
  const CLEARABLE = ['classification', 'dismissal', 'placement'] as const;
  const KEY = 'planning.learning.cleared.v1';

  async function getRefused(props: Parameters<typeof LearningPanel>[0] = { canReset: true }) {
    m.resetClassification.mockRejectedValue(failure(403, 'forbidden'));
    const first = await mount(props);
    fireEvent.click(screen.getByTestId('learning-reset-classification'));
    await waitFor(() => expect(screen.getByTestId('learning-readonly-classification')).toBeInTheDocument());
    return first;
  }

  it('leaving the tab and coming back offers no clear, and asks the server nothing more', async () => {
    const first = await getRefused();
    first.unmount();

    await mount({ canReset: true }); // a fresh panel, as when the tab is reopened
    for (const loop of CLEARABLE) {
      expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull();
      expect(screen.getByTestId(`learning-readonly-${loop}`)).toHaveTextContent(COMMON.readOnlyNote);
    }
    expect(screen.queryByTestId('learning-readonly-planloop')).toBeNull();
    expect(m.resetClassification).toHaveBeenCalledTimes(1);
    expect(m.showToast).toHaveBeenCalledTimes(1); // the first refusal's only
  });

  it('is written to sessionStorage itself, for the owner who was refused', async () => {
    await getRefused({ canReset: true, owner: 'owner-a' });
    const saved = JSON.parse(sessionStorage.getItem(KEY)!);
    expect(saved.owner).toBe('owner-a');
    expect(saved.forbidden).toBe(true);
  });

  it('is per account: another account in the same tab is still offered the clear', async () => {
    const first = await getRefused({ canReset: true, owner: 'owner-a' });
    first.unmount();

    const other = await mount({ canReset: true, owner: 'owner-b' });
    for (const loop of CLEARABLE) expect(screen.getByTestId(`learning-reset-${loop}`)).toBeInTheDocument();
    other.unmount();

    await mount({ canReset: true, owner: 'owner-a' });
    for (const loop of CLEARABLE) expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull();
  });

  it('a viewer, or an account that was never refused, is not affected by someone else having been', async () => {
    await mount({ canReset: true });
    for (const loop of CLEARABLE) expect(screen.getByTestId(`learning-reset-${loop}`)).toBeInTheDocument();
  });
});

describe('LearningPanel: keyboard focus after a clear', () => {
  it('a clear leaves focus on the new status line of that card, not on the page', async () => {
    await mount({ canReset: true });
    const button = screen.getByTestId('learning-reset-dismissal');
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId('learning-reset-dismissal')).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId('learning-status-dismissal'));
    // And a screen reader is told, through the card's own live region.
    expect(screen.getByTestId('learning-announce-dismissal')).toHaveTextContent('Cleared 23 past dismissals.');
  });

  it('a refused clear leaves focus on the read-only note of the card that was refused, and no other card takes it', async () => {
    m.resetDismissal.mockRejectedValue(failure(403, 'forbidden'));
    await mount({ canReset: true });
    const button = screen.getByTestId('learning-reset-dismissal');
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('learning-readonly-dismissal')).toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('learning-readonly-dismissal'));
    expect(screen.getByTestId('learning-announce-dismissal')).toHaveTextContent(COMMON.forbiddenToast);
    for (const other of ['classification', 'placement']) {
      expect(screen.getByTestId(`learning-announce-${other}`).textContent).toBe('');
    }
  });

  it('a Try again keeps focus in its card and says the readings loaded', async () => {
    m.dismissalTrend.mockRejectedValueOnce(failure(500, 'boom'));
    await mount({ canReset: true });
    const retry = screen.getByTestId('learning-retry-dismissal');
    retry.focus();
    fireEvent.click(retry);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Suggestions you dismiss' }));
    await waitFor(() => expect(screen.getByTestId('learning-announce-dismissal')).toHaveTextContent(COMMON.loaded));
    expect(headlineOf('dismissal', 'rate')).toBeInTheDocument();
    // The other cards said nothing: only a Try again is announced.
    expect(screen.getByTestId('learning-announce-classification').textContent).toBe('');
  });
});

// ── Leaving the tab and coming back ──────────────────────────────────────────

describe('LearningPanel: a clear is remembered when the tab is left and reopened', () => {
  // The wire reports how many examples or preferences were stored AS OF THE LAST MONDAY PASS, and a
  // clear writes no row. Without a memory, an owner who clears, opens Profile and comes back is
  // told again that the model can draw on the old count, and is offered the same button.
  const CASES = [
    ['classification', 'resetClassification', /^Cleared on Oct 28\. The model is shown no examples until Monday's pass\.$/],
    ['dismissal', 'resetDismissal', /^Cleared on Oct 28\. The model is shown no past dismissals until Monday's pass\.$/],
    ['placement', 'resetPlacement', /^Cleared on Oct 28\. Auto chooses with no hour preference until Monday's pass\.$/],
  ] as const;
  const CLEARABLE = ['classification', 'dismissal', 'placement'] as const;

  async function clearAndLeave(loop: (typeof CLEARABLE)[number], props: Parameters<typeof LearningPanel>[0] = { canReset: true }) {
    const first = await mount(props);
    fireEvent.click(screen.getByTestId(`learning-reset-${loop}`));
    await waitFor(() => expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull());
    first.unmount();
  }

  it.each(CASES)('%s: the reopened card says it was cleared, dates it, and offers nothing more to clear', async (loop, fn, status) => {
    await clearAndLeave(loop);
    expect(m[fn]).toHaveBeenCalledTimes(1);

    await mount({ canReset: true }); // a fresh mount and a fresh read
    for (const l of LOOPS) expect(READ[l]).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId(`learning-reset-${loop}`)).toBeNull();
    expect(screen.getByTestId(`learning-status-${loop}`).textContent).toMatch(status);
    expect(screen.getByTestId(`learning-nothing-to-clear-${loop}`)).toBeInTheDocument();
    // The old count is no longer presented as current.
    expect(card(loop).textContent).not.toMatch(/past dismissals were stored|had hour preferences for/);
    // The readings themselves stay: only the claim about what is stored changes.
    expect(card(loop).querySelectorAll('[data-testid^="learning-headline-"]').length).toBeGreaterThan(0);
    // And nothing is cleared a second time without being asked.
    expect(m[fn]).toHaveBeenCalledTimes(1);
  });

  it.each(CASES)('%s: only that loop is affected; the other two still offer their clear', async (loop, _fn, _status) => {
    await clearAndLeave(loop);
    await mount({ canReset: true });
    for (const other of CLEARABLE.filter((l) => l !== loop)) {
      expect(screen.getByTestId(`learning-reset-${other}`)).toBeInTheDocument();
    }
  });

  it('shows the plain Monday count again once a newer reading arrives', async () => {
    await clearAndLeave('dismissal');
    // The next Monday pass ran: a reading dated after the clear, with a fresh set stored.
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
    m.dismissalTrend.mockResolvedValue({
      trend: [...DISMISSAL_MEASURED.trend, { computed_date: '2026-11-02', period_days: 7, created: 2, decided: 3, dismissed: 1, rate: 0.333, exemplars: 9, hinted: 0 }],
    });
    await mount({ canReset: true });
    expect(screen.getByTestId('learning-status-dismissal').textContent).toContain('At the Nov 2 reading, 9 past dismissals were stored.');
    expect(screen.getByTestId('learning-reset-dismissal')).toBeInTheDocument();
  });

  it('a clear that found nothing is not remembered', async () => {
    m.resetPlacement.mockResolvedValue(OK(0));
    const first = await mount({ canReset: true });
    fireEvent.click(screen.getByTestId('learning-reset-placement'));
    await waitFor(() => expect(screen.getByTestId('learning-nothing-to-clear-placement')).toBeInTheDocument());
    first.unmount();
    await mount({ canReset: true });
    expect(screen.getByTestId('learning-reset-placement')).toBeInTheDocument();
    expect(screen.getByTestId('learning-status-placement').textContent).toContain('At the Oct 26 reading, Auto had hour preferences for 2 directions.');
  });

  it('a failed or refused clear is not remembered', async () => {
    m.resetDismissal.mockRejectedValue(failure(500, 'database is locked'));
    const first = await mount({ canReset: true });
    fireEvent.click(screen.getByTestId('learning-reset-dismissal'));
    await waitFor(() => expect(m.showToast).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    first.unmount();
    await mount({ canReset: true });
    expect(screen.getByTestId('learning-reset-dismissal')).toBeInTheDocument();
    expect(screen.getByTestId('learning-status-dismissal').textContent).toContain('At the Oct 26 reading');
  });

  it('is kept per account: the same account sees it, another account in the same tab does not', async () => {
    await clearAndLeave('classification', { canReset: true, owner: 'owner-a' });

    const again = await mount({ canReset: true, owner: 'owner-a' });
    expect(screen.queryByTestId('learning-reset-classification')).toBeNull();
    again.unmount();

    await mount({ canReset: true, owner: 'owner-b' });
    expect(screen.getByTestId('learning-reset-classification')).toBeInTheDocument();
    expect(screen.queryByTestId('learning-status-classification')).toBeNull();
  });

  it('a viewer who never cleared anything sees the read-only note, not a stale "cleared" line', async () => {
    await mount({ canReset: false });
    for (const loop of CLEARABLE) {
      expect(screen.getByTestId(`learning-readonly-${loop}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`learning-status-${loop}`)?.textContent ?? '').not.toMatch(/^Cleared/);
    }
  });

  it('lets a test override of the context win over the remembered clear', async () => {
    await clearAndLeave('dismissal');
    await mount({ canReset: true, context: { clearedOn: {} } });
    expect(screen.getByTestId('learning-reset-dismissal')).toBeInTheDocument();
  });
});
