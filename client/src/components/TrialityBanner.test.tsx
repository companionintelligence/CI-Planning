import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen, cleanup } from '@solidjs/testing-library';
import type { TrialityConfidence, TrialityNext, TrialityPick } from '../lib/api.js';

/**
 * TrialityBanner (design §9.1) — the contracts worth pinning:
 *   1. flag off → no render AND no fetch (the resource source is null);
 *   2. today's dismissal key → no fetch, no render; a stale key fetches again;
 *   3. ✕ stamps `dismissed` on every UNactioned shown row, then collapses;
 *   4. stage → flight-plan POST then `staged` feedback (order matters);
 *   5. refusal renders the N-of-10 copy;
 *   6. an acted-on pill is excluded from the ✕ dismissal fan-out.
 *
 * v2.2 confidence (§4) adds four more, and the first is the doctrine one:
 *   7. a `guess` STILL FILLS ITS SLOT — the band labels, it never suppresses;
 *   8. `firm` is unlabeled, and so is a pick with no confidence at all: an
 *      unmarked pill must never be readable as a claim;
 *   9. the hedge names the BINDING component, and `uncontested` never reads as
 *      a tie;
 *  10. coverage is a per-VECTOR fact, so it prints once for the whole banner.
 */

const nextMock = vi.fn(async (): Promise<TrialityNext> => ({ picks: [], empty_reasons: {}, computed_at: 'x' }));
const feedbackMock = vi.fn(async (_id: string, _o: string) => ({ changed: true }));
const addTaskMock = vi.fn(async (_id: string) => ({ flight_plan: [], added: 1 }));
const callOrder: string[] = [];

vi.mock('../lib/api.js', () => ({
  api: {
    triality: {
      next: () => { callOrder.push('next'); return nextMock(); },
      feedback: (id: string, o: string) => { callOrder.push(`feedback:${o}:${id}`); return feedbackMock(id, o); },
    },
    flightPlan: {
      addTask: (id: string) => { callOrder.push(`stage:${id}`); return addTaskMock(id); },
    },
  },
}));

const prefsBox = { current: { triality_enabled: true, timezone: 'UTC' } as Record<string, unknown> | undefined };
const toastMock = vi.fn();
const modalMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  prefs: () => prefsBox.current,
  tags: () => [{ id: 'cat-health', name: 'health', kind: 'category' }],
  categoryPrefs: () => ({ prefs: { 'cat-health': { color_token: 'teal' } } }),
  showToast: (...a: unknown[]) => toastMock(...a),
  setElementModal: (...a: unknown[]) => modalMock(...a),
}));

const { TrialityBanner } = await import('./TrialityBanner.js');

/** A `firm` reading by default, so a case that does not mention confidence renders no
 *  marker and asserts nothing about one. `counts` merges rather than replaces, so a test
 *  can move one number without restating the other three. */
type ConfOver = Partial<Omit<TrialityConfidence, 'counts'>> & { counts?: Partial<TrialityConfidence['counts']> };
const conf = (over: ConfOver = {}): TrialityConfidence => ({
  band: 'firm',
  value: 0.417,
  coverage: 0.417,
  margin: 1,
  evidence: 1,
  margin_basis: 'dot',
  binding: 'coverage',
  v: 1,
  ...over,
  counts: { dims_informative: 5, dims_active: 12, evidence_rows: 9, eligible: 14, ...over.counts },
});

/** Carries a confidence by DEFAULT — a fresh /next payload always does, and a fixture
 *  that never did would leave the marker untested by the cases that are about something
 *  else. `confidence: undefined` is the explicit way to model a stale response. */
const pick = (over: Partial<TrialityPick> = {}): TrialityPick => ({
  slot: 'habitual',
  action_kind: 'task',
  action_ref: 'task-1',
  title: 'Reply to sprint thread',
  estimate_min: 15,
  direction: 'work',
  categories: ['health'],
  motivation: 'me',
  scores: { F: 0.5, H: 0.9, Q: 0.2, N: 0.1, C: 0.8, total: 0.62 },
  ternary: [1, 0, 1],
  log_id: 'log-1',
  confidence: conf(),
  ...over,
});

const THREE: TrialityNext = {
  picks: [
    pick(),
    pick({ slot: 'contextual', action_ref: 'task-2', title: '30-min walk', log_id: 'log-2', motivation: null }),
    pick({ slot: 'novel', action_kind: 'template', action_ref: 'tpl-1', title: 'Deep work block', log_id: 'log-3', motivation: 'them' }),
  ],
  empty_reasons: {},
  computed_at: 'x',
};

