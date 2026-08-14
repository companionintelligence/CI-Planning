import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const [available, setAvailable] = createSignal(false);
const dismissMock = vi.fn(() => setAvailable(false));
vi.mock('../stores/updateAvailable.js', () => ({
  updateAvailable: () => available(),
  dismissUpdateAvailable: () => dismissMock(),
}));

const { UpdateBanner } = await import('./UpdateBanner.js');

/**
 * The flag itself (SSE-reconnect → release mismatch) is covered by
 * stores/updateAvailable.test.ts; this pins only the banner's own contract —
 * hidden by default, shown once flagged, dismiss defers to the store.
 */
describe('UpdateBanner', () => {
  beforeEach(() => {
    setAvailable(false);
    dismissMock.mockClear();
  });

  it('renders nothing when no update is flagged', () => {
    const { container } = render(() => <UpdateBanner />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows Reload + dismiss once an update is flagged', () => {
    setAvailable(true);
    render(() => <UpdateBanner />);
    expect(screen.getByText('Reload')).toBeInTheDocument();
    expect(screen.getByTitle('Dismiss for now')).toBeInTheDocument();
  });

  it('dismiss defers to dismissUpdateAvailable, which hides the banner', () => {
    setAvailable(true);
    render(() => <UpdateBanner />);
    fireEvent.click(screen.getByTitle('Dismiss for now'));
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Reload')).toBeNull();
  });
});
