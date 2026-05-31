type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

let es: EventSource | null = null;

function connect() {
  if (es) return;
  es = new EventSource('/api/events');

  es.addEventListener('error', () => {
    es?.close();
    es = null;
    setTimeout(connect, 5_000);
  });

  // Generic catch-all via message listener (events with named type don't fire 'message')
  for (const [event] of handlers) {
    es.addEventListener(event, (e: MessageEvent) => {
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { data = e.data; }
      handlers.get(event)?.forEach((h) => h(data));
    });
  }
}

export function on(event: string, handler: Handler) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  // If ES already open, add listener directly
  es?.addEventListener(event, (e: MessageEvent) => {
    let data: unknown;
    try { data = JSON.parse(e.data); } catch { data = e.data; }
    handler(data);
  });
  connect();
  return () => handlers.get(event)?.delete(handler);
}
