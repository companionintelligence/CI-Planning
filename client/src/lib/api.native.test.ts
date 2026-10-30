import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SERVER_URL_KEY } from './server-config.js';

/**
 * lib/api.ts reads its base ONCE, at import (`const BASE = apiBase()`), so each case
 * stubs the environment first and then imports a fresh copy of the module.
 *
 * What is pinned here is the contract the mobile shell depends on: in a browser every
 * request goes to the relative `/api/...` it always did; in the shell they go to the
 * user's server; and before a server is chosen nothing is sent anywhere at all.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

const fetchMock = vi.fn();

async function loadApi() {
  vi.resetModules();
  return import('./api.js');
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ mode: 'test' }) });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api base', () => {
  it('browser: requests stay same-origin /api/... even if a server URL was left in storage', async () => {
    vi.stubGlobal('Capacitor', undefined);
    localStorage.setItem(SERVER_URL_KEY, 'http://192.168.1.20:3848');
    const { api, CIPORTAL_START } = await loadApi();

    await api.auth.config();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/config');
    expect(CIPORTAL_START).toBe('/api/auth/ciportal/start');
  });

  it('shell with a saved server: requests go to that server', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    localStorage.setItem(SERVER_URL_KEY, 'http://192.168.1.20:3848');
    const { api, CIPORTAL_START } = await loadApi();

    await api.auth.config();

    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.1.20:3848/api/auth/config');
    expect(CIPORTAL_START).toBe('http://192.168.1.20:3848/api/auth/ciportal/start');
  });

  it('shell with no server yet: sends nothing, and fails as "never reached a server"', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    const { api, ApiError } = await loadApi();

    const err = await api.auth.config().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(0); // the op-log treats 0 as retryable
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
