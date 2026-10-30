import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SERVER_URL_KEY,
  apiBase,
  apiUrl,
  changeServer,
  connectTo,
  getServerUrl,
  isNativeShell,
  lockViewportZoom,
  needsServerSetup,
  normalizeServerUrl,
  probeServer,
} from './server-config.js';
import * as oplog from './oplog.js';

/**
 * lib/server-config.ts is the seam between the web app and the Capacitor mobile shell.
 * The property that matters most is the negative one: with no `window.Capacitor` —
 * every browser, including the Docker-served app — nothing here may change a URL.
 * That is asserted first and explicitly, before any native behaviour.
 *
 * Runs in the node `unit` project, so `localStorage`, `window` and the Capacitor global
 * are stubbed by hand.
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

const replace = vi.fn();

function asBrowser() {
  vi.stubGlobal('Capacitor', undefined);
}
function asShell() {
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('window', { location: { replace } });
  replace.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  oplog._setTestStore(null);
});

describe('in a browser (no Capacitor) — the web app is untouched', () => {
  beforeEach(asBrowser);

  it('is not the shell, never asks for a server, and keeps the same-origin base', () => {
    expect(isNativeShell()).toBe(false);
    expect(needsServerSetup()).toBe(false);
    expect(apiBase()).toBe('/api');
  });

  it('leaves every URL exactly as given', () => {
    expect(apiUrl('/api/export')).toBe('/api/export');
    expect(apiUrl('/api/events?lastEventId=abc')).toBe('/api/events?lastEventId=abc');
  });

  it('ignores a stored server URL — a browser is always same-origin', () => {
    localStorage.setItem(SERVER_URL_KEY, 'http://192.168.1.20:3848');
    expect(needsServerSetup()).toBe(false);
    expect(apiBase()).toBe('/api');
    expect(apiUrl('/api/export')).toBe('/api/export');
  });

  it('treats a Capacitor global that says "web" as a browser (Capacitor can run on the web)', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    expect(isNativeShell()).toBe(false);
    expect(apiBase()).toBe('/api');
  });

  it('survives a Capacitor global that throws', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => { throw new Error('boom'); } });
    expect(isNativeShell()).toBe(false);
  });
});

describe('in the Capacitor shell', () => {
  beforeEach(asShell);

  it('asks for a server until one is saved', () => {
    expect(isNativeShell()).toBe(true);
    expect(getServerUrl()).toBeNull();
    expect(needsServerSetup()).toBe(true);
  });

  it('points the API base and root-relative URLs at the saved server', () => {
    localStorage.setItem(SERVER_URL_KEY, 'http://192.168.1.20:3848');
    expect(needsServerSetup()).toBe(false);
    expect(apiBase()).toBe('http://192.168.1.20:3848/api');
    expect(apiUrl('/api/export')).toBe('http://192.168.1.20:3848/api/export');
  });

  it('keeps a reverse-proxy path prefix', () => {
    localStorage.setItem(SERVER_URL_KEY, 'https://hub.example.com/planning');
    expect(apiBase()).toBe('https://hub.example.com/planning/api');
    expect(apiUrl('/api/health')).toBe('https://hub.example.com/planning/api/health');
  });

  it('does not rewrite what is not a root-relative path', () => {
    localStorage.setItem(SERVER_URL_KEY, 'http://192.168.1.20:3848');
    expect(apiUrl('https://elsewhere.example/x')).toBe('https://elsewhere.example/x');
    expect(apiUrl('relative/thing')).toBe('relative/thing');
  });

  it('falls back to the bare base while no server is chosen (the api layer refuses to send)', () => {
    expect(apiBase()).toBe('/api');
    expect(apiUrl('/api/export')).toBe('/api/export');
  });

  it('treats unavailable storage as "no server"', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
    });
    expect(getServerUrl()).toBeNull();
    expect(needsServerSetup()).toBe(true);
  });
});

describe('normalizeServerUrl', () => {
  it.each([
    // explicit scheme is respected
    ['http://192.168.1.20:3848', 'http://192.168.1.20:3848'],
    ['https://planning.example.com', 'https://planning.example.com'],
    ['  https://planning.example.com/  ', 'https://planning.example.com'],
    ['HTTPS://Planning.Example.com', 'https://planning.example.com'],
    // a path prefix is kept, trailing slashes are not
    ['https://hub.example.com/planning/', 'https://hub.example.com/planning'],
    // query and fragment are dropped
    ['https://planning.example.com/?a=1#top', 'https://planning.example.com'],
    // no scheme: LAN-looking hosts get http, everything else https
    ['192.168.1.20:3848', 'http://192.168.1.20:3848'],
    ['100.64.0.7:3848', 'http://100.64.0.7:3848'],
    ['localhost:3848', 'http://localhost:3848'],
    ['planning.local', 'http://planning.local'],
    ['nas:3848', 'http://nas:3848'],
    ['[::1]:3848', 'http://[::1]:3848'],
    ['planning.example.com', 'https://planning.example.com'],
    ['host.tailnet.ts.net:3848/planning', 'https://host.tailnet.ts.net:3848/planning'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['ftp://planning.example.com'],
    ['javascript:alert(1)'],
    ['https://user:secret@planning.example.com'],
    ['https://'],
    ['http://exa mple.com'],
  ])('rejects %j', (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });
});

describe('probeServer', () => {
  const json = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  const planning = (path: string) => {
    if (path.endsWith('/api/health')) return json({ ok: true, release: null });
    if (path.endsWith('/api/auth/config')) return json({ mode: 'sso', portal: false, local: true });
    return json({}, 404);
  };

  it('accepts a Planning server and reports the normalised URL', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => planning(String(url)));
    const result = await probeServer('192.168.1.20:3848', fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, url: 'http://192.168.1.20:3848' });
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://192.168.1.20:3848/api/health',
      'http://192.168.1.20:3848/api/auth/config',
    ]);
  });

  it('sends no credentials with the probe', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => planning(String(url)));
    await probeServer('http://x.local', fetchImpl as unknown as typeof fetch);

    for (const [, init] of fetchImpl.mock.calls) {
      expect((init as RequestInit).credentials).toBe('omit');
    }
  });

  it('reports "invalid" without touching the network', async () => {
    const fetchImpl = vi.fn();
    expect(await probeServer('not a url ::', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports "unreachable" when the request throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Load failed'); });
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports "unreachable" on a gateway error (the proxy is up, the server is not)', async () => {
    const fetchImpl = vi.fn(async () => json({}, 502));
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports "unreachable" when the server never answers', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
      const pending = probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await pending).toEqual({ ok: false, reason: 'unreachable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports "not-planning" when health is JSON but not the Planning shape', async () => {
    const fetchImpl = vi.fn(async () => json({ status: 'up' }));
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'not-planning' });
  });

  it('reports "not-planning" when the page is HTML rather than JSON (some other web server)', async () => {
    const html = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
    const fetchImpl = vi.fn(async () => html);
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'not-planning' });
  });

  it('reports "not-planning" on a 404 (a server with no such route)', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'not found' }, 404));
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'not-planning' });
  });

  it('reports "not-planning" when auth config has no mode', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/api/health') ? json({ ok: true }) : json({ hello: 'world' }),
    );
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'not-planning' });
  });

  it('reports "not-planning" when auth config is missing', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/api/health') ? json({ ok: true }) : json({}, 404),
    );
    expect(await probeServer('http://10.0.0.9:3848', fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: 'not-planning' });
  });
});

describe('connectTo', () => {
  it('saves the server and reloads into the app', () => {
    connectTo('http://192.168.1.20:3848');
    expect(localStorage.getItem(SERVER_URL_KEY)).toBe('http://192.168.1.20:3848');
    expect(replace).toHaveBeenCalledWith('/');
  });
});

describe('changeServer', () => {
  it('forgets the server and the old server\'s SSE cursor, and reloads', async () => {
    localStorage.setItem(SERVER_URL_KEY, 'http://192.168.1.20:3848');
    localStorage.setItem('sse-cursor', 'evt-42');
    localStorage.setItem('vite-ui-theme', 'light'); // unrelated preference — must survive

    await changeServer();

    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
    expect(localStorage.getItem('sse-cursor')).toBeNull();
    expect(localStorage.getItem('vite-ui-theme')).toBe('light');
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('discards queued offline edits so they cannot be flushed to the next server', async () => {
    const rows = new Map<string, oplog.Op>();
    oplog._setTestStore({
      put: async (op) => void rows.set(op.opId, op),
      getAll: async () => [...rows.values()],
      delete: async (id) => void rows.delete(id),
    });
    await oplog.enqueue({ opId: 'op-1', entity: 'task', entityId: 't1', fields: { title: 'x' }, baseVersion: 0, clientTs: '2026-10-29T00:00:00Z' });
    expect(await oplog.pending()).toHaveLength(1);

    await changeServer();

    expect(await oplog.pending()).toHaveLength(0);
  });
});

describe('lockViewportZoom', () => {
  /** A viewport <meta> reduced to what the function touches. */
  function stubViewport(content: string | null) {
    const meta = { content, getAttribute: () => meta.content, setAttribute: (_: string, v: string) => { meta.content = v; } };
    vi.stubGlobal('document', { querySelector: (sel: string) => (sel === 'meta[name="viewport"]' ? meta : null) });
    return meta;
  }

  it('adds maximum-scale=1 in the shell, once', () => {
    asShell();
    const meta = stubViewport('width=device-width, initial-scale=1.0');
    lockViewportZoom();
    expect(meta.content).toBe('width=device-width, initial-scale=1.0, maximum-scale=1');
    lockViewportZoom(); // idempotent
    expect(meta.content).toBe('width=device-width, initial-scale=1.0, maximum-scale=1');
  });

  it('leaves the tag alone if it already states a maximum-scale', () => {
    asShell();
    const meta = stubViewport('width=device-width, maximum-scale=3');
    lockViewportZoom();
    expect(meta.content).toBe('width=device-width, maximum-scale=3');
  });

  it('does nothing in a browser — zoom stays a right there', () => {
    asBrowser();
    const meta = stubViewport('width=device-width, initial-scale=1.0');
    lockViewportZoom();
    expect(meta.content).toBe('width=device-width, initial-scale=1.0');
  });

  it('survives a page with no viewport tag', () => {
    asShell();
    vi.stubGlobal('document', { querySelector: () => null });
    expect(() => lockViewportZoom()).not.toThrow();
  });
});
