import { describe, it, expect, vi } from 'vitest';
import { render } from '@solidjs/testing-library';
import type { Task } from '../lib/api.js';

/**
 * AF-11 — TaskCard renders the SPLIT tag shape: level-1 `tags` (the direction)
 * as solid #badges, level-2 `secondary_tags` (intentions) as ghost/outline
 * badges (title="secondary tag"). Post-split, a task's intentions arrive ONLY
 * in `secondary_tags`, so this is the card surface that keeps them visible.
 *
 * SEAMS mocked: api (no network), stores (empty signals), @solidjs/router
 * (useNavigate outside a Router throws). Pure helpers (pattern-meta, textures)
 * run as-is.
 */

vi.mock('../lib/api.js', () => ({
  api: {
    tasks: {
      subtasks: vi.fn(async () => ({ subtasks: [] })),
      streak: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      skip: vi.fn(async () => ({})),
      promoteObjective: vi.fn(async () => ({})),
      // Never called by TaskCard — mocked so ENTITY-4 can ASSERT it stays that way
      // (the reversed prompt→create({parent_id}) placeholder design must not return).
      create: vi.fn(async () => ({})),
    },
    flightPlan: { addTask: vi.fn(async () => ({ added: true })) },
    patterns: { create: vi.fn(async () => ({})), addTask: vi.fn(async () => ({})) },
    objectives: { list: vi.fn(async () => ({ objectives: [] })) },
  },
}));

vi.mock('../stores/index.js', () => ({
  tasks: () => [],
  refetchTasks: vi.fn(),
  showToast: vi.fn(),
  setElementModal: vi.fn(),
  tags: () => [
    { id: 'd1', name: 'work', kind: 'direction', directions: [] },
    { id: 'i1', name: 'deep', kind: 'intention', directions: ['work'] },
  ],
  patternPrefs: () => ({ prefs: {} }),
  patterns: () => [],
  patternTypes: () => [],
  refetchPatterns: vi.fn(),
  patternForTask: () => undefined,
  isRoutineTask: () => false,
  flightPlanTaskIds: () => new Set<string>(),
  scheduledByTaskId: () => new Set<string>(),
  texturesEnabled: () => true,
}));

vi.mock('@solidjs/router', () => ({ useNavigate: () => () => {} }));

const { TaskCard } = await import('./TaskCard.js');
const { api } = await import('../lib/api.js'); // the mocked instance, for payload assertions

const baseTask = {
  id: 't1',
  title: 'Write the spec',
  status: 'open',
  priority: 3,
  tags: ['work'],
  secondary_tags: ['deep', 'errand'],
  depends_on: [],
  blocked: false,
} as unknown as Task;

describe('TaskCard — split tag rendering (AF-11)', () => {
  it('renders the L1 direction as a solid badge and L2 intentions as ghost badges', () => {
    const { container } = render(() => <TaskCard task={baseTask} />);
    // Primary (level 1): solid badge with the # prefix.
    const solid = [...container.querySelectorAll('.badge-neutral')].map((el) => el.textContent);
    expect(solid).toEqual(['#work']);
    // Secondary (level 2): ghost badges, marked title="secondary tag", no # prefix.
    const ghosts = [...container.querySelectorAll('[title="secondary tag"]')].map((el) => el.textContent);
    expect(ghosts).toEqual(['deep', 'errand']);
  });

  it('renders ghost badges even when the task has NO level-1 direction (tags: [])', () => {
    const t = { ...baseTask, id: 't2', tags: [], secondary_tags: ['deep'] } as unknown as Task;
    const { container } = render(() => <TaskCard task={t} />);
    expect(container.querySelectorAll('.badge-neutral').length).toBe(0);
    const ghosts = [...container.querySelectorAll('[title="secondary tag"]')].map((el) => el.textContent);
    expect(ghosts).toEqual(['deep']);
  });

  it('renders no tag row at all when both levels are empty', () => {
    const t = { ...baseTask, id: 't3', tags: [], secondary_tags: [] } as unknown as Task;
    const { container } = render(() => <TaskCard task={t} />);
    expect(container.querySelectorAll('.badge-neutral').length).toBe(0);
    expect(container.querySelectorAll('[title="secondary tag"]').length).toBe(0);
  });
});

/**
 * The Archive checkbox. Both archive sections un-do to open: a Completed card
 * un-completes, a Thrown-away card restores. 'cancelled' previously fell through
 * to the else branch, so clicking the checkbox on a thrown-away card marked it
 * DONE — destroying the record that it had been thrown away.
 */
