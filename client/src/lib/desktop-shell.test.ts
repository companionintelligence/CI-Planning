import { describe, it, expect, vi, afterEach } from 'vitest';
import * as plugin from '@tauri-apps/plugin-http';
import { createShellFetch, installTauriShell, type ShellNetwork } from './desktop-shell.js';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })),
}));

/**
 * The desktop shell's fetch routing. The native plugin, the web view's fetch and the cache are
 * all stubbed, so this runs in the node `unit` project and checks only the decisions: what goes
 * native, what is kept, what is served when the server cannot be reached, and what forgets.
 */

const SERVER = 'https://planning.example.com';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function unreachable(): Promise<Response> {
  return Promise.reject(new TypeError('network down'));
}

function harness(opts: { native?: () => Promise<Response>; kept?: string | null } = {}) {
  const nativeFetch = vi.fn(opts.native ?? (async () => json([])));
  const webFetch = vi.fn(async () => new Response('the app'));
  const cache = {
    put: vi.fn(async (_key: string, _body: string) => {}),
    get: vi.fn(async (_key: string) => opts.kept ?? null),
    clear: vi.fn(async () => {}),
  };
  const network: ShellNetwork = { nativeFetch, webFetch, cache };
  return { fetch: createShellFetch(network), nativeFetch, webFetch, cache };
}

describe('reads from the server', () => {
  it('go through the native plugin, and the answer is kept for later', async () => {
    const h = harness({ native: async () => json([{ id: 1 }]) });
    const response = await h.fetch(`${SERVER}/api/tasks`);
    expect(h.nativeFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('[{"id":1}]');
    expect(h.cache.put).toHaveBeenCalledWith(`${SERVER}/api/tasks`, '[{"id":1}]');
  });

  it('keep the query string in the key, so two queries never share an answer', async () => {
    const h = harness({ native: async () => json([]) });
    await h.fetch(`${SERVER}/api/tasks?day=2026-11-01`);
    expect(h.cache.put).toHaveBeenCalledWith(`${SERVER}/api/tasks?day=2026-11-01`, '[]');
  });

  it('serve the kept answer, marked as offline, when the server cannot be reached', async () => {
    const h = harness({ native: unreachable, kept: '[{"id":1}]' });
    const response = await h.fetch(`${SERVER}/api/tasks`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-offline-cache')).toBe('1');
    expect(await response.text()).toBe('[{"id":1}]');
  });

  it('fail when the server cannot be reached and nothing was kept', async () => {
    const h = harness({ native: unreachable });
    await expect(h.fetch(`${SERVER}/api/tasks`)).rejects.toThrow('network down');
  });

  it('keep only a 200 JSON answer that the server has not marked no-store', async () => {
    const html = harness({
      native: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    });
    await html.fetch(`${SERVER}/api/tasks`);
    expect(html.cache.put).not.toHaveBeenCalled();

    const priv = harness({
      native: async () =>
        json(
          { secret: 1 },
          { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
        ),
    });
    await priv.fetch(`${SERVER}/api/me`);
    expect(priv.cache.put).not.toHaveBeenCalled();
  });

  it('pass an error answer through unchanged, and keep nothing', async () => {
    const h = harness({ native: async () => json({ error: 'nope' }, { status: 404 }) });
    const response = await h.fetch(`${SERVER}/api/tasks/9`);
    expect(response.status).toBe(404);
    expect(h.cache.put).not.toHaveBeenCalled();
  });

  it('never keep or serve the sync cursor', async () => {
    const live = harness({ native: async () => json({ events: [] }) });
    await live.fetch(`${SERVER}/api/sync/changes?since=10`);
    expect(live.cache.put).not.toHaveBeenCalled();

    const offline = harness({ native: unreachable, kept: 'stale' });
    await expect(offline.fetch(`${SERVER}/api/sync/changes?since=10`)).rejects.toThrow('network down');
    expect(offline.cache.get).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('go through the native plugin, and are never kept', async () => {
    const h = harness({ native: async () => json({ id: 2 }, { status: 201 }) });
    const response = await h.fetch(`${SERVER}/api/tasks`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(201);
    expect(h.cache.put).not.toHaveBeenCalled();
    expect(h.cache.clear).not.toHaveBeenCalled();
  });

  it('clear the cache on a successful sign-in or sign-out, and on nothing else', async () => {
    const ok = harness({ native: async () => json({ ok: true }) });
    await ok.fetch(`${SERVER}/api/auth/local/login`, { method: 'POST', body: '{}' });
    expect(ok.cache.clear).toHaveBeenCalledTimes(1);

    const refused = harness({ native: async () => json({ error: 'bad password' }, { status: 401 }) });
    await refused.fetch(`${SERVER}/api/auth/local/login`, { method: 'POST', body: '{}' });
    expect(refused.cache.clear).not.toHaveBeenCalled();
  });
});

describe("the app's own files", () => {
  it('stay with the web view: app URLs and relative paths never reach the native plugin', async () => {
    const h = harness();
    await h.fetch('tauri://localhost/assets/index.js');
    await h.fetch('/theme-init.js');
    expect(h.webFetch).toHaveBeenCalledTimes(2);
    expect(h.nativeFetch).not.toHaveBeenCalled();
  });
});

describe('installing the shell', () => {
  const tauri = globalThis as { __TAURI_INTERNALS__?: unknown };
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
    delete tauri.__TAURI_INTERNALS__;
  });

  it('is in place as soon as it returns, so the first request already goes through it', () => {
    tauri.__TAURI_INTERNALS__ = {};
    installTauriShell();
    expect(globalThis.fetch).not.toBe(original);
  });

  it('sends the first request to the server through the native plugin', async () => {
    tauri.__TAURI_INTERNALS__ = {};
    vi.mocked(plugin.fetch).mockClear();
    installTauriShell();
    const response = await globalThis.fetch(`${SERVER}/api/tasks`);
    expect(response.status).toBe(200);
    expect(plugin.fetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the Tauri shell', () => {
    installTauriShell();
    expect(globalThis.fetch).toBe(original);
  });
});
