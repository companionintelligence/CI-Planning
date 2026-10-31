/**
 * Where the API lives — the one place that knows the difference between the web app and
 * the Capacitor mobile shell (`mobile/`).
 *
 * In a browser (the Docker image, `pnpm dev`) the SPA is served by the same server that
 * answers `/api`, so every request is same-origin and the base is the literal `/api`.
 * Nothing in this module changes that: with no `window.Capacitor` every function below
 * returns the web answer.
 *
 * Inside the shell that stops being true. The bundle is served from the app itself
 * (`capacitor://localhost` on iOS, `https://localhost` on Android), and the user's
 * CI-Planning server is a different origin the app cannot know in advance — it is
 * whatever box the user runs. So the base is the URL they typed on first run, kept in
 * localStorage on their own device. It is never baked into the bundle, and it is
 * user-supplied configuration, not a secret: credentials still go through the normal
 * sign-in flow and are not stored here.
 *
 * The shell is detected through the `window.Capacitor` global the native runtime
 * injects, rather than by importing `@capacitor/core`, so the web bundle gains no
 * dependency and the module stays trivially testable.
 */

import { discardAll } from './oplog.js';

/** localStorage key holding the user's server URL (origin plus optional path prefix). */
export const SERVER_URL_KEY = 'ci-planning.server-url';

/** The SSE replay cursor key (lib/sse.ts) — a cursor is only meaningful to the server that issued it. */
const SSE_CURSOR_KEY = 'sse-cursor';

const PROBE_TIMEOUT_MS = 8_000;

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

/** True only inside the Capacitor iOS/Android shell. False in every browser. */
export function isNativeShell(): boolean {
  try {
    const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Can a flow that sends the page to another site, and expects that site to send the
 * person back with something in the cookie jar, work here?
 *
 * In a browser, yes. In the shell, no: Capacitor cancels a top-level navigation to any
 * host that is not the app's own and opens it in the system browser instead (read in
 * 8.6.0: `WebViewDelegationHandler` on iOS, `Bridge.launchIntent` on Android). The flow
 * then runs in Safari or Chrome, the session cookie is set there, and nothing ever comes
 * back to the app. That is every flow built as "redirect out, redirect back": signing in
 * with Companion Portal, "Connect Google", and the Companion Memory Portal connect.
 */
export function supportsRedirectFlows(): boolean {
  return !isNativeShell();
}

/**
 * Shell only: stop iOS zooming the page in whenever a text field takes focus. WKWebView
 * does that for any field whose text is under 16px, and most of this app's inputs are
 * 14px (`text-sm`); inside a native app it just looks like the layout broke. A viewport
 * `maximum-scale=1` is the switch. Nothing is taken away from the person: the shell
 * already disables pinch-zoom (Capacitor's `zoomEnabled` defaults to false). No-op in a
 * browser, where zooming is a right and the viewport tag stays as written.
 */
export function lockViewportZoom(): void {
  if (!isNativeShell() || typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="viewport"]');
  const content = meta?.getAttribute('content') ?? '';
  if (meta && !/maximum-scale/i.test(content)) {
    meta.setAttribute('content', `${content}, maximum-scale=1`);
  }
}

/** The saved server URL, or null when none has been chosen (or storage is unavailable). */
export function getServerUrl(): string | null {
  try {
    return localStorage.getItem(SERVER_URL_KEY) || null;
  } catch {
    return null;
  }
}

/** True when the shell is running but has not been pointed at a server yet — show the connect screen. */
export function needsServerSetup(): boolean {
  return isNativeShell() && getServerUrl() === null;
}

/**
 * The API base: `/api` on the web (same-origin, as ever), `<server>/api` in the shell.
 * Read once at module load by lib/api.ts. That is deliberate: choosing or changing the
 * server always ends in a full reload (see `connectTo` / `changeServer`), so nothing
 * ever needs to observe the base changing underneath it.
 */
export function apiBase(): string {
  if (!isNativeShell()) return '/api';
  const server = getServerUrl();
  return server ? `${server}/api` : '/api';
}

/**
 * Turn a root-relative app path (`/api/export`) into something a link, `EventSource` or
 * raw `fetch` can use from where the page actually runs. Identity on the web. In the
 * shell a bare `/api/...` would resolve against the app bundle, so it is prefixed with
 * the server URL. Anything that is not a root-relative path is returned untouched.
 */
export function apiUrl(path: string): string {
  if (!isNativeShell() || !path.startsWith('/')) return path;
  const server = getServerUrl();
  return server ? `${server}${path}` : path;
}

/** Hosts a person types without a scheme that are almost certainly on their own network, i.e. plain http. */
function looksLocal(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.lan') ||
    h.endsWith('.home.arpa') ||
    !h.includes('.') || // single-label name (a LAN hostname) or an IPv6 literal
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) // IPv4 literal
  );
}

