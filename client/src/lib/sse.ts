/**
 * Live updates: `on(event, handler)` calls `handler` with the data of each server event.
 *
 * Two transports behind the one API. A browser tab holds an `EventSource` to
 * `/api/events` and the server pushes. The Capacitor app shell cannot (its page is on its
 * own origin, so an `EventSource` carries no session cookie and the server allows no
 * foreign origin), so there it polls `GET /api/sync/changes` instead (lib/live-poll.ts).
 * Subscribers cannot tell the difference, and `onReconnect` means the same in both.
 *
 * Phase L additions:
 * - Persist `lastEventId` in localStorage so a page reload can pass
 *   `?lastEventId=<cursor>` and the server replays any missed events. The poller keeps
 *   its cursor in the same key.
 * - `registerFlushHook`: called by mutations.ts so local ops are server-acked
 *   BEFORE trusting catch-up frames (prevents our own edits arriving as
 *   "remote" changes from another device).
 */

import { api } from './api.js';
import { createPoller, type Poller } from './live-poll.js';
import { apiUrl, isNativeShell, needsServerSetup } from './server-config.js';
import { onWrite } from './write-signal.js';

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const attached = new Set<string>(); // events that have a live EventSource listener

let es: EventSource | null = null;

// ── Cursor persistence ─────────────────────────────────────────────────────────

let lastEventId: string = '';
try { lastEventId = localStorage.getItem('sse-cursor') ?? ''; } catch { /* SSR / no storage */ }

function persistCursor(id: string): void {
  if (!id) return;
  lastEventId = id;
  try { localStorage.setItem('sse-cursor', id); } catch { /* quota / private mode */ }
}

// ── Flush hook ─────────────────────────────────────────────────────────────────

type FlushHook = () => Promise<void> | void;
let flushHook: FlushHook | null = null;

/**
 * Register a callback that is invoked before every (re)connect.
 * mutations.ts passes `flush` here so pending ops are sent to the server
 * before catch-up frames arrive from the stream.
 */
export function registerFlushHook(hook: FlushHook): void {
  flushHook = hook;
}

// ── Reconnect signal ─────────────────────────────────────────────────────────

type ReconnectHandler = () => void;
const reconnectHandlers = new Set<ReconnectHandler>();
// Flips true after the FIRST successful open; only opens after that one are real
// reconnects (a dropped connection coming back), never the initial page-load connect.
let hasConnectedOnce = false;

/**
 * Register a callback fired every time the EventSource re-opens after a drop — NOT
 * on the initial connect. A container restart under an open tab produces exactly one
 * of these, so it's the natural place to notice "the server might be a new build now"
 * (stores/updateAvailable.ts) without a separate polling loop. In the app shell it
 * fires when a poll succeeds after one or more failed.
 */
export function onReconnect(handler: ReconnectHandler): () => void {
  reconnectHandlers.add(handler);
  return () => { reconnectHandlers.delete(handler); };
}

// ── EventSource wiring ─────────────────────────────────────────────────────────

/** Reconnect backoff: 5s doubling to 30s (matches stores/mutations.ts's flush retry). */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 30_000;

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = RECONNECT_BASE_MS;

/**
 * Arm the ONE reconnect timer, doubling the delay each consecutive failure.
 *
 * `connect()` used to fire a bare `setTimeout(connect, 5_000)` with no stored handle
 * and no backoff. Two failures, at scale: a `on(event, handler)` call arriving DURING
 * that 5s gap — a component mounting mid-outage, and this app has dozens of `on()`
 * call sites, so during any real outage that is likely, not hypothetical — passed
 * `connect()`'s only guard (`if (es) return`, false while disconnected) and opened a
 * SECOND EventSource, which itself errored and scheduled its OWN untracked timer;
 * repeat for as long as the outage lasted and `on()` kept firing, and the number of
 * live sockets and pending timers only grows. Separately, a sustained outage hammered
 * the server on a fixed 5s cadence forever, with no backoff at all.
 *
 * `connect()`'s guard now checks this timer too, so a call arriving mid-gap is a
 * clean no-op — the handler is still registered (see `on()`) and gets wired up on
 * whichever `connect()` succeeds, scheduled or not.
 */
