import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import type { TrialityNext, TrialityPick } from '../lib/api.js';

/**
 * TrialityBanner (design §9.1) — the contracts worth pinning:
 *   1. flag off → no render AND no fetch (the resource source is null);
 *   2. today's dismissal key → no fetch, no render; a stale key fetches again;
 *   3. ✕ stamps `dismissed` on every UNactioned shown row, then collapses;
 *   4. stage → flight-plan POST then `staged` feedback (order matters);
 *   5. refusal renders the N-of-10 copy;
 *   6. an acted-on pill is excluded from the ✕ dismissal fan-out.
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
