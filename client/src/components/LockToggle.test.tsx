import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

/**
 * Phase 1 — the one lock affordance. Two behaviours worth locking down at the DOM
 * seam: a native block toggles `is_locked` in both directions (the Planner card used
 * to offer Unlock only, so a block could never be locked from there), and a SYNCED
 * event renders NO control at all — its source line instead (decision 1). A disabled
 * button would read as "broken"; the absence plus the provenance reads as "not yours
 * to move".
 */

const update = vi.fn().mockResolvedValue({});
const refetchBlocks = vi.fn();
const showToast = vi.fn();

vi.mock('../lib/api.js', () => ({ api: { blocks: { update: (...a: unknown[]) => update(...a) } } }));
vi.mock('../stores/index.js', () => ({
  refetchBlocks: (...a: unknown[]) => refetchBlocks(...a),
  showToast: (...a: unknown[]) => showToast(...a),
}));

const { LockToggle } = await import('./LockToggle.js');

beforeEach(() => vi.clearAllMocks());

const block = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  title: 'Deep work',
  block_kind: 'task',
  status: 'planned',
  start_at: '2026-06-22T19:00:00.000Z',
  end_at: '2026-06-22T20:00:00.000Z',
  is_locked: false,
  is_auto: false,
  all_day: false,
  source_provider: null,
  source_account: null,
  ...over,
}) as any;

describe('LockToggle — a block the owner created', () => {
  it('offers Lock when unlocked, and locks on click', async () => {
    const { getByRole } = render(() => <LockToggle block={block()} />);
    const btn = getByRole('button');
    expect(btn.textContent).toContain('Lock');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith('b1', { is_locked: true });
  });

  it('offers Unlock when locked, and unlocks on click', async () => {
    const { getByRole } = render(() => <LockToggle block={block({ is_locked: true })} />);
    const btn = getByRole('button');
    expect(btn.textContent).toContain('Unlock');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith('b1', { is_locked: false });
  });

  it('refetches so every surface sees the new state', async () => {
    const { getByRole } = render(() => <LockToggle block={block()} />);
    fireEvent.click(getByRole('button'));
    await Promise.resolve();
    await Promise.resolve();
    expect(refetchBlocks).toHaveBeenCalled();
  });

  it('surfaces a failure instead of silently doing nothing', async () => {
    update.mockRejectedValueOnce(new Error('nope'));
    const { getByRole } = render(() => <LockToggle block={block()} />);
    fireEvent.click(getByRole('button'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith('nope', 'error');
  });
});

describe('LockToggle — a synced calendar event', () => {
  const synced = block({ is_locked: true, source_provider: 'google', source_account: 'work' });

  it('renders NO control — not even a disabled one', () => {
    const { queryByRole } = render(() => <LockToggle block={synced} />);
    expect(queryByRole('button')).toBeNull();
  });

  it('shows the source in its place, so the immovability is explained', () => {
    const { container } = render(() => <LockToggle block={synced} />);
    expect(container.textContent).toContain('Synced from Google · work');
  });

  it('cannot be unlocked from here — no click path exists to the API', () => {
    const { container } = render(() => <LockToggle block={synced} />);
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(update).not.toHaveBeenCalled();
  });
});
