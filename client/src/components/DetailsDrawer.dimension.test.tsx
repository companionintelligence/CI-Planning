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
 *   5. Completed is collapsed until asked for;
 *   6. the Open list is priority/due_at/id-ordered, and each row can stage its task
 *      into the flight-plan (only while the dimension has unallocated time).
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
const flightPlanAddTaskMock = vi.fn(async () => ({ flight_plan: [], added: 1 }));
vi.mock('../lib/api.js', () => ({
  api: {
    priorities: {
      list: async () => ({
        priorities: [
          { category: 'health', satisfaction: 6, importance: 10, target_hours_per_week: 14 },
          // unallocated stays > 0 (target 5h vs 15m scheduled by b4/Standup) — the Stage
          // buttons this file's 6th contract exercises need somewhere to show up.
          { category: 'career', satisfaction: 5, importance: 9, target_hours_per_week: 5 },
          // target 0h, nothing scheduled → unallocated is exactly 0: the "at/over target,
          // no Stage buttons" case.
          { category: 'mind', satisfaction: 8, importance: 8, target_hours_per_week: 0 },
        ],
      }),
    },
    blocks: { list: (...a: unknown[]) => blocksListMock(...(a as [])) },
    flightPlan: { addTask: (...a: unknown[]) => flightPlanAddTaskMock(...(a as [])) },
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
const showToastMock = vi.fn();
const refetchTasksMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  blocks: () => [],                       // deliberately EMPTY: the panel must not rely on it
  tasks: () => [
    // already on the calendar this window → must NOT also appear under Open
    { id: 't-gym', title: 'Gym session', status: 'scheduled', categories: ['health'], estimated_minutes: 60 },
    { id: 't-open1', title: 'Book physio', status: 'open', categories: ['health'], estimated_minutes: 30, priority: 2 },
    { id: 't-done1', title: 'Morning walk', status: 'done', categories: ['health'], completed_at: `${TODAY}T08:00:00Z` },
    { id: 't-done2', title: 'Morning walk', status: 'done', categories: ['health'], completed_at: '2026-08-27T08:00:00Z' },
    { id: 't-done3', title: 'Morning walk', status: 'done', categories: ['health'], completed_at: '2026-07-04T08:00:00Z' }, // outside BOTH windows
    // Open-list ordering + staging fixtures (career): priority 1 sorts before 2, and
    // within priority 1 the earlier due_at sorts first — 'Call client' groups its two
    // instances into one row whose `first` is the earlier-due one.
    { id: 't-c-hi-early', title: 'Call client', status: 'open', categories: ['career'], priority: 1, due_at: '2026-08-30' },
    { id: 't-c-hi-late', title: 'Call client', status: 'open', categories: ['career'], priority: 1, due_at: '2026-09-05' },
    { id: 't-c-mid', title: 'Write proposal', status: 'open', categories: ['career'], priority: 2, due_at: '2026-09-01' },
    { id: 't-other', title: 'Ship release', status: 'open', categories: ['career'], priority: 2 }, // no due_at → sorts last of priority 2
    // 'mind' has a 0h target and nothing scheduled → unallocated is exactly 0, the
    // no-Stage-button case.
    { id: 't-mind1', title: 'Read book', status: 'open', categories: ['mind'], priority: 2 },
  ],
  taskOf: () => undefined, tags: () => [], objectives: () => [], suggestions: () => [],
  refetchSuggestions: vi.fn(), isSuggestionBusy: () => false, setSuggestionBusy: vi.fn(),
  connections: () => [],
  showToast: (...a: unknown[]) => showToastMock(...(a as [])),
  refetchTasks: (...a: unknown[]) => refetchTasksMock(...(a as [])),
  setElementModal: vi.fn(),
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

  it('orders the Open list by priority, then due date, then id', async () => {
    setEntity({ kind: 'dimension', id: 'career' });
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toMatch(/Open \(3\)/));
    // priority 1 (due 08-30, due 09-05, grouped to one row) before priority 2's
    // due-dated task, before priority 2's undated task.
    const order = ['Call client', 'Write proposal', 'Ship release'].map((t) => text().indexOf(t));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(text()).toContain('x2'); // the two 'Call client' instances collapsed
  });

  it('shows the Stage button on Open rows only while the dimension has unallocated time', async () => {
    render(() => <DetailsDrawer />); // health: 14h target, 2.8h scheduled → unallocated > 0
    await waitFor(() => expect(text()).toContain('Unallocated'));
    expect(screen.getByTitle('Stage this task')).toBeTruthy();
  });

  it('hides the Stage button when a dimension is at or over target', async () => {
    setEntity({ kind: 'dimension', id: 'mind' });
    render(() => <DetailsDrawer />);
    // wait for the async priorities fetch to resolve — before it does, `row()` is
    // undefined and the Allocation group (which the Stage gate itself does not read)
    // hasn't rendered either, which would make this assertion pass for the wrong reason.
    await waitFor(() => expect(text()).toContain('Unallocated'));
    expect(text()).toContain('0h'); // target and unallocated both read 0h
    expect(screen.queryByTitle('Stage this task')).toBeNull();
  });

  it('tapping Stage stages that row\'s task, refetches tasks, and does not open the task panel', async () => {
    setEntity({ kind: 'dimension', id: 'career' });
    render(() => <DetailsDrawer />);
    // same as above: wait for the resolved target, not just for the (synchronously
    // available) task list, or unallocated() would still be reading the pre-resolve
    // fallback and the Stage button wouldn't have rendered yet.
    await waitFor(() => expect(text()).toContain('Unallocated'));
    const row = screen.getByText('Ship release').closest('[role="button"]') as HTMLElement;
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(flightPlanAddTaskMock).toHaveBeenCalledWith('t-other'));
    await waitFor(() => expect(refetchTasksMock).toHaveBeenCalled());
    expect(setActiveTaskMock).not.toHaveBeenCalled();
    // the row's own click still works — restructuring it for the Stage button did not
    // break normal navigation.
    fireEvent.click(screen.getByText('Write proposal'));
    expect(setActiveTaskMock).toHaveBeenCalledWith('t-c-mid');
  });

  it('stages the first occurrence of a grouped (repeated-title) row', async () => {
    setEntity({ kind: 'dimension', id: 'career' });
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    const row = screen.getByText('Call client').closest('[role="button"]') as HTMLElement;
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(flightPlanAddTaskMock).toHaveBeenCalledWith('t-c-hi-early'));
    expect(flightPlanAddTaskMock).not.toHaveBeenCalledWith('t-c-hi-late');
  });

  it('shows an error toast and leaves the row unchanged when the stage call fails', async () => {
    setEntity({ kind: 'dimension', id: 'career' });
    flightPlanAddTaskMock.mockRejectedValueOnce(new Error('network down'));
    render(() => <DetailsDrawer />);
    await waitFor(() => expect(text()).toContain('Unallocated'));
    const row = screen.getByText('Ship release').closest('[role="button"]') as HTMLElement;
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('network down', 'error'));
    expect(refetchTasksMock).not.toHaveBeenCalled();
    expect(text()).toContain('Ship release'); // the row is still there, unstaged
  });
});
