/**
 * Phase L additions:
 * - Persist `lastEventId` in localStorage so a page reload can pass
 *   `?lastEventId=<cursor>` and the server replays any missed events.
 * - `registerFlushHook`: called by mutations.ts so local ops are server-acked
 *   BEFORE trusting catch-up frames (prevents our own edits arriving as
 *   "remote" changes from another device).
 */

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
 * (stores/updateAvailable.ts) without a separate polling loop.
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

function connect(): void {
  if (es || reconnectTimer !== undefined) return; // already live, or a reconnect is already pending

  // Flush pending ops before opening (or reopening) the stream so our own edits
  // are server-acked and won't arrive as surprising "remote" catch-up frames.
  void flushHook?.();

  // Pass the stored cursor as a query param on initial page load; the browser
  // sends `Last-Event-ID` automatically on mid-session reconnects.
  const url = lastEventId
    ? `/api/events?lastEventId=${encodeURIComponent(lastEventId)}`
    : '/api/events';
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