describe('TaskCard — archive checkbox un-does both archive states', () => {
  const checkbox = (c: HTMLElement) =>
    [...c.querySelectorAll('button')].find((b) => /Mark done|Mark open|Restore to open/.test(b.title))!;

  it('restores a CANCELLED task to open — never marks it done', async () => {
    vi.mocked(api.tasks.update).mockClear();
    const t = { ...baseTask, id: 'tc-1', status: 'cancelled' } as unknown as Task;
    const { container } = render(() => <TaskCard task={t} />);

    const box = checkbox(container);
    expect(box.title).toBe('Restore to open'); // not the misleading "Mark done"
    box.click();
    await Promise.resolve();

    expect(api.tasks.update).toHaveBeenCalledWith('tc-1', { status: 'open', completed_at: null });
    // The regression: it must NEVER send completed:true for a thrown-away task.
    // objectContaining, not a literal — toHaveBeenCalledWith deep-equals, so a literal
    // passes when a regression sends `completed` alongside anything else, or as a second
    // call. Verified: with a literal, a stray `{completed:true, ...}` call slipped through.
    expect(api.tasks.update).not.toHaveBeenCalledWith('tc-1', expect.objectContaining({ completed: true }));
    // …and exactly one call, closing the same hole from the other side.
    expect(api.tasks.update).toHaveBeenCalledTimes(1);
  });

  it('still un-completes a DONE task (unchanged)', async () => {
    vi.mocked(api.tasks.update).mockClear();
    const t = { ...baseTask, id: 'tc-2', status: 'done' } as unknown as Task;
    const { container } = render(() => <TaskCard task={t} />);

    const box = checkbox(container);
    expect(box.title).toBe('Mark open');
    box.click();
    await Promise.resolve();
    expect(api.tasks.update).toHaveBeenCalledWith('tc-2', { status: 'open', completed_at: null });
  });

  it('still completes an OPEN task (unchanged)', async () => {
    vi.mocked(api.tasks.update).mockClear();
    const t = { ...baseTask, id: 'tc-3', status: 'open' } as unknown as Task;
    const { container } = render(() => <TaskCard task={t} />);

    const box = checkbox(container);
    expect(box.title).toBe('Mark done');
    box.click();
    await Promise.resolve();
    expect(api.tasks.update).toHaveBeenCalledWith('tc-3', { completed: true });
  });
});

/**
 * ENTITY-4 — the assign-to-objective picker's "New objective" footer row. The row
 * promotes directly (no prompt), so it must be withheld from exactly the tasks the
 * server refuses with 422 not_promotable — otherwise the owner clicks and gets an
 * error we could have predicted. Guard lives in lib/objective-promote.ts; these
 * cases pin it to the RENDERED picker, which is what the owner actually touches.
 */
describe('TaskCard — "New objective" row in the objective picker (ENTITY-4)', () => {
  const openPicker = async (t: Task) => {
    const r = render(() => <TaskCard task={t} />);
    (r.getByTitle('Add to objective') as HTMLButtonElement).click();
    // The tree resource is fetched lazily on open; wait for the loading state to clear.
    // Match the stem only — the sentence finishes differently per promotability.
    await r.findByText(/No objectives yet/);
    return r;
  };
  const rowOf = (c: HTMLElement) =>
    [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New objective');

  it('offers the row on a standard task, and drops the "Objectives tab" dead end', async () => {
    const { container, queryByText } = await openPicker({ ...baseTask, id: 'p1' } as Task);
    expect(rowOf(container)).toBeTruthy();
    // The way out is the row itself now — don't send the owner to another tab.
    expect(queryByText(/create one on the Objectives tab/)).toBeNull();
  });

  it('hides the row on a quick task, keeping the Objectives-tab pointer (the only way out left)', async () => {
    const { container, queryByText } = await openPicker({ ...baseTask, id: 'p2', subtype: 'quick' } as Task);
    expect(rowOf(container)).toBeUndefined();
    expect(queryByText(/create one on the Objectives tab/)).toBeTruthy();
  });

  it('hides the row on a recurrence instance', async () => {
    const t = { ...baseTask, id: 'p3', recurrence_parent_id: 'r1' } as unknown as Task;
    const { container } = await openPicker(t);
    expect(rowOf(container)).toBeUndefined();
  });

  // Archive → "Thrown away" renders full TaskCards (views/AllTasks.tsx), so this row is
  // live on cancelled cards. Cancelling hard-deletes the task's pristine objective
  // (dropSourceObjective); the promote route would happily rebuild it — 200, not 422.
  it('hides the row on a thrown-away task, so the picker cannot undo dropSourceObjective', async () => {
    const t = { ...baseTask, id: 'p5', status: 'cancelled' } as unknown as Task;
    const { container } = await openPicker(t);
    expect(rowOf(container)).toBeUndefined();
  });

  it('promotes via the task route (no prompt, no placeholder subtask) and closes the menu', async () => {
    vi.mocked(api.tasks.promoteObjective).mockClear();
    const { container } = await openPicker({ ...baseTask, id: 'p4' } as Task);
    rowOf(container)!.click();
    await vi.waitFor(() => expect(api.tasks.promoteObjective).toHaveBeenCalledWith('p4'));
    // Direct promotion: never the ENTITY-3-era prompt → tasks.create({parent_id}) path.
    expect(api.tasks.create).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rowOf(container)).toBeUndefined()); // menu unmounted
  });
});
