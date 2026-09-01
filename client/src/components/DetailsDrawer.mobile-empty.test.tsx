import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * DetailsDrawer — mobile empty-state bottom sheet.
 *
 * On mobile the drawer is a fixed bottom sheet (see .details-drawer under the
 * max-width:767px query in index.css). With nothing selected it had no content
 * of its own but still sat over the bottom of the screen, intercepting clicks
 * meant for bottom-anchored controls underneath it (the add-task FAB, the FTUE
 * wizard's Next button). The `details-drawer-empty` class is what index.css
 * keys off to `display: none` the sheet in that state on mobile only — this
 * test locks down when the class is (and isn't) applied.
 */

let pathname = '/tasks';
vi.mock('@solidjs/router', () => ({ useLocation: () => ({ pathname }) }));
vi.mock('./FlightPlan.js', () => ({ FlightPlan: () => <div>flight-plan-list</div> }));
vi.mock('./LockToggle.js', () => ({ LockToggle: () => null }));
vi.mock('./TaskCard.js', () => ({ PriorityToggle: () => null, DateField: () => null }));
vi.mock('../lib/lock.js', () => ({ lockAffordance: () => ({}) }));
vi.mock('../lib/recurrence.js', () => ({ describeRule: () => '' }));
vi.mock('../lib/tag-tax.js', () => ({ displayTag: (n: string) => n }));
vi.mock('../lib/objectives.js', () => ({ flattenObjectives: () => [] }));
vi.mock('../lib/api.js', () => ({ api: { priorities: { list: async () => ({ priorities: [] }), history: async () => null } } }));

const [activeTaskId, setActiveTaskId] = createSignal<string | null>(null);
const [entity, setEntity] = createSignal<{ kind: string; id: string } | null>(null);
vi.mock('../stores/selection.js', () => ({
  activeTask: () => activeTaskId(), activeBlock: () => null, activeEntity: () => entity(),
  clearActiveEntity: () => { setActiveTaskId(null); setEntity(null); },
  setActiveTask: (id: string) => setActiveTaskId(id),
  setActiveBlock: vi.fn(), setActiveEntity: (kind: string, id: string) => setEntity({ kind, id }),
}));

const [drawerTab, setDrawerTabSignal] = createSignal<'details' | 'flightplan'>('details');
vi.mock('../stores/ui.js', () => ({
  detailsOpen: () => true, detailsWidth: () => 360, setDetailsOpen: vi.fn(), setDetailsWidth: vi.fn(),
  drawerTab: () => drawerTab(), setDrawerTab: (t: 'details' | 'flightplan') => setDrawerTabSignal(t),
  DETAILS_MIN_W: 280, DETAILS_MAX_W: 640, DETAILS_DEFAULT_W: 360,
}));
vi.mock('../stores/index.js', () => ({
  blocks: () => [],
  tasks: () => [{ id: 't-1', title: 'Test task', status: 'open', priority: 2 }],
  taskOf: (id: string) => (id === 't-1' ? { id: 't-1', title: 'Test task', status: 'open', priority: 2 } : undefined),
  tags: () => [], objectives: () => [], suggestions: () => [],
  refetchSuggestions: vi.fn(), isSuggestionBusy: () => false, setSuggestionBusy: vi.fn(),
  connections: () => [], showToast: vi.fn(), refetchTasks: vi.fn(), setElementModal: vi.fn(),
}));

const { DetailsDrawer } = await import('./DetailsDrawer.js');

const aside = () => document.querySelector('aside.details-drawer') as HTMLElement;

beforeEach(() => {
  pathname = '/tasks';
  setActiveTaskId(null);
  setEntity(null);
  setDrawerTabSignal('details');
});

describe('DetailsDrawer — mobile empty-state bottom sheet', () => {
  it('marks the drawer empty when nothing is selected, so mobile CSS can hide the sheet', async () => {
    render(() => <DetailsDrawer />);
    expect(screen.getByText(/Select .* to see its details here/)).toBeTruthy();
    expect(aside().classList.contains('details-drawer-empty')).toBe(true);
  });

  it('clears the empty marker once something is selected', async () => {
    render(() => <DetailsDrawer />);
    expect(aside().classList.contains('details-drawer-empty')).toBe(true);
    setActiveTaskId('t-1');
    expect(aside().classList.contains('details-drawer-empty')).toBe(false);
  });

  it('does not mark the drawer empty on Today while the Flight Plan tab has content, even with nothing selected', async () => {
    pathname = '/';
    setDrawerTabSignal('flightplan');
    render(() => <DetailsDrawer />);
    expect(screen.getByText('flight-plan-list')).toBeTruthy();
    expect(aside().classList.contains('details-drawer-empty')).toBe(false);
  });

  it('re-marks the drawer empty after a selection clears', async () => {
    render(() => <DetailsDrawer />);
    setActiveTaskId('t-1');
    expect(aside().classList.contains('details-drawer-empty')).toBe(false);
    fireEvent.click(screen.getByLabelText('Close details'));
    expect(aside().classList.contains('details-drawer-empty')).toBe(true);
  });
});
