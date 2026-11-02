import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { localISODate } from '../../lib/dates.js';
import { clearedMemory } from '../../lib/learning-cleared.js';
import { COMMON, copyProblems } from '../../lib/learning-copy.js';
import type { LearningResetResult } from '../../lib/api.js';
import type { LearningCardProps, ResetSpec, SeriesView, TileView } from './LearningCard.js';
import { ZERO_PERCENT, textWithoutChart } from './learning-test-helpers.js';

/**
 * LearningCard: the one frame every card renders through, tested with hand-built props so
 * neither the api nor a tile is involved. Each tile's own test then only has to check what it
 * says; this file checks what the frame guarantees for all of them:
 *
 *   - the always-visible caveat is there in every state, and does not wait for data;
 *   - a failed read shows only its message and Try again, never an empty-state sentence;
 *   - a series is drawn from strings it was given, and a not-measured one never shows 0%;
 *   - the clear control appears only when it should, locks while it runs, and never refetches;
 *   - keyboard focus is never dropped: the control that had it is replaced by a sentence, and
 *     focus moves there; every result is also said through one always-mounted live region;
 *   - what the card counts and changes sits in a disclosure that is open only when nothing is
 *     measured yet;
 *   - every button is type="button".
 */

const toast = vi.fn();
vi.mock('../../stores/index.js', () => ({ showToast: (...a: unknown[]) => toast(...a) }));

const { LearningCard } = await import('./LearningCard.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const POINTS = [
  { date: '2026-10-19', value: 0.75, n: 4, label: 'Oct 19: 3 of 4' },
  { date: '2026-10-26', value: 0.5, n: 4, label: 'Oct 26: 2 of 4' },
];

const measured = (over: Partial<SeriesView> = {}): SeriesView => ({
  key: 'rate',
  label: null,
  state: 'measured',
  headline: '2 of 4 things happened, in the 7 days to Oct 26.',
  detail: 'Latest reading: Oct 26 (6 days ago).',
  notes: ['Last measured: 3 of 4 on Oct 19.'],
  comparison: 'Not enough cases to compare yet.',
  empty: null,
  chart: { points: POINTS, cadenceDays: 7, marker: null, caption: 'Each dot is one weekly reading.' },
  readings: {
    columns: ['Date', 'Decided', 'Share'],
    rows: [
      { key: '2026-10-26', cells: ['Oct 26', '4', 'under 10 cases'] },
      { key: '2026-10-19', cells: ['Oct 19', '4', 'under 10 cases'] },
    ],
  },
  ...over,
});
const notMeasured = (): SeriesView =>
  measured({
    state: 'not-measured',
    headline: 'Not measured: nothing was decided in the 7 days to Oct 26.',
    detail: 'Latest reading: Oct 26 (6 days ago).',
    notes: [],
    comparison: null,
    chart: {
      points: [{ date: '2026-10-26', value: null, n: 0, label: 'Oct 26: not measured' }],
      cadenceDays: 7,
      marker: null,
      caption: 'Each dot is one weekly reading.',
    },
    readings: { columns: ['Date', 'Decided', 'Share'], rows: [{ key: '2026-10-26', cells: ['Oct 26', '0', 'not measured'] }] },
  });
const none = (): SeriesView => ({
  key: 'rate',
  label: null,
  state: 'none',
  headline: null,
  detail: null,
  notes: [],
  comparison: null,
  empty: 'No readings yet. A reading is added every Monday.',
  chart: null,
  readings: null,
});
const tile = (series: SeriesView[], over: Partial<TileView> = {}): TileView => ({
  series,
  contextLines: [],
  status: null,
  startOpen: series.every((s) => s.state !== 'measured'),
  resetAvailable: true,
  ...over,
});

const run = vi.fn(async (): Promise<LearningResetResult> => ({ ok: true, cleared: 5 }));
const RESET: ResetSpec = {
  label: 'Clear learned things',
  hint: "Removes the things. Your history is kept, so Monday's pass builds them again.",
  confirmText: 'Clear them?',
  run: () => run(),
  clearedMessage: (n) => `Cleared ${n} things.`,
  emptyMessage: 'Nothing to clear. No things are stored.',
  doneStatus: "Cleared. Nothing is shown until Monday's pass.",
  nothingToClear: 'No things are stored, so there is nothing to clear.',
};

const onRetry = vi.fn();
const onResetForbidden = vi.fn();

function props(over: Partial<LearningCardProps> = {}): LearningCardProps {
  return {
    loopKey: 'dismissal',
    title: 'Things you dismiss',
    meaning: 'What it counts, in words.',
    changes: 'What it changes, in words.',
    primaryCaveat: 'The one thing this number does not show.',
    moreCaveats: ['Second caveat.', 'Third caveat.'],
    howToStart: 'How to get it going.',
    status: 'ready',
    onRetry,
    view: tile([measured()]),
    canReset: true,
    onResetForbidden,
    reset: RESET,
    ...over,
  };
}
function mount(over: Partial<LearningCardProps> = {}) {
  return render(() => <LearningCard {...props(over)} />);
}
const card = () => screen.getByTestId('learning-card-dismissal');
const id = (what: string) => `learning-${what}-dismissal`;

