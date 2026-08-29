import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { Objective } from '../lib/api.js';

/**
 * DetailsDrawer — the Objective panel (AF-D).
 *
 * Clicking an objective used to open the create/edit MODAL, which answered "what is
 * this?" with a form and left the linked tasks reachable only by expanding the tree
 * row. The contracts pinned here:
 *   1. an objective selection renders in the drawer at all — title, level, subtasks;
 *   2. every subtask is a real anchor with a working task deep-link href, so
 *      cmd/middle-click opens it in a genuine browser tab;
 *   3. a PLAIN click is intercepted and stays in the drawer (setActiveTask), rather
 *      than navigating — the href is a fallback, not the primary interaction;
 *   4. child objectives are listed and select the child objective.
 */

const setActiveTaskMock = vi.fn();
const setActiveEntityMock = vi.fn();
const [entity, setEntity] = createSignal<{ kind: string; id: string } | null>(null);

const OBJ_CHILD: Objective = {
  id: 'obj-child', owner_id: 'o', parent_id: 'obj-root', level: 'objective', horizon: 'month',
  title: 'Marketplace submission', description: null, target_date: null, status: 'active',
  category_id: null, progress_cache: 0, cadence: 'none', last_advanced_at: null, priority: 2,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', completed_at: null,
  source_task_id: null, next_action: null, effective_target: null, pace_expected: null,
  has_tasks: true,
  tasks: [
    { id: 'task-1', title: 'Review Hub Requirements', status: 'open', priority: 2, due_at: null, scheduled_for: null, parent_id: null, completed_at: null },
    { id: 'task-2', title: 'Record demo video', status: 'done', priority: 3, due_at: null, scheduled_for: null, parent_id: null, completed_at: '2026-08-02T00:00:00Z' },
  ],
  children: [],
};
const OBJ_ROOT: Objective = {
  ...OBJ_CHILD, id: 'obj-root', parent_id: null, level: 'project', horizon: 'quarter',
  title: 'Launch app in Companion-Hub', description: 'Get it listed.', has_tasks: false,
  tasks: [], children: [OBJ_CHILD],
};

vi.mock('@solidjs/router', () => ({ useLocation: () => ({ pathname: '/tasks' }) }));
vi.mock('./Planner.js', () => ({ Planner: () => null }));
vi.mock('./LockToggle.js', () => ({ LockToggle: () => null }));
vi.mock('./TaskCard.js', () => ({ PriorityToggle: () => null, DateField: () => null }));
vi.mock('../lib/lock.js', () => ({ lockAffordance: () => ({}) }));
vi.mock('../lib/recurrence.js', () => ({ describeRule: () => '' }));
vi.mock('../lib/tag-tax.js', () => ({ displayTag: (n: string) => n }));
vi.mock('../lib/objectives.js', () => ({ flattenObjectives: () => [] }));
vi.mock('../lib/api.js', () => ({ api: {} }));

vi.mock('../stores/selection.js', () => ({
  activeTask: () => null,
  activeBlock: () => null,
  activeEntity: () => entity(),
  clearActiveEntity: () => setEntity(null),
  setActiveTask: (id: string) => setActiveTaskMock(id),
  setActiveBlock: vi.fn(),
  setActiveEntity: (kind: string, id: string) => { setActiveEntityMock(kind, id); setEntity({ kind, id }); },
}));
vi.mock('../stores/ui.js', () => ({
  detailsOpen: () => true, detailsWidth: () => 360,
  setDetailsOpen: vi.fn(), setDetailsWidth: vi.fn(),
  drawerTab: () => 'details', setDrawerTab: vi.fn(),
  DETAILS_MIN_W: 280, DETAILS_MAX_W: 640, DETAILS_DEFAULT_W: 360,
}));
vi.mock('../stores/index.js', () => ({
  blocks: () => [], tasks: () => [], taskOf: () => undefined, tags: () => [],
  objectives: () => [OBJ_ROOT], suggestions: () => [], refetchSuggestions: vi.fn(),
  isSuggestionBusy: () => false, setSuggestionBusy: vi.fn(), connections: () => [],
  showToast: vi.fn(), refetchTasks: vi.fn(), setElementModal: vi.fn(),
}));

const { DetailsDrawer } = await import('./DetailsDrawer.js');

beforeEach(() => { vi.clearAllMocks(); setEntity(null); });

describe('DetailsDrawer — objective panel', () => {
  it('renders the objective, its level and its subtasks', () => {
    setEntity({ kind: 'objective', id: 'obj-child' });
    render(() => <DetailsDrawer />);
    expect(screen.getByText('Marketplace submission')).toBeTruthy();
    expect(screen.getByText('Review Hub Requirements')).toBeTruthy();
    expect(screen.getByText('Record demo video')).toBeTruthy();
    // the header names the LEVEL, not the generic kind
    expect(screen.getAllByText(/Objective/i).length).toBeGreaterThan(0);
  });

  it('renders each subtask as a real hotlink to its task deep-link', () => {
    setEntity({ kind: 'objective', id: 'obj-child' });
    render(() => <DetailsDrawer />);
    const link = screen.getByText('Review Hub Requirements').closest('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/tasks?tab=tasks&task=task-1');
  });

  it('a plain click opens the subtask in the drawer instead of navigating', () => {
    setEntity({ kind: 'objective', id: 'obj-child' });
    render(() => <DetailsDrawer />);
    const link = screen.getByText('Review Hub Requirements').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);
    expect(setActiveTaskMock).toHaveBeenCalledWith('task-1');
    expect(ev.defaultPrevented).toBe(true); // navigation suppressed
  });

  it('leaves cmd/ctrl-click to the browser so it opens a new tab', () => {
    setEntity({ kind: 'objective', id: 'obj-child' });
    render(() => <DetailsDrawer />);
    const link = screen.getByText('Review Hub Requirements').closest('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    link.dispatchEvent(ev);
    expect(setActiveTaskMock).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false); // the href is allowed to win
  });

  it('lists child objectives and selects them', () => {
    setEntity({ kind: 'objective', id: 'obj-root' });
    render(() => <DetailsDrawer />);
    const child = screen.getByText('Marketplace submission').closest('a')!;
    expect(child.getAttribute('href')).toBe('/tasks?tab=objectives&focus=obj-child');
    fireEvent.click(child);
    expect(setActiveEntityMock).toHaveBeenCalledWith('objective', 'obj-child');
  });
});
