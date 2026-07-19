import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';

/**
 * PlanWeekReviewBranch (T5) — the read-only weekly recap.
 *
 * What's worth pinning: it makes exactly ONE request (the whole point of the aggregation
 * endpoint), it renders the sections the server composed, and it mutates nothing.
 */

const reviewMock = vi.fn(async (_a?: string) => ({
  anchor: '2026-07-11',
  week: {
    week_key: '2026-W28', days: ['2026-07-06','2026-07-07','2026-07-08','2026-07-09','2026-07-10','2026-07-11','2026-07-12'],
    tasks_completed: 9, tasks_overdue: 2, blocks_count: 14,
    weekly_goals: [], objectives_rotting: 1,
  },
  calibration: { calibrated: false, sample_count: 0 },
  stars: [
    { date: '2026-07-07', total: 4, frozen: true },
    { date: '2026-07-08', total: 0, frozen: true },
  ],
  note_dates: ['2026-07-09'],
  sessions: [{ id: 's1', started_at: '2026-07-08T10:00:00.000Z', entry_branch: 'fill_week', status: 'completed' }],
}));
vi.mock('../lib/api.js', () => ({ api: { planWeek: { review: (a?: string) => reviewMock(a) } } }));

// The stats block is someone else's component; stub it so this test stays about the branch.
vi.mock('./WeeklyReview.js', () => ({ WeeklyReview: () => <div>weekly-stats</div> }));

const { PlanWeekReviewBranch } = await import('./PlanWeekReviewBranch.js');

const onBack = vi.fn();
const mount = () => render(() => <PlanWeekReviewBranch append={vi.fn()} onBack={onBack} />);

describe('PlanWeekReviewBranch — read-only weekly recap', () => {
  beforeEach(() => { reviewMock.mockClear(); onBack.mockReset(); });

  it('fetches the recap exactly once and renders the composed sections', async () => {
    mount();
    await screen.findByText('weekly-stats');

    // One request — that is why the aggregation endpoint exists.
    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(reviewMock).toHaveBeenCalledWith(undefined); // server picks last week's anchor

    // Only days that actually scored get a star line. (Match the star FORMAT, not the
    // bare date — 2026-07-08 also appears as the session date further down.)
    await screen.findByText(/2026-07-07 — 4\/5/);
    expect(screen.queryByText(/2026-07-08 — 0\/5/)).toBeNull();

    await screen.findByText(/Day notes on 1 day/);
    await screen.findByText(/fill week \(completed\)/);
  });

  it('says so plainly when the week had no planning sessions', async () => {
    reviewMock.mockResolvedValueOnce({
      anchor: '2026-07-11',
      week: { week_key: '2026-W28', days: [], tasks_completed: 0, tasks_overdue: 0, blocks_count: 0, weekly_goals: [], objectives_rotting: 0 },
      calibration: { calibrated: false, sample_count: 0 },
      stars: [], note_dates: [], sessions: [],
    });
    mount();
    await screen.findByText('None last week.');
  });

  /**
   * Solid RE-THROWS on reading an errored resource, so a `<Show when={review()}>` alone
   * would escape its own fallback and blow up the render — and the app mounts no
   * ErrorBoundary. The error must be checked before the value is read.
   */
  it('renders the failure message instead of crashing when the request rejects', async () => {
    reviewMock.mockRejectedValueOnce(new Error('offline'));
    mount();
    await screen.findByText("Couldn't load the review.");
    // Still usable: the way out survives the failure.
    expect(screen.getByText('Back')).toBeTruthy();
  });

  it('offers a way back to the menu', async () => {
    mount();
    await screen.findByText('weekly-stats');
    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });
});