beforeEach(() => {
  run.mockReset().mockResolvedValue({ ok: true, cleared: 5 });
  toast.mockReset();
  onRetry.mockReset();
  onResetForbidden.mockReset();
  clearedMemory.bind('');
  clearedMemory.forget();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => vi.unstubAllGlobals());

// ── Always there ─────────────────────────────────────────────────────────────

describe('LearningCard: what is there in every state', () => {
  it.each([
    ['loading', { status: 'loading' as const, view: null }],
    ['error', { status: 'error' as const, view: null, error: { kind: 'failed' as const, message: COMMON.errorFailed } }],
    ['ready', {}],
  ])('the title, the meaning, what it changes and the always-visible caveat in %s', (_name, over) => {
    mount(over);
    expect(screen.getByRole('heading', { name: 'Things you dismiss' })).toBeInTheDocument();
    expect(card().textContent).toContain('What it counts, in words.');
    expect(card().textContent).toContain('What it changes, in words.');
    expect(screen.getByTestId(id('primary-caveat')).textContent).toBe('The one thing this number does not show.');
  });

  it('puts the caveat before any data, so it is read first', () => {
    mount();
    const caveat = screen.getByTestId(id('primary-caveat'));
    const headline = screen.getByTestId('learning-headline-dismissal-rate');
    expect(caveat.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits what-it-changes when there is none', () => {
    mount({ changes: null });
    expect(card().textContent).not.toContain('What it changes');
  });

  it('is a labelled region named by its title', () => {
    mount();
    expect(card().tagName).toBe('SECTION');
    const labelledBy = card().getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)!.textContent).toBe('Things you dismiss');
  });
});

describe('LearningCard: loading', () => {
  it('shows only the loading text under the caveat: no series, no error, no reset, no details', () => {
    mount({ status: 'loading', view: null });
    expect(within(card()).getByText(COMMON.loading)).toBeInTheDocument();
    expect(screen.queryByTestId(id('error'))).toBeNull();
    expect(screen.queryAllByTestId(/^learning-headline-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^learning-empty-/)).toHaveLength(0);
    expect(screen.queryByTestId(id('reset'))).toBeNull();
    expect(screen.queryByTestId(id('more'))).toBeNull();
    expect(card().textContent).not.toMatch(/No readings yet/);
  });

  it('says it in a status role, so a screen reader hears that the read started', () => {
    mount({ status: 'loading', view: null });
    const loading = screen.getByText(COMMON.loading);
    expect(loading.getAttribute('role')).toBe('status');
    expect(within(card()).getAllByRole('status').map((e) => e.textContent)).toContain(COMMON.loading);
  });
});

// ── A failed read ────────────────────────────────────────────────────────────

