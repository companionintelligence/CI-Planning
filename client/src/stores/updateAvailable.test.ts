import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the callback registered with lib/sse.ts's onReconnect so the test can fire
// it directly — the same seam DayStarsRow.test.tsx documents mocking sse.ts around,
// since neither jsdom nor node implement EventSource.
let capturedHandler: (() => void) | undefined;
vi.mock('../lib/sse.js', () => ({
  onReconnect: (h: () => void) => {
    capturedHandler = h;
    return () => { capturedHandler = undefined; };
  },
}));

const { updateAvailable, dismissUpdateAvailable } = await import('./updateAvailable.js');

function fireReconnect(): void {
  capturedHandler?.();
}

/** checkForUpdate awaits fetch() then res.json() — a few microtask ticks covers both. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('stores/updateAvailable', () => {
  beforeEach(() => {
    dismissUpdateAvailable();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('checks nothing when this bundle carries no baked-in release (local dev)', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', '');
    fireReconnect();
    await flushAsync();
    expect(fetch).not.toHaveBeenCalled();
    expect(updateAvailable()).toBe(false);
  });

  it('stays quiet when the server release matches the bundle', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'ci-planning-client@abc123');
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, release: 'ci-planning-client@abc123' }),
    } as Response);

    fireReconnect();
    await flushAsync();
    expect(updateAvailable()).toBe(false);
  });

  it('flags an update when the server release differs', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'ci-planning-client@abc123');
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, release: 'ci-planning-client@def456' }),
    } as Response);

    fireReconnect();
    await flushAsync();
    expect(updateAvailable()).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({ credentials: 'omit' }));
  });

  it('a health response with no release (an old server) never flags an update', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'ci-planning-client@abc123');
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ ok: true, release: null }) } as Response);

    fireReconnect();
    await flushAsync();
    expect(updateAvailable()).toBe(false);
  });

  it('a network failure right after reconnect is swallowed, not thrown', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'ci-planning-client@abc123');
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));

    expect(() => fireReconnect()).not.toThrow();
    await flushAsync();
    expect(updateAvailable()).toBe(false);
  });

  it('dismiss clears the flag', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'ci-planning-client@abc123');
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, release: 'ci-planning-client@def456' }),
    } as Response);

    fireReconnect();
    await flushAsync();
    expect(updateAvailable()).toBe(true);

    dismissUpdateAvailable();
    expect(updateAvailable()).toBe(false);
  });
});
