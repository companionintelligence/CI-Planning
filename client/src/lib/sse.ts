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

// ── EventSource wiring ─────────────────────────────────────────────────────────

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
  if (es) return;

  // Flush pending ops before opening (or reopening) the stream so our own edits
  // are server-acked and won't arrive as surprising "remote" catch-up frames.
  void flushHook?.();

  // Pass the stored cursor as a query param on initial page load; the browser
  // sends `Last-Event-ID` automatically on mid-session reconnects.
  const url = lastEventId
    ? `/api/events?lastEventId=${encodeURIComponent(lastEventId)}`
    : '/api/events';
  es = new EventSource(url);

  es.addEventListener('error', () => {
    es?.close();
    es = null;
    attached.clear(); // a fresh EventSource needs its per-event listeners re-attached
    setTimeout(connect, 5_000);
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
