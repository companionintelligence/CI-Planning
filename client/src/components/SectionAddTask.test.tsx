import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

/**
 * Phase 3 — the add box at the DOM seam. The acceptance bar is "both paths work
 * from the keyboard alone", so these drive it entirely with typing and keys:
 * search → Enter picks a match; no match → Enter creates and places.
 */

const listTasks = vi.fn();
const createTask = vi.fn();
const addTasks = vi.fn();
const refetchBlocks = vi.fn();
const refetchTasks = vi.fn();
const showToast = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    tasks: {
      list: (...a: unknown[]) => listTasks(...a),
      create: (...a: unknown[]) => createTask(...a),
    },
    blocks: { addTasks: (...a: unknown[]) => addTasks(...a) },
  },
}));
vi.mock('../stores/index.js', () => ({
  refetchBlocks: (...a: unknown[]) => refetchBlocks(...a),
  refetchTasks: (...a: unknown[]) => refetchTasks(...a),
  showToast: (...a: unknown[]) => showToast(...a),
}));

const { SectionAddTask } = await import('./SectionAddTask.js');

const BLOCK = { id: 'tb1', title: 'Deep work' } as any;

beforeEach(() => {
  vi.clearAllMocks();
  listTasks.mockResolvedValue({ tasks: [{ id: 't1', title: 'Draft the spec', status: 'open' }] });
  addTasks.mockResolvedValue({ placed: 1, unplaced: 0, skipped: 0, blocksCreated: 1 });
  createTask.mockResolvedValue({ task: { id: 'new1', title: 'Brand new task' } });
});

function typeInto(input: HTMLInputElement, text: string) {
  fireEvent.input(input, { target: { value: text } });
}

const boxOf = (c: HTMLElement) => c.querySelector('input') as HTMLInputElement;

describe('SectionAddTask — search path', () => {
  it('Enter on a match places that task into THIS block', async () => {
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    const input = boxOf(container);
    typeInto(input, 'draft');
    await waitFor(() => expect(container.textContent).toContain('Draft the spec'));

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(addTasks).toHaveBeenCalledWith('tb1', ['t1']));
    expect(createTask).not.toHaveBeenCalled();
  });

  it('clicking a match places it too', async () => {
    const { container, getByText } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    typeInto(boxOf(container), 'draft');
    await waitFor(() => getByText('Draft the spec'));
    fireEvent.click(getByText('Draft the spec'));
    await waitFor(() => expect(addTasks).toHaveBeenCalledWith('tb1', ['t1']));
  });

  it('a task already in the block is not offered', async () => {
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set(['t1'])} />);
    typeInto(boxOf(container), 'draft');
    // The only match is excluded → the create affordance takes its place.
    await waitFor(() => expect(container.textContent).toMatch(/Create/));
    expect(container.textContent).not.toContain('Draft the spec');
  });

  it('refetches blocks and tasks so the new member shows up everywhere', async () => {
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    typeInto(boxOf(container), 'draft');
    await waitFor(() => expect(container.textContent).toContain('Draft the spec'));
    fireEvent.keyDown(boxOf(container), { key: 'Enter' });
    await waitFor(() => expect(refetchBlocks).toHaveBeenCalled());
    expect(refetchTasks).toHaveBeenCalled();
  });
});

describe('SectionAddTask — create path', () => {
  it('Enter with no match creates the task, then places it — one gesture', async () => {
    listTasks.mockResolvedValue({ tasks: [] });
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    const input = boxOf(container);
    typeInto(input, 'Brand new task');
    await waitFor(() => expect(container.textContent).toMatch(/Create/));

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ title: 'Brand new task' }));
    await waitFor(() => expect(addTasks).toHaveBeenCalledWith('tb1', ['new1']));
  });

  it('clears the box after a successful add', async () => {
    listTasks.mockResolvedValue({ tasks: [] });
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    const input = boxOf(container);
    typeInto(input, 'Brand new task');
    await waitFor(() => expect(container.textContent).toMatch(/Create/));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('does nothing on Enter with an empty box', async () => {
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    fireEvent.keyDown(boxOf(container), { key: 'Enter' });
    await Promise.resolve();
    expect(createTask).not.toHaveBeenCalled();
    expect(addTasks).not.toHaveBeenCalled();
  });
});

describe('SectionAddTask — keyboard', () => {
  it('ArrowDown moves the highlight to the second match, and Enter picks it', async () => {
    listTasks.mockResolvedValue({
      tasks: [
        { id: 't1', title: 'Draft the spec', status: 'open' },
        { id: 't2', title: 'Draft the email', status: 'open' },
      ],
    });
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    const input = boxOf(container);
    typeInto(input, 'draft');
    await waitFor(() => expect(container.textContent).toContain('Draft the email'));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(addTasks).toHaveBeenCalledWith('tb1', ['t2']));
  });

  it('Escape clears the query and closes the list', async () => {
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    const input = boxOf(container);
    typeInto(input, 'draft');
    await waitFor(() => expect(container.textContent).toContain('Draft the spec'));
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(container.textContent).not.toContain('Draft the spec');
  });
});

describe('SectionAddTask — outcomes', () => {
  it('a full Time Block is reported honestly instead of reading as success', async () => {
    addTasks.mockResolvedValue({ placed: 0, unplaced: 1, skipped: 0, blocksCreated: 0 });
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    typeInto(boxOf(container), 'draft');
    await waitFor(() => expect(container.textContent).toContain('Draft the spec'));
    fireEvent.keyDown(boxOf(container), { key: 'Enter' });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/no room/i), 'default'));
  });

  it('surfaces an API failure', async () => {
    addTasks.mockRejectedValue(new Error('boom'));
    const { container } = render(() => <SectionAddTask block={BLOCK} memberTaskIds={new Set()} />);
    typeInto(boxOf(container), 'draft');
    await waitFor(() => expect(container.textContent).toContain('Draft the spec'));
    fireEvent.keyDown(boxOf(container), { key: 'Enter' });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('boom', 'error'));
  });
});