/**
 * Turn whatever was typed into a canonical server URL, or null if it cannot be one.
 *
 *   192.168.1.20:3848      → http://192.168.1.20:3848   (bare LAN address ⇒ plain http)
 *   planning.example.com   → https://planning.example.com
 *   https://x.y/planning/  → https://x.y/planning       (path prefix kept, trailing slash dropped)
 *
 * Only http(s) is accepted. Query strings and fragments are dropped, and a URL carrying
 * `user:pass@` is refused outright: credentials do not belong in a stored URL.
 */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // No scheme typed. Look at the host the way a URL parser will (strip any path/port).
    const host = raw.replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    candidate = `${looksLocal(host) ? 'http' : 'https'}://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export type ProbeFailure = 'invalid' | 'unreachable' | 'not-planning';
export type ProbeResult = { ok: true; url: string } | { ok: false; reason: ProbeFailure };

/**
 * Check that `input` is a reachable CI-Planning server before it is saved. Both
 * endpoints are public (no session needed): `/api/health` must answer `{ ok: true }`
 * and `/api/auth/config` must carry an auth `mode`, which together tell a Planning
 * server apart from any other web server a mistyped address might hit.
 *
 * The two failures are kept apart because they send the person to different fixes:
 * `unreachable` means nothing answered (or a gateway error did) — check the address,
 * the network, that the server is up; `not-planning` means something answered with
 * the wrong thing — it is the wrong address.
 *
 * `fetchImpl` is injectable for tests; in the shell the default is Capacitor's patched
 * `fetch`, which goes through the native HTTP stack and so is not subject to CORS.
 */
export async function probeServer(
  input: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<ProbeResult> {
  const url = normalizeServerUrl(input);
  if (!url) return { ok: false, reason: 'invalid' };

  type Answer = { down: true } | { down: false; ok: boolean; body: unknown };
  const get = async (path: string): Promise<Answer> => {
    // Promise.race rather than an AbortSignal: the native fetch patch does not honour one.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
    });
    let res: Response;
    try {
      res = await Promise.race([fetchImpl(`${url}${path}`, { credentials: 'omit', cache: 'no-store' }), timeout]);
    } catch {
      return { down: true };
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) return { down: true }; // a gateway/proxy error: the server is not really there
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* an HTML page, an empty body — it answered, but not with Planning's JSON */
    }
    return { down: false, ok: res.ok, body };
  };

  const health = await get('/api/health');
  if (health.down) return { ok: false, reason: 'unreachable' };
  const healthBody = health.body as { ok?: unknown } | null;
  if (!health.ok || typeof healthBody !== 'object' || healthBody === null || healthBody.ok !== true) {
    return { ok: false, reason: 'not-planning' };
  }

  const cfg = await get('/api/auth/config');
  if (cfg.down) return { ok: false, reason: 'unreachable' };
  const cfgBody = cfg.body as { mode?: unknown } | null;
  if (!cfg.ok || typeof cfgBody !== 'object' || cfgBody === null || typeof cfgBody.mode !== 'string') {
    return { ok: false, reason: 'not-planning' };
  }

  return { ok: true, url };
}

/** Save the chosen server and reload so every module re-reads the base (see `apiBase`). */
export function connectTo(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url);
  window.location.replace('/');
}

/**
 * Forget the current server and return to the connect screen.
 *
 * Everything the client persisted *about the old server* goes with it, because it would
 * otherwise be applied to the next one: the op-log holds edits that were made offline
 * and not yet acknowledged — left in place they would be flushed to whatever server is
 * chosen next, creating or overwriting records on a box the user never edited. The SSE
 * cursor is likewise an id from the old server's event stream. Unsynced edits are
 * therefore discarded; the UI says so before calling this.
 */
export async function changeServer(): Promise<void> {
  try {
    await discardAll();
  } catch {
    /* no IndexedDB — nothing was queued */
  }
  try {
    localStorage.removeItem(SSE_CURSOR_KEY);
    localStorage.removeItem(SERVER_URL_KEY);
  } catch {
    /* storage unavailable */
  }
  window.location.replace('/');
}
