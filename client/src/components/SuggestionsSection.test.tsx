import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * SuggestionsSection — the email review queue. Its whole reason to exist is that these
 * items must NOT become tasks on their own, so the contracts under test are:
 *   1. it renders one row per pending suggestion, and nothing at all when empty;
 *   2. Add calls the explicit promote endpoint; Dismiss calls dismiss;
 *   3. a failed write puts the row BACK — a suggestion must never vanish silently.
 *
 * SEAMS mocked: `../lib/api.js` and `../stores/index.js`, mirroring PlanWeekFill.test.tsx.
 */

const promoteMock = vi.fn(async (_id: string, _b?: unknown) => ({ task: { id: 't1' } }));
const dismissMock = vi.fn(async (_id: string) => ({ ok: true }));
const refetchTasksMock = vi.fn();
const refetchSuggestionsMock = vi.fn();
const toastMock = vi.fn();

const [items, setItems] = createSignal<unknown[]>([]);
// Mirrors the real shared busy-set (stores/index.ts) — the drawer's SuggestionPanel
// and this list read/write the SAME set, so a suggestion open in both places can't
// be promoted/dismissed twice at once.
const [busyIds, setBusyIds] = createSignal<Set<string>>(new Set());

vi.mock('../lib/api.js', () => ({
  api: {
    possibles: {
      promote: (id: string, b?: unknown) => promoteMock(id, b),
      dismiss: (id: string) => dismissMock(id),
    },
  },
}));

vi.mock('../stores/index.js', () => ({
  suggestions: () => items(),
  mutateSuggestions: (v: unknown[]) => setItems(v),
  refetchSuggestions: () => refetchSuggestionsMock(),
  refetchTasks: () => refetchTasksMock(),
  showToast: (m: string, k?: string) => toastMock(m, k),
  isSuggestionBusy: (id: string) => busyIds().has(id),
  setSuggestionBusy: (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    }),
}));

const { SuggestionsSection } = await import('./SuggestionsSection.js');

function suggestion(id: string, title: string) {
  return { id, raw_title: title, raw_summary: 'from an email', status: 'pending', created_at: '2026-08-01T00:00:00Z' };
}

beforeEach(() => {
  vi.clearAllMocks();
  setItems([]);
  setBusyIds(new Set<string>());
});

describe('SuggestionsSection', () => {
  it('renders nothing when the queue is empty — invisible at zero cost', () => {
    const { container } = render(() => <SuggestionsSection />);
    expect(container.textContent).toBe('');
  });

  it('renders one row per suggestion, with a count', async () => {
    setItems([suggestion('p1', 'Reply to the vendor'), suggestion('p2', 'Book the venue')]);
    render(() => <SuggestionsSection />);
    expect(await screen.findByText('Reply to the vendor')).toBeTruthy();
    expect(screen.getByText('Book the venue')).toBeTruthy();
    expect(screen.getByText('Suggested from email')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('Add promotes via the explicit endpoint and removes the row', async () => {
    setItems([suggestion('p1', 'Reply to the vendor')]);
    render(() => <SuggestionsSection />);
    fireEvent.click(await screen.findByTitle('Add this as a task'));
    // Called with the id and no overrides — approving takes the suggestion as-is.
    await waitFor(() => expect(promoteMock.mock.calls[0]?.[0]).toBe('p1'));
    expect(refetchTasksMock).toHaveBeenCalled();
    await waitFor(() => expect(items()).toHaveLength(0));
  });

  it('Dismiss calls dismiss and never promotes', async () => {
    setItems([suggestion('p1', 'Reply to the vendor')]);
    render(() => <SuggestionsSection />);
    fireEvent.click(await screen.findByTitle('Dismiss this suggestion'));
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('p1'));
    expect(promoteMock).not.toHaveBeenCalled();
    await waitFor(() => expect(items()).toHaveLength(0));
  });

  it('restores the row when the write fails — a suggestion must not vanish silently', async () => {
    promoteMock.mockRejectedValueOnce(new Error('network down'));
    setItems([suggestion('p1', 'Reply to the vendor')]);
    render(() => <SuggestionsSection />);
    fireEvent.click(await screen.findByTitle('Add this as a task'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('network down', 'error'));
    expect(items()).toHaveLength(1);
  });
});
