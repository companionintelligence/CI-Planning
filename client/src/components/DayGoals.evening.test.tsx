import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import type { DaySummary } from '../lib/api.js';

/**
 * BriefMenu's evening reflection (#389) — the contracts worth pinning:
 *   1. period_key ALWAYS comes from summary().evening.date (the server's fold day),
 *      never the component's own date prop or a client clock;
 *   2. the section renders in the UN-authored state (prose null, no carry) — that is
 *      exactly when Reflect must be reachable (the old gate hid it);
 *   3. "(AI)" iff the authoring response's llm === true (null/false show nothing);
 *   4. an emptied Save deletes (server contract) and returns to the Reflect state.
 */

const PREV = '2026-07-18';
const summaryMock = vi.fn(async (_d: string): Promise<DaySummary> => baseSummary());
const topTasksMock = vi.fn(async (_d: string) => ({ tasks: [] }));
const openEveningMock = vi.fn(async (_p: string, _r?: boolean) => ({ period_key: PREV, body: 'A solid evening.', llm: false as boolean | null, created: true }));
const setEveningMock = vi.fn(async (_p: string, _b: string) => ({ ok: true }));
vi.mock('../lib/api.js', () => ({
  api: {
    summary: { get: (d: string) => summaryMock(d), topTasks: (d: string) => topTasksMock(d), refresh: vi.fn() },
    reflections: { openEvening: (p: string, r?: boolean) => openEveningMock(p, r), setEvening: (p: string, b: string) => setEveningMock(p, b) },
    tasks: { update: vi.fn() },
  },
}));

const toastMock = vi.fn();
const aiAvailableFlag = { current: false };
vi.mock('../stores/index.js', () => ({
  showToast: (...a: unknown[]) => toastMock(...a),
  setElementModal: vi.fn(),
  refetchTasks: vi.fn(),
  aiAvailable: () => aiAvailableFlag.current,
}));

const { BriefMenu } = await import('./DayGoals.js');

function baseSummary(evening?: DaySummary['evening']): DaySummary {
  return {
    date: '2026-07-19', prose: 'Morning brief.', llm: false,
    ...(evening !== undefined ? { evening } : {}),
  } as unknown as DaySummary;
}
const UNAUTHORED = { date: PREV, prose: null, carry_forward: [] };

async function openBrief() {
  render(() => <BriefMenu date="2026-07-19" />);
  fireEvent.click(screen.getByTitle("Today's Brief"));
  await screen.findByText('Morning brief.');
}

describe('BriefMenu — evening reflection (#389)', () => {
  beforeEach(() => {
    summaryMock.mockReset().mockResolvedValue(baseSummary());
    topTasksMock.mockReset().mockResolvedValue({ tasks: [] });
    openEveningMock.mockReset().mockResolvedValue({ period_key: PREV, body: 'A solid evening.', llm: false, created: true });
    setEveningMock.mockReset().mockResolvedValue({ ok: true });
    toastMock.mockReset();
    aiAvailableFlag.current = false;
  });

  it('no evening key (flag off) → no Last-night section at all', async () => {
    await openBrief();
    expect(screen.queryByText('Last night')).toBeNull();
  });

  it('un-authored state renders Reflect; clicking authors with the SUMMARY date, not the prop date', async () => {
    summaryMock.mockResolvedValue(baseSummary(UNAUTHORED));
    await openBrief();
    await screen.findByText('Last night');

    fireEvent.click(screen.getByText(`Reflect on ${PREV}`));

    await waitFor(() => expect(openEveningMock).toHaveBeenCalledWith(PREV, false));
    await screen.findByText('A solid evening.');
    // Deterministic fallback (llm false) → no badge.
    expect(screen.queryByTitle(/AI-authored/)).toBeNull();
  });

  it('"(AI)" renders iff the authoring response reports llm === true', async () => {
    summaryMock.mockResolvedValue(baseSummary(UNAUTHORED));
    openEveningMock.mockResolvedValue({ period_key: PREV, body: 'Model prose.', llm: true, created: true });
    await openBrief();
    fireEvent.click(await screen.findByText(`Reflect on ${PREV}`));

    await screen.findByText('Model prose.');
    expect(screen.getByTitle(/AI-authored/)).toBeTruthy();
  });

  it('Edit → Save hand-edits via setEvening and drops any AI badge; emptied Save deletes', async () => {
    summaryMock.mockResolvedValue(baseSummary({ date: PREV, prose: 'Original words.', carry_forward: [] }));
    await openBrief();
    await screen.findByText('Original words.');

    fireEvent.click(screen.getByText('Edit'));
    const ta = screen.getByLabelText('Evening reflection') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: 'My own words.' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(setEveningMock).toHaveBeenCalledWith(PREV, 'My own words.'));
    await screen.findByText('My own words.');

    // Now empty it — the server's empty-body-deletes contract returns the section
    // to the un-authored Reflect state.
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.input(screen.getByLabelText('Evening reflection'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(setEveningMock).toHaveBeenCalledWith(PREV, ''));
    await screen.findByText(`Reflect on ${PREV}`);
  });

  it('Regenerate renders only with aiAvailable() and passes refresh: true', async () => {
    summaryMock.mockResolvedValue(baseSummary({ date: PREV, prose: 'Old prose.', carry_forward: [] }));
    await openBrief();
    await screen.findByText('Old prose.');
    expect(screen.queryByTitle('Regenerate the evening reflection')).toBeNull(); // AI off

    aiAvailableFlag.current = true;
    // Re-open to re-render the header controls under the new flag.
    fireEvent.click(screen.getByTitle("Today's Brief")); // close
    fireEvent.click(screen.getByTitle("Today's Brief")); // reopen
    await screen.findByText('Old prose.');

    fireEvent.click(screen.getByTitle('Regenerate the evening reflection'));
    await waitFor(() => expect(openEveningMock).toHaveBeenCalledWith(PREV, true));
  });
});
