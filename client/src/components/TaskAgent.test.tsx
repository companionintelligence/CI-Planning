import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

const plan = vi.fn();
const place = vi.fn();
const update = vi.fn();
const create = vi.fn();
const addTasks = vi.fn();
const updateBlock = vi.fn();
const refetchTasks = vi.fn();
vi.mock('../lib/api.js', () => ({ api: {
  taskAgent: { plan: (...args: unknown[]) => plan(...args), place: (...args: unknown[]) => place(...args) },
  tasks: { create: (...args: unknown[]) => create(...args), update: (...args: unknown[]) => update(...args) },
  blocks: { addTasks: (...args: unknown[]) => addTasks(...args), update: (...args: unknown[]) => updateBlock(...args) },
  objectives: { moveTask: vi.fn(), linkTask: vi.fn() },
} }));
vi.mock('../stores/index.js', () => ({ refetchTasks: (...args: unknown[]) => refetchTasks(...args), refetchObjectives: vi.fn(), refetchBlocks: vi.fn() }));
vi.mock('../stores/selection.js', () => ({ setActiveTask: vi.fn() }));
vi.mock('../stores/ui.js', () => ({ revealDetails: vi.fn() }));

const { TaskAgent } = await import('./TaskAgent.js');

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.clearAllMocks();
  plan.mockResolvedValue({
    reply: 'I can move Call Sam to Friday.',
    actions: [{ kind: 'update_task', task_id: 't1', scheduled_for: '2026-11-27' }],
    tasks: [{ id: 't1', title: 'Call Sam' }],
    objectives: [],
  });
  update.mockResolvedValue({ task: { id: 't1' } });
  place.mockResolvedValue({ placement: { placed: true } });
  create.mockResolvedValueOnce({ task: { id: 'new-1' } }).mockResolvedValueOnce({ task: { id: 'new-2' } });
  addTasks.mockResolvedValue({ placed: 2, unplaced: 0, skipped: 0, blocksCreated: 2 });
  updateBlock.mockResolvedValue({ block: { id: 'b1' } });
});

describe('task assistant review', () => {
  it('puts speech recognition text into the editable message before Send', async () => {
    class Recognition {
      static latest: Recognition;
      lang = '';
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
      onerror = null;
      onend: (() => void) | null = null;
      start() { Recognition.latest = this; }
      abort() {}
      stop() {}
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    render(() => <TaskAgent open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Dictate your request'));
    Recognition.latest.onresult!({ results: [[{ transcript: 'Add a note to Call Sam' }]] });
    Recognition.latest.onend?.();
    const input = screen.getByLabelText('Message the task assistant') as HTMLTextAreaElement;
    expect(input.value).toBe('Add a note to Call Sam');
    expect(plan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(plan).toHaveBeenCalledWith('Add a note to Call Sam', [], undefined));
  });

  it('opens iPhone keyboard dictation and keeps text editable until Send', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    render(() => <TaskAgent open onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open keyboard for voice dictation'));
    const input = screen.getByLabelText('Message the task assistant') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: 'Review this dictated request' } });
    expect(input.value).toBe('Review this dictated request');
    expect(plan).not.toHaveBeenCalled();
  });

  it('reviews and edits new task drafts before placing them in a time block', async () => {
    plan.mockResolvedValueOnce({ reply: 'I can add these to Morning.', actions: [{ kind: 'create_tasks', tasks: [{ title: 'Breakfast', estimated_minutes: 15 }, { title: 'Feed cats', estimated_minutes: 15 }], target_block_id: 'b1' }], tasks: [], objectives: [], blocks: [{ id: 'b1', title: 'Morning', start_at: '2026-11-23T16:00:00Z', end_at: '2026-11-23T17:00:00Z' }] });
    render(() => <TaskAgent open onClose={vi.fn()} />);
    fireEvent.input(screen.getByLabelText('Message the task assistant'), { target: { value: 'Add breakfast and feed cats to Morning' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getByLabelText('Draft task 1')).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Draft task 2'), { target: { value: 'Feed the cats' } });
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenNthCalledWith(2, { title: 'Feed the cats', estimated_minutes: 15 });
    await waitFor(() => expect(addTasks).toHaveBeenCalledWith('b1', ['new-1', 'new-2']));
  });

  it('keeps the focused duration field inside a scrollable review when the keyboard opens', async () => {
    plan.mockResolvedValueOnce({ reply: 'Drafts ready.', actions: [{ kind: 'create_tasks', tasks: [{ title: 'Breakfast', estimated_minutes: 15 }], target_block_id: 'b1' }], tasks: [], objectives: [], blocks: [{ id: 'b1', title: 'Morning', start_at: '2026-11-23T16:00:00Z', end_at: '2026-11-23T17:00:00Z' }] });
    render(() => <TaskAgent open onClose={vi.fn()} />);
    fireEvent.input(screen.getByLabelText('Message the task assistant'), { target: { value: 'Add breakfast to Morning' } });
    fireEvent.click(screen.getByText('Send'));
    const duration = await screen.findByLabelText('Minutes for draft task 1');
    expect(duration.closest('.overflow-y-auto')).toBeTruthy();
    expect(screen.queryByLabelText('Message the task assistant')).toBeNull();
    const scroll = vi.fn();
    duration.scrollIntoView = scroll;
    fireEvent.focus(duration);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it('can extend a short block before creating and placing approved drafts', async () => {
    plan.mockResolvedValueOnce({ reply: 'Drafts ready.', actions: [{ kind: 'create_tasks', tasks: [{ title: 'Breakfast', estimated_minutes: 30 }, { title: 'Feed cats', estimated_minutes: 30 }], target_block_id: 'b1' }], tasks: [], objectives: [], blocks: [{ id: 'b1', title: 'Morning', start_at: '2026-11-23T16:00:00Z', end_at: '2026-11-23T17:00:00Z' }] });
    render(() => <TaskAgent open onClose={vi.fn()} />);
    fireEvent.input(screen.getByLabelText('Message the task assistant'), { target: { value: 'Add breakfast and feed cats to Morning' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getByText('Extend to fit estimate')).toBeTruthy());
    fireEvent.click(screen.getByText('Extend to fit estimate'));
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(updateBlock).toHaveBeenCalledWith('b1', { end_at: '2026-11-23T17:10:00.000Z' }));
    expect(updateBlock.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it('shows a proposed task edit before saving and applies only on confirmation', async () => {
    const screenContext = () => ({ path: '/balance', tab: 'metrics', selectedTaskId: 't1', selectedBlockId: null, selectedEntity: null, headings: ['Life Balance', 'Metrics'] });
    render(() => <TaskAgent open onClose={vi.fn()} screenContext={screenContext} />);
    fireEvent.input(screen.getByLabelText('Message the task assistant'), { target: { value: 'Move Call Sam to Friday' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getByText(/Review changes/)).toBeTruthy());
    expect(plan).toHaveBeenCalledWith('Move Call Sam to Friday', [], screenContext());
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('t1', { scheduled_for: '2026-11-27' }));
    await waitFor(() => expect(refetchTasks).toHaveBeenCalled());
  });
});
