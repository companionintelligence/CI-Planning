import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * DetailsDrawer — the Life-dimension panel.
 *
 * Contracts:
 *   1. unallocated time = the window's target minus what is actually on the calendar;
 *   2. the window switch re-scopes it — a weekly target pro-rates across a month;
 *   3. repeated titles collapse to ONE row carrying a digit, in every list;
 *   4. a task already scheduled in the window is not repeated under Open;
 *   5. Completed is collapsed until asked for.
 *
 * The blocks are fetched by the panel for its OWN window (not read off the shared,
 * day-scoped `blocks` resource), so `api.blocks.list` is the seam that matters here.
 */

const TODAY = '2026-08-28';           // a Friday → week is Mon 24 … Sun 30
vi.useFakeTimers({ now: new Date(`${TODAY}T12:00:00Z`), toFake: ['Date'] });

const blocksListMock = vi.fn(async () => ({
  blocks: [
    { id: 'b1', task_id: 't-gym', title: 'Gym session', categories: ['health'], start_at: `${TODAY}T17:00:00Z`, end_at: `${TODAY}T18:00:00Z` },
    { id: 'b2', task_id: 't-gym2', title: 'Gym session', categories: ['health'], start_at: '2026-08-29T17:00:00Z', end_at: '2026-08-29T18:00:00Z' },
    { id: 'b3', task_id: 't-phys', title: 'Physio', categories: ['health'], start_at: '2026-08-29T09:00:00Z', end_at: '2026-08-29T09:45:00Z' },
    { id: 'b4', task_id: 't-x', title: 'Standup', categories: ['career'], start_at: `${TODAY}T10:00:00Z`, end_at: `${TODAY}T10:15:00Z` },
  ],
}));

vi.mock('@solidjs/router', () => ({ useLocation: () => ({ pathname: '/balance' }) }));
vi.mock('./Planner.js', () => ({ Planner: () => null }));
vi.mock('./LockToggle.js', () => ({ LockToggle: () => null }));
vi.mock('./TaskCard.js', () => ({ PriorityToggle: () => null, DateField: () => null }));
vi.mock('../lib/lock.js', () => ({ lockAffordance: () => ({}) }));
vi.mock('../lib/recurrence.js', () => ({ describeRule: () => '' }));
vi.mock('../lib/tag-tax.js', () => ({ displayTag: (n: string) => n }));
vi.mock('../lib/objectives.js', () => ({ flattenObjectives: () => [] }));
vi.mock('../lib/api.js', () => ({
  api: {
    priorities: { list: async () => ({ priorities: [{ category: 'health', satisfaction: 6, importance: 10, target_hours_per_week: 14 }] }) },
    blocks: { list: (...a: unknown[]) => blocksListMock(...(a as [])) },
  },
}));

const setActiveTaskMock = vi.fn();
const [entity, setEntity] = createSignal<{ kind: string; id: string } | null>({ kind: 'dimension', id: 'health' });
vi.mock('../stores/selection.js', () => ({
  activeTask: () => null, activeBlock: () => null, activeEntity: () => entity(),
  clearActiveEntity: () => setEntity(null),
  setActiveTask: (id: string) => setActiveTaskMock(id),
  setActiveBlock: vi.fn(), setActiveEntity: vi.fn(),
}));
vi.mock('../stores/ui.js', () => ({
  detailsOpen: () => true, detailsWidth: () => 360, setDetailsOpen: vi.fn(), setDetailsWidth: vi.fn(),
  drawerTab: () => 'details', setDrawerTab: vi.fn(),
  DETAILS_MIN_W: 280, DETAILS_MAX_W: 640, DETAILS_DEFAULT_W: 360,
}));
vi.mock('../stores/index.js', () => ({
  blocks: () => [],                       // deliberately EMPTY: the panel must not rely on it
  tasks: () => [
    // already on the calendar this window → must NOT also appear under Open
    { id: 't-gym', title: 'Gym session', status: 'scheduled', categories: ['health'], estimated_minutes: 60 },
    { id: 't-open1', title: 'Book physio', status: 'open', categories: ['health'], estimated_minutes: 30 },
    { id: 't-done1', title: 'Morning walk', status: 'done', categories: ['health'], completed_at: `${TODAY}T08:00:00Z` },
    { id: 't-done2', title: 'Morning walk', status: 'done', categories: ['health'], completed_at: '2026-08-27T08:00:00Z' },
    { id: 't-done3', title: 'Morning walk', status: 'done', categories: ['health'], completed_at: '2026-07-04T08:00:00Z' }, // outside BOTH windows
    { id: 't-other', title: 'Ship release', status: 'open', categories: ['career'] },
  ],
  taskOf: () => undefined, tags: () => [], objectives: () => [], suggestions: () => [],
  refetchSuggestions: vi.fn(), isSuggestionBusy: () => false, setSuggestionBusy: vi.fn(),
  connections: () => [], showToast: vi.fn(), refetchTasks: vi.fn(), setElementModal: vi.fn(),
}));

const { DetailsDrawer } = await import('./DetailsDrawer.js');

const text = () => document.body.textContent ?? '';
beforeEach(() => { vi.clearAllMocks(); setEntity({ kind: 'dimension', id: 'health' }); });

describe('DetailsDrawer — dimension panel', () => {
  it('reports unallocated time as target minus what is scheduled', async () => {
    render(() => <DetailsDrawer />);
    // 14h target; scheduled = 60 + 60 + 45 = 165m = 2.8h → unallocated 11.3h
    await waitFor(() => expect(text()).toContain('2.8h'));
    expect(text()).toContain('11.3h');
    expect(text()).toMatch(/Unallocated/i);
  });

  it('ignores blocks belonging to another dimension', async () => {
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    expect(text()).not.toContain('Standup'); // career
  });

  it('collapses a repeated title to one row with a digit', async () => {
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    expect(screen.getAllByText('Gym session')).toHaveLength(1);
    expect(text()).toContain('x2'); // two gym blocks this week
  });

  it('does not repeat an already-scheduled task under Open', async () => {
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    // 'Gym session' appears once — as a SCHEDULED row, not again as an open task
    expect(screen.getAllByText('Gym session')).toHaveLength(1);
    expect(text()).toMatch(/Open \(1\)/);
  });

  it('keeps completed history collapsed until it is asked for', async () => {
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    expect(text()).not.toContain('Morning walk');
    fireEvent.click(screen.getByText(/Completed/));
    expect(text()).toContain('Morning walk');
    expect(screen.getAllByText('Morning walk')).toHaveLength(1); // deduped
  });

  it('re-scopes the target and the lists when the window changes', async () => {
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    // August has 31 days → 14 × 31/7 = 62h
    fireEvent.click(screen.getByText('month'));
    await waitFor(() => expect(text()).toContain('62h'));
    // and the July completion is still outside the August month window
    fireEvent.click(screen.getByText(/Completed/));
    expect(screen.getAllByText('Morning walk')).toHaveLength(1);
    expect(text()).toContain('x2'); // the two August walks, not the July one
  });
});