beforeEach(() => {
  nextMock.mockReset().mockResolvedValue(THREE);
  feedbackMock.mockReset().mockResolvedValue({ changed: true });
  addTaskMock.mockReset().mockResolvedValue({ flight_plan: [], added: 1 });
  toastMock.mockReset();
  modalMock.mockReset();
  callOrder.length = 0;
  prefsBox.current = { triality_enabled: true, timezone: 'UTC' };
  localStorage.clear();
});

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe('gating', () => {
  it('flag off → renders nothing and fetches nothing', async () => {
    prefsBox.current = { triality_enabled: false };
    const { container } = render(() => <TrialityBanner />);
    await Promise.resolve();
    expect(container.querySelector('[data-testid="triality-banner"]')).toBeNull();
    expect(nextMock).not.toHaveBeenCalled();
  });

  it("today's dismissal key → no fetch, no render; a stale key fetches", async () => {
    localStorage.setItem('triality_banner_dismissed', todayKey());
    const a = render(() => <TrialityBanner />);
    await Promise.resolve();
    expect(nextMock).not.toHaveBeenCalled();
    expect(a.container.querySelector('[data-testid="triality-banner"]')).toBeNull();
    a.unmount();

    localStorage.setItem('triality_banner_dismissed', '2020-01-01'); // yesterday's mood expired
    render(() => <TrialityBanner />);
    await waitFor(() => expect(nextMock).toHaveBeenCalledTimes(1));
  });
});

describe('rendering', () => {
  it('three pills with slot labels and the motivation glyphs', async () => {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    expect(screen.getByText('HABITUAL')).toBeTruthy();
    expect(screen.getByText('CONTEXTUAL')).toBeTruthy();
    expect(screen.getByText('NOVEL')).toBeTruthy();
    expect(screen.getByTitle('for me')).toBeTruthy();
    expect(screen.getByTitle('for them')).toBeTruthy();
  });

  it('refusal renders the N-of-10 copy and no pills', async () => {
    nextMock.mockResolvedValue({ refused: 'sparse_history', have: 6, need: 10 });
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText(/Not enough history yet \(6 of 10/)).toBeTruthy());
    expect(screen.queryByText('HABITUAL')).toBeNull();
  });

  it('tapping a pill expands the arithmetic breakdown', async () => {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    fireEvent.click(screen.getByText('Reply to sprint thread'));
    const breakdown = await screen.findByTestId('triality-breakdown');
    expect(breakdown.textContent).toContain('H 0.9');
    expect(breakdown.textContent).toContain('S 0.62');
  });
});

describe('rationale garnish (T9)', () => {
  /** Expand the first pill — the rationale sits under the arithmetic, not on the pill. */
  async function expandFirst() {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    fireEvent.click(screen.getByText('Reply to sprint thread'));
    return screen.findByTestId('triality-breakdown');
  }

  it("an 'ai' line renders, labelled AI", async () => {
    nextMock.mockResolvedValue({
      ...THREE,
      picks: [pick({ rationale: 'You usually start here after standup.', rationale_source: 'ai' })],
    });
    await expandFirst();
    const line = await screen.findByTestId('triality-rationale');
    expect(line.textContent).toContain('You usually start here after standup.');
    expect(line.textContent).toContain('AI');
    expect(line.textContent).not.toContain('template');
  });

  it("a 'template' line renders, labelled template", async () => {
    nextMock.mockResolvedValue({
      ...THREE,
      picks: [pick({ rationale: 'Something you do often, and today is a work day.', rationale_source: 'template' })],
    });
    await expandFirst();
    const line = await screen.findByTestId('triality-rationale');
    expect(line.textContent).toContain('Something you do often, and today is a work day.');
    expect(line.textContent).toContain('template');
  });

  it('a pick with no rationale renders no rationale line at all', async () => {
    nextMock.mockResolvedValue({ ...THREE, picks: [pick()] });
    const breakdown = await expandFirst();
    expect(breakdown.textContent).toContain('H 0.9'); // the arithmetic is still there
    expect(screen.queryByTestId('triality-rationale')).toBeNull();
  });
});

