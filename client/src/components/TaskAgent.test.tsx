import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';

const plan = vi.fn();
const place = vi.fn();
const update = vi.fn();
const refetchTasks = vi.fn();
vi.mock('../lib/api.js', () => ({ api: {
  taskAgent: { plan: (...args: unknown[]) => plan(...args), place: (...args: unknown[]) => place(...args) },
  tasks: { create: vi.fn(), update: (...args: unknown[]) => update(...args) },
  objectives: { moveTask: vi.fn(), linkTask: vi.fn() },
} }));
vi.mock('../stores/index.js', () => ({ refetchTasks: (...args: unknown[]) => refetchTasks(...args), refetchObjectives: vi.fn() }));
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
    render(() => <TaskAgent onClose={vi.fn()} />);
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
    render(() => <TaskAgent onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Open keyboard for voice dictation'));
    const input = screen.getByLabelText('Message the task assistant') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: 'Review this dictated request' } });
    expect(input.value).toBe('Review this dictated request');
    expect(plan).not.toHaveBeenCalled();
  });

  it('shows a proposed task edit before saving and applies only on confirmation', async () => {
    const screenContext = () => ({ path: '/balance', tab: 'metrics', selectedTaskId: 't1', selectedBlockId: null, selectedEntity: null, headings: ['Life Balance', 'Metrics'] });
    render(() => <TaskAgent onClose={vi.fn()} screenContext={screenContext} />);
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