function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return; // a reconnect is already armed
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

// Attach exactly one EventSource listener per event type. It dispatches to every
// handler currently in the map, so adding/removing handlers never adds or leaks
// EventSource listeners — the handlers map is the single source of truth.
function attach(event: string): void {
  if (!es || attached.has(event)) return;
  attached.add(event);
  es.addEventListener(event, (e: MessageEvent) => {
    // Keep the cursor up to date on every named event frame.
    if (e.lastEventId) persistCursor(e.lastEventId);
    let data: unknown;
    try { data = JSON.parse(e.data); } catch { data = e.data; }
    handlers.get(event)?.forEach((h) => h(data));
  });
}

// ── Polling (the app shell) ────────────────────────────────────────────────────

let poller: Poller | null = null;

/** The persisted cursor as the number the endpoint takes, or null when there is none (or it is not one). */
function pollCursor(): number | null {
  return /^\d{1,15}$/.test(lastEventId) ? Number(lastEventId) : null;
}

function startPolling(): void {
  if (poller) return;
  poller = createPoller({
    fetchChanges: (since) => api.sync.changes(since ?? undefined),
    getCursor: pollCursor,
    setCursor: (seq) => persistCursor(String(seq)),
    dispatch: (event, data) => handlers.get(event)?.forEach((h) => h(data)),
    // Our own edits reach the server before we ask what changed, as for a (re)connect.
    beforePoll: () => flushHook?.(),
    onRecovered: () => reconnectHandlers.forEach((h) => h()),
    isVisible: () => typeof document === 'undefined' || !document.hidden,
  });

  // The app came back, or the network did: ask now instead of at the next tick. `focus`
  // covers a WebView that resumes without a visibilitychange; the poller's own minimum gap
  // turns two of these in a row into one request.
  const resume = () => poller?.resume();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
  }
  // A write we just made: its server-side effects are worth fetching soon.
  onWrite(() => poller?.nudge());

  poller.start();
}

// ── Connecting ─────────────────────────────────────────────────────────────────

function connect(): void {
  if (es || poller || reconnectTimer !== undefined) return; // already live, or a reconnect is already pending
  // Mobile shell before a server is chosen: there is nothing to stream from. Handlers stay
  // registered; choosing a server reloads the app, which connects for real.
  if (needsServerSetup()) return;

  // The shell polls rather than streams (see the header).
  if (isNativeShell()) {
    startPolling();
    return;
  }

  // Flush pending ops before opening (or reopening) the stream so our own edits
  // are server-acked and won't arrive as surprising "remote" catch-up frames.
  void flushHook?.();

  // Pass the stored cursor as a query param on initial page load; the browser
  // sends `Last-Event-ID` automatically on mid-session reconnects.
  const url = apiUrl(
    lastEventId
      ? `/api/events?lastEventId=${encodeURIComponent(lastEventId)}`
      : '/api/events',
  );
  es = new EventSource(url);

  es.addEventListener('open', () => {
    reconnectDelayMs = RECONNECT_BASE_MS; // connectivity is back — drop the accumulated backoff
    if (hasConnectedOnce) reconnectHandlers.forEach((h) => h());
    hasConnectedOnce = true;
  });

  es.addEventListener('error', () => {
    es?.close();
    es = null;
    attached.clear(); // a fresh EventSource needs its per-event listeners re-attached
    scheduleReconnect();
  });

  // Named events don't fire the generic 'message' handler — attach one per event.
  for (const [event] of handlers) attach(event);
}

export function on(event: string, handler: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  connect();
  attach(event); // ensure a listener exists even if ES was already open
  return () => { handlers.get(event)?.delete(handler); };
}
