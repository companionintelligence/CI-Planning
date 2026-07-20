import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';

/**
 * InstructBox (#387) — the preview→confirm contract:
 *   1. submit PARSES only (zero writes); Apply is the sole path to /plan/instruct;
 *   2. Apply reuses the preview's exact (text, date) pair;
 *   3. errors surface the server's own message inline;
 *   4. reportAiUse fires on parse/apply success only — never on availability.
 *
 * SEAMS mocked: `../lib/api.js` (planWeek.parse + plan.instruct) and
 * `../stores/index.js` (aiAvailable box + refetchBlocks/showToast spies).
 */

const PIN = { title: 'Deep work', start_at: '2026-07-21T16:00:00.000Z', end_at: '2026-07-21T19:00:00.000Z' };
const HINT = { kind: 'tag_before', tag: 'writing', time: '12:00' };
const parseMock = vi.fn(async (_t: string, _d?: string) => ({ ok: true, date: '2026-07-21', pins: [PIN], hints: [HINT] }));
const instructMock = vi.fn(async (_t: string, _d?: string) => ({ ok: true, date: '2026-07-21', pins: [PIN], hints: [HINT], created: 1 }));
vi.mock('../lib/api.js', () => ({
  api: {
    planWeek: { parse: (t: string, d?: string) => parseMock(t, d) },
    plan: { instruct: (t: string, d?: string) => instructMock(t, d) },
  },
}));

const toastMock = vi.fn();
const refetchBlocksMock = vi.fn();
const aiAvailableFlag = { current: true };
vi.mock('../stores/index.js', () => ({
  aiAvailable: () => aiAvailableFlag.current,
  refetchBlocks: () => refetchBlocksMock(),
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { InstructBox } = await import('./InstructBox.js');

const appendMock = vi.fn(async (_t: string, _k?: string) => {});
const reportAiUseMock = vi.fn();
const mount = () =>
  render(() => <InstructBox date={() => '2026-07-21'} append={appendMock} reportAiUse={reportAiUseMock} />);

const typeAndEnter = (container: HTMLElement, value: string) => {
  const input = container.querySelector('input')!;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
};

describe('InstructBox — parse preview, explicit apply', () => {
  beforeEach(() => {
    parseMock.mockReset().mockResolvedValue({ ok: true, date: '2026-07-21', pins: [PIN], hints: [HINT] });
    instructMock.mockReset().mockResolvedValue({ ok: true, date: '2026-07-21', pins: [PIN], hints: [HINT], created: 1 });
    appendMock.mockReset();
    reportAiUseMock.mockReset();
    toastMock.mockReset();
    refetchBlocksMock.mockReset();
    aiAvailableFlag.current = true;
  });

  it('submit parses only — no instruct call, preview renders, input keeps its text', async () => {
    const { container } = mount();
    const input = typeAndEnter(container, 'block off Tuesday mornings');

    await waitFor(() => expect(parseMock).toHaveBeenCalledWith('block off Tuesday mornings', '2026-07-21'));
    await screen.findByText(/Pin · Deep work/);
    screen.getByText(/Hint · tag before #writing @ 12:00/);
    expect(instructMock).not.toHaveBeenCalled(); // preview NEVER writes
    expect(input.value).toBe('block off Tuesday mornings'); // survives for editing
    // A successful parse is model usage and lands in the transcript as a preview.
    expect(reportAiUseMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      'Understood "block off Tuesday mornings" → 1 pin(s), 1 hint(s)',
      'plan_week:instruct_preview',
    );
  });

  it('Apply calls instruct with the SAME (text, date) as the preview, appends, refetches, collapses', async () => {
    const { container } = mount();
    typeAndEnter(container, 'block off Tuesday mornings');
    await screen.findByText('Apply');

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(instructMock).toHaveBeenCalledWith('block off Tuesday mornings', '2026-07-21'));
    await waitFor(() =>
      expect(appendMock).toHaveBeenCalledWith('Applied: 1 pin(s), 1 hint(s) (AI)', 'plan_week:instruct_apply'),
    );
    expect(reportAiUseMock).toHaveBeenCalledTimes(2); // parse + apply
    expect(refetchBlocksMock).toHaveBeenCalled(); // pins are real locked blocks
    await waitFor(() => expect(screen.queryByText('Apply')).toBeNull()); // preview collapsed
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it("a rejected parse renders the server's message verbatim — no append, no AI report", async () => {
    parseMock.mockRejectedValue(new Error('Pins overlap: Deep work and Standup'));
    const { container } = mount();
    typeAndEnter(container, 'two overlapping things');

    await screen.findByText('Pins overlap: Deep work and Standup');
    expect(appendMock).not.toHaveBeenCalled();
    expect(reportAiUseMock).not.toHaveBeenCalled();
    expect(instructMock).not.toHaveBeenCalled();
  });

  it('Discard clears the preview without any API call', async () => {
    const { container } = mount();
    typeAndEnter(container, 'block off Tuesday mornings');
    await screen.findByText('Discard');

    fireEvent.click(screen.getByText('Discard'));

    await waitFor(() => expect(screen.queryByText(/Pin · Deep work/)).toBeNull());
    expect(instructMock).not.toHaveBeenCalled();
  });

  it('renders nothing when aiAvailable() is false (parsing needs Ollama)', () => {
    aiAvailableFlag.current = false;
    const { container } = mount();
    expect(container.querySelector('input')).toBeNull();
  });
});
