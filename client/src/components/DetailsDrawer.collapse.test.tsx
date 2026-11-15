import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';

/**
 * DetailsDrawer — the head has two ways out. "Collapse details" folds the drawer away and keeps the
 * selection, so reopening from the top bar brings the same item back. "Close details" folds it away
 * and clears the selection. Only the collapse must leave the selection alone.
 *
 * Mocks follow DetailsDrawer.mobile-empty.test.tsx; the stores the drawer reads are stubbed so it
 * renders one task without a network.
 */

const { setDetailsOpen, clearActiveEntity } = vi.hoisted(() => ({
  setDetailsOpen: vi.fn(),
  clearActiveEntity: vi.fn(),
}));

vi.mock('@solidjs/router', () => ({ useLocation: () => ({ pathname: '/tasks' }) }));
vi.mock('./FlightPlan.js', () => ({ FlightPlan: () => <div>flight-plan-list</div> }));
vi.mock('./LockToggle.js', () => ({ LockToggle: () => null }));
vi.mock('./TaskCard.js', () => ({ PriorityToggle: () => null, DateField: () => null }));
vi.mock('../lib/lock.js', () => ({ lockAffordance: () => ({}) }));
vi.mock('../lib/recurrence.js', () => ({ describeRule: () => '' }));
vi.mock('../lib/tag-tax.js', () => ({ displayTag: (n: string) => n }));
vi.mock('../lib/objectives.js', () => ({ flattenObjectives: () => [] }));
vi.mock('../lib/api.js', () => ({ api: { priorities: { list: async () => ({ priorities: [] }), history: async () => null } } }));

vi.mock('../stores/selection.js', () => ({
  activeTask: () => 't-1', activeBlock: () => null, activeEntity: () => null,
  clearActiveEntity,
  setActiveTask: vi.fn(), setActiveBlock: vi.fn(), setActiveEntity: vi.fn(),
}));

vi.mock('../stores/ui.js', () => ({
  detailsOpen: () => true, detailsWidth: () => 360, setDetailsOpen, setDetailsWidth: vi.fn(),
  drawerTab: () => 'details', setDrawerTab: vi.fn(),
  DETAILS_MIN_W: 280, DETAILS_MAX_W: 640, DETAILS_DEFAULT_W: 360,
}));

vi.mock('../stores/index.js', () => ({
  blocks: () => [],
  tasks: () => [{ id: 't-1', title: 'Test task', status: 'open', priority: 2 }],
  taskOf: (id: string) => (id === 't-1' ? { id: 't-1', title: 'Test task', status: 'open', priority: 2 } : undefined),
  tags: () => [], objectives: () => [], suggestions: () => [],
  refetchSuggestions: vi.fn(), isSuggestionBusy: () => false, setSuggestionBusy: vi.fn(),
  connections: () => [], showToast: vi.fn(), refetchTasks: vi.fn(), setElementModal: vi.fn(),
  selectedDay: () => '2026-11-02', refetchBlocks: vi.fn(), refetchFlightPlan: vi.fn(),
  askRecurringScope: vi.fn(), isRecurringOccurrence: () => false,
}));

const { DetailsDrawer } = await import('./DetailsDrawer.js');

beforeEach(() => {
  setDetailsOpen.mockClear();
  clearActiveEntity.mockClear();
});

describe('DetailsDrawer collapse', () => {
  it('collapse folds the drawer away and keeps the selection', () => {
    render(() => <DetailsDrawer />);
    fireEvent.click(screen.getByLabelText('Collapse details'));
    expect(setDetailsOpen).toHaveBeenCalledWith(false);
    expect(clearActiveEntity).not.toHaveBeenCalled();
  });

  it('close folds the drawer away and clears the selection', () => {
    render(() => <DetailsDrawer />);
    fireEvent.click(screen.getByLabelText('Close details'));
    expect(clearActiveEntity).toHaveBeenCalled();
    expect(setDetailsOpen).toHaveBeenCalledWith(false);
  });
});
