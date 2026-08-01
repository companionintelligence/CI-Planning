import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

/**
 * The repeating-item scope prompt. The contracts that matter are about NOT guessing:
 * the question is asked, cancelling resolves null (so the caller touches nothing), and
 * the destructive "and all following" is never what a default keypress picks.
 */

type Ask = { open: boolean; title: string; verb: 'delete' | 'change'; resolve?: (v: unknown) => void };
const [ask, setAsk] = createSignal<Ask>({ open: false, title: '', verb: 'change' });
const answered: unknown[] = [];

vi.mock('../stores/index.js', () => ({
  recurringScopeAsk: () => ask(),
  answerRecurringScope: (v: unknown) => {
    answered.push(v);
    ask().resolve?.(v);
    setAsk({ open: false, title: '', verb: 'change' });
  },
}));

const { RecurringScopeDialog } = await import('./RecurringScopeDialog.js');

beforeEach(() => {
  answered.length = 0;
  setAsk({ open: false, title: '', verb: 'change' });
});

describe('RecurringScopeDialog', () => {
  it('renders nothing until something asks', () => {
    const { container } = render(() => <RecurringScopeDialog />);
    expect(container.textContent).toBe('');
  });

  it('names the item and offers both scopes', async () => {
    setAsk({ open: true, title: 'Standup', verb: 'delete' });
    render(() => <RecurringScopeDialog />);
    expect(await screen.findByText('Standup')).toBeTruthy();
    expect(screen.getByText('Delete this one only')).toBeTruthy();
    expect(screen.getByText('Delete this and all following')).toBeTruthy();
  });

  it('wording follows the verb — a change is not a delete', async () => {
    setAsk({ open: true, title: 'Standup', verb: 'change' });
    render(() => <RecurringScopeDialog />);
    expect(await screen.findByText('Only this one')).toBeTruthy();
    expect(screen.getByText('This and all following')).toBeTruthy();
    expect(screen.queryByText('Delete this one only')).toBeNull();
  });

  it("resolves 'instance' for the single-occurrence choice", async () => {
    setAsk({ open: true, title: 'Standup', verb: 'delete' });
    render(() => <RecurringScopeDialog />);
    fireEvent.click(await screen.findByText('Delete this one only'));
    await waitFor(() => expect(answered).toEqual(['instance']));
  });

  it("resolves 'following' for the series choice", async () => {
    setAsk({ open: true, title: 'Standup', verb: 'delete' });
    render(() => <RecurringScopeDialog />);
    fireEvent.click(await screen.findByText('Delete this and all following'));
    await waitFor(() => expect(answered).toEqual(['following']));
  });

  it('Cancel resolves null so the caller changes nothing', async () => {
    setAsk({ open: true, title: 'Standup', verb: 'delete' });
    render(() => <RecurringScopeDialog />);
    fireEvent.click(await screen.findByText('Cancel'));
    await waitFor(() => expect(answered).toEqual([null]));
  });

  it('the autofocused default is the SAFE option, not the destructive one', async () => {
    // A stray Enter must never wipe out occurrences the user never looked at.
    setAsk({ open: true, title: 'Standup', verb: 'delete' });
    render(() => <RecurringScopeDialog />);
    const safe = await screen.findByText('Delete this one only');
    expect(safe.hasAttribute('autofocus')).toBe(true);
    expect(screen.getByText('Delete this and all following').hasAttribute('autofocus')).toBe(false);
  });
});