describe('confidence band marker (v2.2 §4)', () => {
  /** One pill carrying `c`; hands back its band marker, or null when the band is
   *  unlabeled (`firm`) or the pick carries no confidence at all. */
  async function markerFor(
    c: TrialityConfidence | undefined,
    over: Partial<TrialityPick> = {},
  ): Promise<HTMLElement | null> {
    nextMock.mockResolvedValue({ ...THREE, picks: [pick({ confidence: c, ...over })] });
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    return screen.queryByText('~') ?? screen.queryByText('GUESS');
  }

  it('firm renders NO marker — the app does not badge a model the tiles have not validated', async () => {
    expect(await markerFor(conf({ band: 'firm' }))).toBeNull();
  });

  it('tentative renders ~, with the hedge in BOTH title and aria-label', async () => {
    const marker = await markerFor(conf({ band: 'tentative', binding: 'coverage', counts: { dims_informative: 3 } }));
    expect(marker!.textContent).toBe('~');
    const hedge = 'only 3 of 12 situation signals are pointing anywhere right now';
    expect(marker!.getAttribute('title')).toBe(hedge);
    // A bare `~` is meaningless read aloud, so the label carries the band too.
    expect(marker!.getAttribute('aria-label')).toBe(`tentative — ${hedge}`);
  });

  it('guess renders GUESS, with the hedge in BOTH title and aria-label', async () => {
    const marker = await markerFor(conf({ band: 'guess', binding: 'evidence', counts: { evidence_rows: 0 } }));
    expect(marker!.textContent).toBe('GUESS');
    const hedge = "you haven't done this kind of thing in the last 90 days";
    expect(marker!.getAttribute('title')).toBe(hedge);
    expect(marker!.getAttribute('aria-label')).toBe(`a guess — ${hedge}`);
  });

  it('a pick with NO confidence renders no marker and no confidence line', async () => {
    expect(await markerFor(undefined)).toBeNull();
    fireEvent.click(screen.getByText('Reply to sprint thread'));
    const breakdown = await screen.findByTestId('triality-breakdown');
    expect(breakdown.textContent).toContain('H 0.9'); // the arithmetic is still there
    expect(screen.queryByTestId('triality-confidence')).toBeNull();
    expect(screen.queryByTestId('triality-coverage')).toBeNull();
  });

  it('a guess STILL FILLS ITS SLOT — three guesses render three pills, actions intact', async () => {
    const guess = conf({ band: 'guess', value: 0, binding: 'evidence', counts: { evidence_rows: 0 } });
    nextMock.mockResolvedValue({ ...THREE, picks: THREE.picks!.map((p) => ({ ...p!, confidence: guess })) });
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    expect(screen.getAllByText('GUESS').length).toBe(3);
    expect(screen.getByText('HABITUAL')).toBeTruthy();
    expect(screen.getByText('CONTEXTUAL')).toBeTruthy();
    expect(screen.getByText('NOVEL')).toBeTruthy();
    expect(screen.getAllByText('stage').length).toBe(2); // unchanged: task pills only
  });
});

describe('confidence hedge copy (v2.2 §8)', () => {
  /** The hedge is only ever read off the marker, so a case that produced `firm`
   *  would silently assert nothing — every row here pins a hedged band. */
  async function hedgeFor(c: TrialityConfidence, over: Partial<TrialityPick> = {}): Promise<string> {
    nextMock.mockResolvedValue({ ...THREE, picks: [pick({ confidence: c, ...over })] });
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    const marker = screen.queryByText('~') ?? screen.queryByText('GUESS');
    return marker!.getAttribute('title')!;
  }

  const guessing = (over: ConfOver) => conf({ band: 'guess', value: 0, ...over });

  it('evidence 0 on a TEMPLATE blames the structure, not the owner', async () => {
    const hedge = await hedgeFor(
      guessing({ binding: 'evidence', counts: { evidence_rows: 0 } }),
      { action_kind: 'template', action_ref: 'tpl-9' },
    );
    expect(hedge).toBe('saved blocks have no completion trail, so nothing backs this');
  });

  it('evidence 0 on a task says the owner has not done it', async () => {
    expect(await hedgeFor(guessing({ binding: 'evidence', counts: { evidence_rows: 0 } })))
      .toBe("you haven't done this kind of thing in the last 90 days");
  });

  it('a thin evidence count is quoted raw, singular and plural', async () => {
    expect(await hedgeFor(guessing({ binding: 'evidence', counts: { evidence_rows: 1 } })))
      .toBe('only 1 completion of this kind in 90 days');
    cleanup();
    expect(await hedgeFor(guessing({ binding: 'evidence', counts: { evidence_rows: 3 } })))
      .toBe('only 3 completions of this kind in 90 days');
  });

  it('uncontested reads as an empty pool, NOT as a tie', async () => {
    const hedge = await hedgeFor(guessing({ binding: 'margin', margin: 0, margin_basis: 'uncontested' }));
    expect(hedge).toBe('nothing else was eligible for this slot');
    expect(hedge).not.toMatch(/tie/i);
  });

  it('a tie says the id order decided — the coin-flip case', async () => {
    expect(await hedgeFor(guessing({ binding: 'margin', margin: 0, margin_basis: 'tie' })))
      .toBe('tied with another candidate — the id order decided, not the evidence');
  });

  it('a real but narrow win names the runner-up', async () => {
    expect(await hedgeFor(guessing({ binding: 'margin', margin: 0.1, margin_basis: 'score' })))
      .toBe('the runner-up was almost as good');
  });

  it('coverage names both halves of the fraction — the ratio never travels alone', async () => {
    expect(await hedgeFor(guessing({ binding: 'coverage', counts: { dims_informative: 2, dims_active: 11 } })))
      .toBe('only 2 of 11 situation signals are pointing anywhere right now');
  });
});