describe('LearningCard: a failed read', () => {
  it.each([
    ['failed', COMMON.errorFailed],
    ['offline', COMMON.errorOffline],
    ['unsupported', COMMON.errorUnsupported],
  ] as const)('%s shows exactly its own message and a Try again button', (kind, message) => {
    mount({ status: 'error', view: null, error: { kind, message } });
    expect(screen.getByTestId(id('error')).textContent).toContain(message);
    expect(screen.getByTestId(id('retry')).textContent).toBe('Try again');
  });

  it('Try again calls onRetry once per click, and is a type="button"', () => {
    mount({ status: 'error', view: null, error: { kind: 'failed', message: COMMON.errorFailed } });
    const retry = screen.getByTestId(id('retry')) as HTMLButtonElement;
    expect(retry.type).toBe('button');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('is announced as an alert', () => {
    mount({ status: 'error', view: null, error: { kind: 'failed', message: COMMON.errorFailed } });
    expect(screen.getByRole('alert')).toBe(screen.getByTestId(id('error')));
  });

  it('never says "No readings yet", and never draws a series, a chart or a reset, even if a view is still passed', () => {
    // A stale view from before the failure must not leak through.
    mount({ status: 'error', view: tile([measured()]), error: { kind: 'failed', message: COMMON.errorFailed } });
    expect(card().textContent).not.toMatch(/No readings yet/i);
    expect(card().textContent).not.toMatch(/no reading yet/i);
    expect(screen.queryAllByTestId(/^learning-headline-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^learning-chart-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^learning-empty-/)).toHaveLength(0);
    expect(screen.queryByTestId(id('reset'))).toBeNull();
    expect(screen.queryByTestId(id('no-reset'))).toBeNull();
  });

  it('falls back to the generic message if none was given', () => {
    mount({ status: 'error', view: null });
    expect(screen.getByTestId(id('error')).textContent).toContain(COMMON.errorFailed);
  });

  it('Try again keeps keyboard focus in the card instead of dropping it when the error block is replaced', () => {
    mount({ status: 'error', view: null, error: { kind: 'failed', message: COMMON.errorFailed } });
    const retry = screen.getByTestId(id('retry'));
    retry.focus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Things you dismiss' }));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('says "Readings loaded." to a screen reader once a Try again has finished, and only then', async () => {
    const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('error');
    render(() => (
      <LearningCard
        {...props({
          get status() {
            return status();
          },
          get view() {
            return status() === 'ready' ? tile([measured()]) : null;
          },
          error: { kind: 'failed', message: COMMON.errorFailed },
        })}
      />
    ));
    const live = screen.getByTestId(id('announce'));
    expect(live.textContent).toBe('');
    fireEvent.click(screen.getByTestId(id('retry')));
    setStatus('loading'); // what useReadout does as the retry starts
    await waitFor(() => expect(screen.getByText(COMMON.loading)).toBeInTheDocument());
    expect(live.textContent).toBe('');
    setStatus('ready');
    await waitFor(() => expect(live.textContent).toBe(COMMON.loaded));
    expect(screen.getByTestId(id('announce'))).toBe(live);
  });

  it('a Try again that fails again announces nothing extra (the alert says it), and a later first success is not announced', async () => {
    const [status, setStatus] = createSignal<'loading' | 'ready' | 'error'>('error');
    render(() => (
      <LearningCard
        {...props({
          get status() {
            return status();
          },
          get view() {
            return status() === 'ready' ? tile([measured()]) : null;
          },
          error: { kind: 'offline', message: COMMON.errorOffline },
        })}
      />
    ));
    const live = screen.getByTestId(id('announce'));
    fireEvent.click(screen.getByTestId(id('retry')));
    setStatus('loading');
    setStatus('error');
    await waitFor(() => expect(screen.getByTestId(id('retry'))).toBeInTheDocument());
    expect(live.textContent).toBe('');
    // A load that nobody asked for (no Try again pressed since) is not announced.
    setStatus('loading');
    setStatus('ready');
    await waitFor(() => expect(screen.queryByTestId(id('error'))).toBeNull());
    expect(live.textContent).toBe('');
  });
});

// ── A series ─────────────────────────────────────────────────────────────────

describe('LearningCard: a series with nothing yet', () => {
  it('shows its empty sentence, and no headline, chart or readings table', () => {
    mount({ view: tile([none()], { resetAvailable: false }) });
    expect(screen.getByTestId('learning-empty-dismissal-rate').textContent).toBe('No readings yet. A reading is added every Monday.');
    expect(screen.queryByTestId('learning-headline-dismissal-rate')).toBeNull();
    expect(screen.queryByTestId('learning-detail-dismissal-rate')).toBeNull();
    expect(screen.queryByTestId('learning-chart-dismissal-rate')).toBeNull();
    expect(screen.queryByTestId('learning-readings-dismissal-rate')).toBeNull();
    expect(screen.queryByTestId('learning-comparison-dismissal-rate')).toBeNull();
  });
});

describe('LearningCard: a series that measured nothing', () => {
  it('shows its Not measured headline with a chart (a tick) and no 0% anywhere outside the chart axis', () => {
    mount({ view: tile([notMeasured()]) });
    const h = screen.getByTestId('learning-headline-dismissal-rate');
    expect(h.getAttribute('data-state')).toBe('not-measured');
    expect(h.textContent).toMatch(/^Not measured/);
    expect(screen.getByTestId('learning-chart-dismissal-rate').querySelectorAll('[data-tick]')).toHaveLength(1);
    expect(screen.getByTestId('learning-chart-dismissal-rate').querySelectorAll('circle')).toHaveLength(0);
    expect(textWithoutChart(card())).not.toMatch(ZERO_PERCENT);
    expect(screen.getByTestId('learning-readings-dismissal-rate').textContent).toContain('not measured');
  });
});

describe('LearningCard: a measured series', () => {
  it('shows headline, detail, notes, chart, comparison in that order', () => {
    mount();
    const order = [
      screen.getByTestId('learning-headline-dismissal-rate'),
      screen.getByTestId('learning-detail-dismissal-rate'),
      screen.getByText('Last measured: 3 of 4 on Oct 19.'),
      screen.getByTestId('learning-chart-dismissal-rate'),
      screen.getByTestId('learning-comparison-dismissal-rate'),
      screen.getByTestId('learning-readings-dismissal-rate'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByTestId('learning-headline-dismissal-rate').getAttribute('data-state')).toBe('measured');
  });

  it('prints the strings it was given and adds no number of its own', () => {
    mount();
    expect(screen.getByTestId('learning-headline-dismissal-rate').textContent).toBe('2 of 4 things happened, in the 7 days to Oct 26.');
    expect(screen.getByTestId('learning-detail-dismissal-rate').textContent).toBe('Latest reading: Oct 26 (6 days ago).');
    expect(screen.getByTestId('learning-comparison-dismissal-rate').textContent).toBe('Not enough cases to compare yet.');
  });

  it('puts the chart caption under the chart', () => {
    mount();
    expect(card().textContent).toContain('Each dot is one weekly reading.');
  });

  it('names the chart for a screen reader with the series label when there is one, else the card title', () => {
    mount({ view: tile([measured({ label: 'Category' })]) });
    expect(screen.getByTestId('learning-chart-dismissal-rate').querySelector('svg')!.getAttribute('aria-label')).toContain('Category:');
  });

  it('names the chart, the table box and the table caption with the card title when the series has no label', () => {
    mount({ view: tile([measured({ label: null })]) });
    const chart = screen.getByTestId('learning-chart-dismissal-rate');
    expect(chart.querySelector('svg')!.getAttribute('aria-label')).toMatch(/^Things you dismiss: 2 readings from Oct 19 to Oct 26/);
    const readings = screen.getByTestId('learning-readings-dismissal-rate');
    expect(readings.querySelector('.overflow-x-auto')!.getAttribute('aria-label')).toBe(
      'Things you dismiss: readings table, scrolls sideways',
    );
    expect(readings.querySelector('caption')!.textContent).toBe('Things you dismiss: every weekly reading, newest first');
  });

  it('shows a sub-heading only when the series has a label', () => {
    mount({ view: tile([measured({ key: 'a', label: 'Category' }), measured({ key: 'b', label: 'Motivation (me, us, them)' })]) });
    expect(screen.getByRole('heading', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Motivation (me, us, them)' })).toBeInTheDocument();
    expect(screen.getByTestId('learning-headline-dismissal-a')).toBeInTheDocument();
    expect(screen.getByTestId('learning-headline-dismissal-b')).toBeInTheDocument();
  });

  it('renders each series with its own key, so two series never share a test id', () => {
    mount({ view: tile([measured({ key: 'a' }), none2('b')]) });
    expect(screen.getByTestId('learning-headline-dismissal-a')).toBeInTheDocument();
    expect(screen.getByTestId('learning-empty-dismissal-b')).toBeInTheDocument();
    expect(screen.queryByTestId('learning-headline-dismissal-b')).toBeNull();
  });
});

function none2(key: string): SeriesView {
  return { ...none(), key };
}

describe('LearningCard: the readings table', () => {
  it('is closed until opened and renders every cell verbatim, newest first as given', () => {
    mount();
    const details = screen.getByTestId('learning-readings-dismissal-rate') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText(COMMON.showReadings)).toBeInTheDocument();
    const rows = [...details.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(rows).toEqual([
      ['Oct 26', '4', 'under 10 cases'],
      ['Oct 19', '4', 'under 10 cases'],
    ]);
    expect([...details.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Date', 'Decided', 'Share']);
  });

  it('is a real table with scoped headers and a caption a screen reader can use', () => {
    mount();
    const table = screen.getByTestId('learning-readings-dismissal-rate').querySelector('table')!;
    expect(table.querySelector('caption')!.textContent).toContain('every weekly reading');
    for (const th of table.querySelectorAll('thead th')) expect(th.getAttribute('scope')).toBe('col');
    // Every row has a header cell, and it is the first cell: a loop over zero headers would pass
    // even if the row headers had turned into plain cells.
    const rowHeads = [...table.querySelectorAll('tbody th')];
    expect(rowHeads).toHaveLength(table.querySelectorAll('tbody tr').length);
    expect(rowHeads.length).toBeGreaterThan(0);
    for (const th of rowHeads) {
      expect(th.getAttribute('scope')).toBe('row');
      expect(th.parentElement!.firstElementChild).toBe(th);
    }
    // And no other cell in a row is a header.
    expect(table.querySelectorAll('tbody td')).toHaveLength(rowHeads.length * 2);
  });

  it('scrolls sideways inside its own box instead of widening the page', () => {
    mount();
    const table = screen.getByTestId('learning-readings-dismissal-rate').querySelector('table')!;
    expect(table.parentElement!.className).toContain('overflow-x-auto');
  });

  it('the scrolling box can be focused and scrolled by keyboard, and is named', () => {
    mount({ view: tile([measured({ label: 'Category' })]) });
    const box = screen.getByTestId('learning-readings-dismissal-rate').querySelector('.overflow-x-auto')!;
    expect(box.getAttribute('tabindex')).toBe('0');
    expect(box.getAttribute('role')).toBe('region');
    expect(box.getAttribute('aria-label')).toBe('Category: readings table, scrolls sideways');
    expect(box.className).toContain('focus-visible:outline');
  });

  it('lets a long column heading wrap instead of widening the table', () => {
    mount();
    for (const th of screen.getByTestId('learning-readings-dismissal-rate').querySelectorAll('thead th')) {
      expect(th.className).not.toContain('whitespace-nowrap');
    }
  });

  it('the summary is reachable by keyboard and shows a focus ring', () => {
    mount();
    const summary = screen.getByText(COMMON.showReadings);
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.className).toContain('focus-visible:outline');
  });

  it('keeps the table open when the view is rebuilt, because the blocks keep their nodes', async () => {
    const [view, setView] = createSignal(tile([measured()]));
    render(() => <LearningCard {...props({ get view() { return view(); } })} />);
    const details = screen.getByTestId('learning-readings-dismissal-rate') as HTMLDetailsElement;
    details.open = true;
    setView(tile([measured({ headline: '3 of 5 things happened, in the 7 days to Oct 26.' })]));
    await waitFor(() => expect(screen.getByTestId('learning-headline-dismissal-rate').textContent).toContain('3 of 5'));
    expect((screen.getByTestId('learning-readings-dismissal-rate') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId('learning-readings-dismissal-rate')).toBe(details);
  });
});

describe('LearningCard: context lines and status', () => {
  it('shows each context line, above the series', () => {
    mount({ view: tile([measured()], { contextLines: ['First line.', 'Second line.'] }) });
    const lines = screen.getAllByTestId(id('context'));
    expect(lines.map((l) => l.textContent)).toEqual(['First line.', 'Second line.']);
    expect(lines[0].compareDocumentPosition(screen.getByTestId('learning-headline-dismissal-rate')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the status line when there is one, and nothing when there is not', () => {
    mount({ view: tile([measured()], { status: 'At the Oct 26 reading, 23 past dismissals were stored.' }) });
    expect(screen.getByTestId(id('status')).textContent).toBe('At the Oct 26 reading, 23 past dismissals were stored.');
  });

  it('has no status element without one', () => {
    mount();
    expect(screen.queryByTestId(id('status'))).toBeNull();
    expect(screen.queryAllByTestId(id('context'))).toHaveLength(0);
  });
});

// ── What it counts and changes ───────────────────────────────────────────────

describe('LearningCard: What this counts and changes', () => {
  const about = () => screen.getByTestId(id('about')) as HTMLDetailsElement;

  it('holds the meaning and what it changes, under a summary, and not above the data', () => {
    mount();
    expect(within(about()).getByText(COMMON.whatItCounts).tagName).toBe('SUMMARY');
    expect(COMMON.whatItCounts).toBe('What this counts and changes');
    const paragraphs = [...about().querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual(['What it counts, in words.', 'What it changes, in words.']);
    // The number comes first; the prose is under it.
    const headline = screen.getByTestId('learning-headline-dismissal-rate');
    expect(headline.compareDocumentPosition(about()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is closed when something is measured, so the number is not buried in prose', () => {
    mount({ view: tile([measured()], { startOpen: false }) });
    expect(about().open).toBe(false);
  });

  it('is open when nothing is measured yet', () => {
    mount({ view: tile([none()], { resetAvailable: false }) });
    expect(about().open).toBe(true);
    mount({ view: tile([notMeasured()]) });
    expect(screen.getAllByTestId(id('about')).every((d) => (d as HTMLDetailsElement).open)).toBe(true);
  });

  it('is there while loading and after a failure, closed, with the caveat still above it', () => {
    for (const over of [
      { status: 'loading' as const, view: null },
      { status: 'error' as const, view: null, error: { kind: 'failed' as const, message: COMMON.errorFailed } },
    ]) {
      const { unmount } = mount(over);
      expect(about().open).toBe(false);
      expect(about().textContent).toContain('What it counts, in words.');
      const caveat = screen.getByTestId(id('primary-caveat'));
      expect(caveat.compareDocumentPosition(about()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  });

  it('comes before "More about this number"', () => {
    mount();
    expect(about().compareDocumentPosition(screen.getByTestId(id('more'))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no second paragraph when there is nothing it changes', () => {
    mount({ changes: null });
    expect([...about().querySelectorAll('p')].map((p) => p.textContent)).toEqual(['What it counts, in words.']);
  });

  it('does not close a block the owner opened when the view is rebuilt with the same answer', async () => {
    const [view, setView] = createSignal(tile([measured()], { startOpen: false }));
    render(() => <LearningCard {...props({ get view() { return view(); } })} />);
    about().open = true;
    setView(tile([measured()], { startOpen: false, status: 'A new status.' }));
    await waitFor(() => expect(screen.getByTestId(id('status')).textContent).toBe('A new status.'));
    expect(about().open).toBe(true);
  });
});

// ── More about this number ───────────────────────────────────────────────────

describe('LearningCard: More about this number', () => {
  it('is open exactly when the view says so', () => {
    mount({ view: tile([measured()], { startOpen: true }) });
    expect((screen.getByTestId(id('more')) as HTMLDetailsElement).open).toBe(true);
  });

  it('is closed when something is measured', () => {
    mount({ view: tile([measured()], { startOpen: false }) });
    expect((screen.getByTestId(id('more')) as HTMLDetailsElement).open).toBe(false);
  });

  it('holds the remaining caveats and the start steps, so they are reachable when closed', () => {
    mount();
    const more = screen.getByTestId(id('more'));
    expect(within(more).getByText(COMMON.moreAbout).tagName).toBe('SUMMARY');
    expect(more.textContent).toContain('Second caveat.');
    expect(more.textContent).toContain('Third caveat.');
    expect(more.textContent).toContain(COMMON.howItStarts);
    expect(more.textContent).toContain('How to get it going.');
    expect(more.querySelectorAll('li')).toHaveLength(2);
  });

  it('does not close a block the owner opened when the view is rebuilt with the same answer', async () => {
    const [view, setView] = createSignal(tile([measured()], { startOpen: false }));
    render(() => <LearningCard {...props({ get view() { return view(); } })} />);
    const more = screen.getByTestId(id('more')) as HTMLDetailsElement;
    more.open = true;
    setView(tile([measured()], { startOpen: false, status: 'A new status.' }));
    await waitFor(() => expect(screen.getByTestId(id('status')).textContent).toBe('A new status.'));
    expect(more.open).toBe(true);
  });

  it('opens when the answer changes to nothing measured', async () => {
    const [view, setView] = createSignal(tile([measured()], { startOpen: false }));
    render(() => <LearningCard {...props({ get view() { return view(); } })} />);
    expect((screen.getByTestId(id('more')) as HTMLDetailsElement).open).toBe(false);
    setView(tile([notMeasured()], { startOpen: true }));
    await waitFor(() => expect((screen.getByTestId(id('more')) as HTMLDetailsElement).open).toBe(true));
  });
});

// ── The reset area ───────────────────────────────────────────────────────────

describe('LearningCard: the reset area', () => {
  const button = () => screen.queryByTestId(id('reset')) as HTMLButtonElement | null;

  it('canReset true and something stored: the button and its hint', () => {
    mount();
    expect(button()!.textContent).toBe('Clear learned things');
    expect(screen.getByTestId(id('reset-hint')).textContent).toBe(RESET.hint);
    expect(screen.queryByTestId(id('nothing-to-clear'))).toBeNull();
    expect(screen.queryByTestId(id('readonly'))).toBeNull();
  });

  it('canReset true and nothing stored: the nothing-to-clear text, no button', () => {
    mount({ view: tile([measured()], { resetAvailable: false }) });
    expect(button()).toBeNull();
    expect(screen.getByTestId(id('nothing-to-clear')).textContent).toBe(RESET.nothingToClear);
  });

  it('canReset true, nothing stored and no nothing-to-clear text: nothing at all in the area', () => {
    mount({ view: tile([measured()], { resetAvailable: false }), reset: { ...RESET, nothingToClear: null } });
    expect(button()).toBeNull();
    expect(screen.queryByTestId(id('nothing-to-clear'))).toBeNull();
  });

  it('canReset false: the read-only note and no button, even when something is stored', () => {
    mount({ canReset: false });
    expect(button()).toBeNull();
    expect(screen.getByTestId(id('readonly')).textContent).toBe(COMMON.readOnlyNote);
    expect(screen.queryByTestId(id('reset-hint'))).toBeNull();
  });

  it('canReset false and nothing stored: still the read-only note', () => {
    mount({ canReset: false, view: tile([measured()], { resetAvailable: false }) });
    expect(screen.getByTestId(id('readonly'))).toBeInTheDocument();
    expect(screen.queryByTestId(id('nothing-to-clear'))).toBeNull();
  });

  it('canReset null (not known yet): neither a button, nor the note, nor the nothing-to-clear text', () => {
    mount({ canReset: null });
    expect(button()).toBeNull();
    expect(screen.queryByTestId(id('readonly'))).toBeNull();
    expect(screen.queryByTestId(id('nothing-to-clear'))).toBeNull();
    expect(screen.queryByTestId(id('reset-hint'))).toBeNull();
  });

  it('no reset spec: the plain note instead, to everyone, and never a button', () => {
    for (const canReset of [true, false, null]) {
      const { unmount } = mount({ canReset, reset: undefined, noResetNote: 'Nothing to clear. This is only a readout.' });
      expect(screen.getByTestId(id('no-reset')).textContent).toBe('Nothing to clear. This is only a readout.');
      expect(button()).toBeNull();
      expect(screen.queryByTestId(id('readonly'))).toBeNull();
      unmount();
    }
  });

  it('no reset spec and no note: nothing in the area', () => {
    mount({ reset: undefined });
    expect(screen.queryByTestId(id('no-reset'))).toBeNull();
    expect(button()).toBeNull();
  });

  it('follows the account as it loads, with the card kept as it is', async () => {
    const [canReset, setCanReset] = createSignal<boolean | null>(null);
    render(() => <LearningCard {...props({ get canReset() { return canReset(); } })} />);
    expect(button()).toBeNull();
    setCanReset(true);
    await waitFor(() => expect(button()).not.toBeNull());
    setCanReset(false);
    await waitFor(() => expect(screen.getByTestId(id('readonly'))).toBeInTheDocument());
    expect(button()).toBeNull();
  });
});

describe('LearningCard: clearing', () => {
  it('asks first; Cancel makes no request and leaves the card as it was', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    mount({ view: tile([measured()], { status: 'Before.' }) });
    fireEvent.click(screen.getByTestId(id('reset')));
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByTestId(id('reset'))).toBeInTheDocument();
    expect(screen.getByTestId(id('status')).textContent).toBe('Before.');
  });

  it('a clear: one request, a success toast, the status line becomes the done text, the button is gone, nothing is refetched', async () => {
    mount({ view: tile([measured()], { status: 'Before.' }) });
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(run).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Cleared 5 things.', 'success');
    expect(screen.getByTestId(id('status')).textContent).toBe(RESET.doneStatus);
    expect(screen.getByTestId(id('nothing-to-clear')).textContent).toBe(RESET.nothingToClear);
    // The frame never asks for a new read: the readings cannot change before Monday.
    expect(onRetry).not.toHaveBeenCalled();
    // The readings already on screen stay.
    expect(screen.getByTestId('learning-headline-dismissal-rate')).toBeInTheDocument();
  });

  it('the done text shows even when the view had no status line of its own', async () => {
    mount();
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.getByTestId(id('status')).textContent).toBe(RESET.doneStatus));
  });

  it('a clear that finds nothing: a plain toast, the button gone, the nothing-to-clear text, the status untouched', async () => {
    run.mockResolvedValue({ ok: true, cleared: 0 });
    mount({ view: tile([measured()], { status: 'Before.' }) });
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(toast).toHaveBeenCalledWith(RESET.emptyMessage, 'default');
    expect(screen.getByTestId(id('nothing-to-clear'))).toBeInTheDocument();
    expect(screen.getByTestId(id('status')).textContent).toBe('Before.');
  });

  it('the button is disabled while the request runs', async () => {
    let release!: (r: LearningResetResult) => void;
    run.mockReturnValue(new Promise<LearningResetResult>((r) => (release = r)));
    mount();
    const b = screen.getByTestId(id('reset')) as HTMLButtonElement;
    fireEvent.click(b);
    await waitFor(() => expect(b.disabled).toBe(true));
    fireEvent.click(b);
    expect(run).toHaveBeenCalledTimes(1);
    release({ ok: true, cleared: 1 });
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
  });

  it('a failure leaves the button for another try and does not claim a clear', async () => {
    run.mockRejectedValue(Object.assign(new Error('database is locked'), { status: 500 }));
    mount({ view: tile([measured()], { status: 'Before.' }) });
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    expect(toast).not.toHaveBeenCalledWith('database is locked', expect.anything());
    const b = screen.getByTestId(id('reset')) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(false));
    expect(screen.getByTestId(id('status')).textContent).toBe('Before.');
    // A screen reader hears it too: the toast is silent, so the sentence is also an alert by the button.
    expect(screen.getByTestId(`${id('reset')}-error`).textContent).toBe(COMMON.clearFailed);
    expect(screen.getByRole('alert')).toBe(screen.getByTestId(`${id('reset')}-error`));
  });

  it('a 403 tells the panel once, toasts the fixed message, and does not claim a clear', async () => {
    run.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    mount();
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(onResetForbidden).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(COMMON.forbiddenToast, 'error');
    expect(screen.queryByTestId(id('status'))?.textContent ?? '').not.toBe(RESET.doneStatus);
  });

  it('after a clear focus moves to the new status line, so a keyboard user is not dropped to the top of the page', async () => {
    mount({ view: tile([measured()], { status: 'Before.' }) });
    const b = screen.getByTestId(id('reset'));
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId(id('status')));
    expect(document.activeElement!.textContent).toBe(RESET.doneStatus);
    expect(document.activeElement!.getAttribute('tabindex')).toBe('-1');
  });

  it('after a clear that finds nothing focus moves to the nothing-to-clear line', async () => {
    run.mockResolvedValue({ ok: true, cleared: 0 });
    mount({ view: tile([measured()], { status: 'Before.' }) });
    const b = screen.getByTestId(id('reset'));
    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId(id('nothing-to-clear')));
  });

  it('after a clear with no nothing-to-clear line and no status line, focus falls back to the card title, never the page', async () => {
    run.mockResolvedValue({ ok: true, cleared: 0 });
    mount({ view: tile([measured()]), reset: { ...RESET, nothingToClear: null } });
    const b = screen.getByTestId(id('reset'));
    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Things you dismiss' }));
  });

  it('keeps focus on the button after a failed clear, because the button stays for another try', async () => {
    run.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    mount();
    const b = screen.getByTestId(id('reset')) as HTMLButtonElement;
    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    await waitFor(() => expect(b.disabled).toBe(false));
    expect(document.activeElement).toBe(b);
  });

  it('says the result to a screen reader through one live region that was there before the click', async () => {
    mount();
    const live = screen.getByTestId(id('announce'));
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.className).toContain('sr-only');
    expect(live.textContent).toBe('');
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(live.textContent).toBe('Cleared 5 things.'));
    // The same element, not a new one created at the moment the text appeared.
    expect(screen.getByTestId(id('announce'))).toBe(live);
  });

  it('says "nothing to clear" through the same live region', async () => {
    run.mockResolvedValue({ ok: true, cleared: 0 });
    mount();
    const live = screen.getByTestId(id('announce'));
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(live.textContent).toBe(RESET.emptyMessage));
  });

  it('says nothing through the live region on first load: only what the owner did is announced', () => {
    mount();
    expect(screen.getByTestId(id('announce')).textContent).toBe('');
    mount({ status: 'loading', view: null });
    for (const live of screen.getAllByTestId(id('announce'))) expect(live.textContent).toBe('');
  });

  it('a refused clear is said to a screen reader and focus moves to the read-only note that replaced the button', async () => {
    const [canReset, setCanReset] = createSignal<boolean | null>(true);
    // The panel turns every card read-only on a 403; do the same here.
    onResetForbidden.mockImplementation(() => setCanReset(false));
    run.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(() => <LearningCard {...props({ get canReset() { return canReset(); } })} />);
    const b = screen.getByTestId(id('reset'));
    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(screen.getByTestId(id('readonly'))).toBeInTheDocument());
    expect(screen.getByTestId(id('announce')).textContent).toBe(COMMON.forbiddenToast);
    expect(document.activeElement).toBe(screen.getByTestId(id('readonly')));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('a card that did not make the refused request is turned read-only without taking focus', async () => {
    const [canReset, setCanReset] = createSignal<boolean | null>(true);
    render(() => (
      <div>
        <input data-testid="elsewhere" />
        <LearningCard {...props({ get canReset() { return canReset(); } })} />
      </div>
    ));
    (screen.getByTestId('elsewhere') as HTMLInputElement).focus();
    setCanReset(false);
    await waitFor(() => expect(screen.getByTestId(id('readonly'))).toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
    expect(screen.getByTestId(id('announce')).textContent).toBe('');
  });

  it('keeps the clear for the rest of the session, so a new visit to the tab can say so', async () => {
    mount();
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(clearedMemory.recall().dismissal).toBe(localISODate(new Date()));
  });

  it('writes the clear to sessionStorage itself, so it survives a reload within the browser session', async () => {
    mount();
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    // The module-level fallback copy would satisfy recall() even if the storage binding were broken.
    const raw = sessionStorage.getItem('planning.learning.cleared.v1');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ owner: '', loops: { dismissal: localISODate(new Date()) }, forbidden: false });
  });

  it('does not keep a clear that found nothing', async () => {
    run.mockResolvedValue({ ok: true, cleared: 0 });
    mount();
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(clearedMemory.recall()).toEqual({});
  });

  it('remembers under its own loop only', async () => {
    mount({ loopKey: 'placement' });
    fireEvent.click(screen.getByTestId('learning-reset-placement'));
    await waitFor(() => expect(screen.queryByTestId('learning-reset-placement')).toBeNull());
    expect(Object.keys(clearedMemory.recall())).toEqual(['placement']);
  });
});

// ── Buttons and words ────────────────────────────────────────────────────────

describe('LearningCard: buttons and words', () => {
  it('every button is type="button", in every state that has one', () => {
    for (const over of [
      {},
      { status: 'error' as const, view: null, error: { kind: 'failed' as const, message: COMMON.errorFailed } },
      { view: tile([notMeasured()]) },
      { canReset: false },
    ]) {
      const { container, unmount } = mount(over);
      for (const b of container.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button');
      expect(container.querySelector('form')).toBeNull();
      unmount();
    }
  });

  it('inside a form, none of its buttons submits it', async () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    render(() => (
      <form onSubmit={submit}>
        <LearningCard {...props()} />
      </form>
    ));
    fireEvent.click(screen.getByTestId(id('reset')));
    await waitFor(() => expect(screen.queryByTestId(id('reset'))).toBeNull());
    expect(submit).not.toHaveBeenCalled();
  });

  it('adds no wording of its own that fails the copy sweep', () => {
    const { container } = mount({ view: tile([measured()], { startOpen: true }) });
    expect(copyProblems(container.textContent ?? '')).toEqual([]);
  });

  it('uses no colour literal and no red or green', () => {
    const { container } = mount({ view: tile([measured(), notMeasured()].map((s, i) => ({ ...s, key: `k${i}` }))) });
    const html = container.innerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgba?\(/i);
    expect(html).not.toMatch(/emerald|amber|red-|green-/);
  });
});
