/**
 * The desktop shell's network path (`desktop/`). Inside Tauri the page is served from the app
 * itself, so a request to the user's server is cross-origin: a WebView would enforce CORS on it,
 * and a self-hosted server allows no foreign origin by default. So every absolute http(s) request
 * goes through the native HTTP plugin instead, which is not subject to CORS and keeps the session
 * cookie in its own jar. The phone shells need the same thing and get it from Capacitor's native
 * HTTP.
 *
 * Reads are also kept in the local SQLite cache (desktop/src-tauri/src/cache.rs). When a read cannot
 * reach the server, the last answer is returned, marked `x-offline-cache: 1`. Writes are never kept:
 * they go through the offline op-log (lib/oplog.ts), which holds them until the server answers.
 */

import { cacheClear, cacheGet, cachePut } from './desktop-cache.js';
import { isTauriShell } from './tauri-shell.js';

type FetchFn = typeof fetch;

/** Where the app's own pages live inside Tauri. Relative URLs resolve against it. */
const APP_ORIGIN = 'tauri://localhost/';

/**
 * Paths whose answers are never kept or served from the cache. The sync cursor must always be
 * live, and anything about the session must not outlive the session it describes.
 */
const UNCACHED_PREFIXES = ['/api/sync/', '/api/auth/', '/api/health'];

/** What the shell's fetch needs from outside. Injected so the routing can be tested on its own. */
export interface ShellNetwork {
  /** The native HTTP plugin's fetch: what reaches the server. */
  nativeFetch: FetchFn;
  /** The web view's own fetch: what stays with the app's own files. */
  webFetch: FetchFn;
  cache: {
    put(key: string, body: string): Promise<void>;
    get(key: string): Promise<string | null>;
    clear(): Promise<void>;
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/** A 200 JSON answer that the server has not asked us not to keep. */
function isKeepable(response: Response): boolean {
  if (response.status !== 200) return false;
  if ((response.headers.get('cache-control') ?? '').includes('no-store')) return false;
  return (response.headers.get('content-type') ?? '').includes('application/json');
}

export function createShellFetch(network: ShellNetwork): FetchFn {
  return async (input, init) => {
    const url = new URL(requestUrl(input), APP_ORIGIN);
    // The app's own files and relative URLs stay with the web view.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return network.webFetch(input, init);
    }

    if (requestMethod(input, init) !== 'GET') {
      const response = await network.nativeFetch(input, init);
      // A sign-in or a sign-out changes whose data this device may show: forget what was kept.
      if (response.ok && url.pathname.startsWith('/api/auth/')) await network.cache.clear();
      return response;
    }

    const readable = !UNCACHED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
    try {
      const response = await network.nativeFetch(input, init);
      if (!readable || !isKeepable(response)) return response;
      const body = await response.text();
      void network.cache.put(url.href, body);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (readable) {
        const kept = await network.cache.get(url.href);
        if (kept !== null) {
          return new Response(kept, {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-offline-cache': '1' },
          });
        }
      }
      throw error;
    }
  };
}

/**
 * Route the page's fetch through the native plugin. Called once, before the app makes its first
 * request (see main.tsx). Does nothing outside the Tauri shell.
 */
export async function installTauriShell(): Promise<void> {
  if (!isTauriShell()) return;
  const { fetch: nativeFetch } = await import('@tauri-apps/plugin-http');
  const webFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createShellFetch({
    nativeFetch,
    webFetch,
    cache: { put: cachePut, get: cacheGet, clear: cacheClear },
  });
}
