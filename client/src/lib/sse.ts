type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const attached = new Set<string>(); // events that have a live EventSource listener

let es: EventSource | null = null;

// Attach exactly one EventSource listener per event type. It dispatches to every
// handler currently in the map, so adding/removing handlers never adds or leaks
// EventSource listeners — the handlers map is the single source of truth.
function attach(event: string) {
  if (!es || attached.has(event)) return;
  attached.add(event);
  es.addEventListener(event, (e: MessageEvent) => {
    let data: unknown;
    try { data = JSON.parse(e.data); } catch { data = e.data; }
    handlers.get(event)?.forEach((h) => h(data));
  });
}

function connect() {
  if (es) return;
  es = new EventSource('/api/events');

  es.addEventListener('error', () => {
    es?.close();
    es = null;
    attached.clear(); // a fresh EventSource needs its per-event listeners re-attached
    setTimeout(connect, 5_000);
  });

  // Named events don't fire the generic 'message' handler — attach one per event.
  for (const [event] of handlers) attach(event);
}

export function on(event: string, handler: Handler) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  connect();
  attach(event); // ensure a listener exists even if ES was already open
  return () => { handlers.get(event)?.delete(handler); };
}