describe('confidence in the expansion + the banner coverage line', () => {
  async function expandWith(c: TrialityConfidence) {
    nextMock.mockResolvedValue({ ...THREE, picks: [pick({ confidence: c })] });
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    fireEvent.click(screen.getByText('Reply to sprint thread'));
    return screen.findByTestId('triality-confidence');
  }

  it('prints every number the band was derived from', async () => {
    const line = await expandWith(conf({
      band: 'tentative', value: 0.25, coverage: 0.25, margin: 0.5, evidence: 0.25,
      margin_basis: 'dot', binding: 'coverage', counts: { evidence_rows: 2 },
    }));
    expect(line.textContent).toBe(
      'confidence 0.25 · tentative — coverage 0.25 · margin 0.5 (dot) · evidence 2 of 8',
    );
  });

  it('an uncontested margin carries its caveat — a 0 there is not a near-miss', async () => {
    const line = await expandWith(conf({
      band: 'guess', value: 0, margin: 0, margin_basis: 'uncontested', binding: 'margin',
    }));
    expect(line.textContent).toContain('margin 0 (uncontested)');
    expect(line.textContent).toContain(' — nothing else was eligible for this slot');
  });

  it('a tie is named a coin flip in the arithmetic too', async () => {
    const line = await expandWith(conf({
      band: 'guess', value: 0, margin: 0, margin_basis: 'tie', binding: 'margin',
    }));
    expect(line.textContent).toContain(' — a tie the id order broke; this is a coin flip');
  });

  it('coverage prints ONCE for the banner, with the caveat tooltip', async () => {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    // All three picks carry the same vector reading; one sentence, not three.
    const lines = screen.getAllByTestId('triality-coverage');
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toBe('5 of 12 signals are pointing somewhere right now.');
    // The tooltip is what stops "5 of 12" being read as "7 signals are missing".
    const tip = lines[0].getAttribute('title')!;
    expect(tip).toContain('A signal counts here only when it leans one way.');
    expect(tip).toContain('A quiet day and an unread day look identical to the vector.');
    expect(tip).toContain('momentum');
  });
});

describe('actions', () => {
  it('stage → flight-plan POST then staged feedback, in that order, with a toast', async () => {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    fireEvent.click(screen.getAllByText('stage')[0]);
    await waitFor(() => expect(feedbackMock).toHaveBeenCalledWith('log-1', 'staged'));
    const stageIdx = callOrder.indexOf('stage:task-1');
    const fbIdx = callOrder.indexOf('feedback:staged:log-1');
    expect(stageIdx).toBeGreaterThanOrEqual(0);
    expect(fbIdx).toBeGreaterThan(stageIdx);
    expect(toastMock).toHaveBeenCalled();
  });

  it('open → opened feedback + wizard modal for tasks; template pills offer no open', async () => {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    const opens = screen.getAllByText('open');
    expect(opens.length).toBe(2); // task + contextual task — the template pill has none
    fireEvent.click(opens[0]);
    expect(feedbackMock).toHaveBeenCalledWith('log-1', 'opened');
    expect(modalMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'edit', editTarget: { kind: 'task', id: 'task-1' } }),
    );
  });

  it('✕ stamps dismissed on unactioned rows only, sets the day key, collapses', async () => {
    render(() => <TrialityBanner />);
    await waitFor(() => expect(screen.getByText('Reply to sprint thread')).toBeTruthy());
    fireEvent.click(screen.getAllByText('stage')[0]); // acts on log-1
    await waitFor(() => expect(feedbackMock).toHaveBeenCalledWith('log-1', 'staged'));

    fireEvent.click(screen.getByLabelText('Dismiss suggestions for today'));
    await waitFor(() => expect(localStorage.getItem('triality_banner_dismissed')).toBe(todayKey()));
    const dismissed = callOrder.filter((c) => c.startsWith('feedback:dismissed'));
    expect(dismissed.sort()).toEqual(['feedback:dismissed:log-2', 'feedback:dismissed:log-3']);
    expect(screen.queryByTestId('triality-banner')).toBeNull();
  });
});
