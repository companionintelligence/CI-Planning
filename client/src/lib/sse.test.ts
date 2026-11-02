import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SERVER_URL_KEY } from './server-config.js';

/**
 * lib/sse.ts's `onReconnect` signal — what stores/updateAvailable.ts hooks to notice
 * a redeploy happened under an open tab. Neither jsdom nor plain node implement
 * EventSource, so this fakes just enough of it (open/error listeners) to drive
 * connect()'s retry loop — the same gap DayStarsRow.test.tsx documents mocking
 * around when it consumes sse.ts instead of testing it directly.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<() => void>>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }
  close(): void {}
  emit(type: string): void {
    this.listeners.get(type)?.forEach((h) => h());
  }
}

describe('sse.ts — onReconnect', () => {
  beforeEach(() => {
    vi.resetModules(); // fresh module singleton (es/hasConnectedOnce/etc.) per test
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires on a reconnect open, never on the initial connect', async () => {
    const { on, onReconnect } = await import('./sse.js');
    const reconnected = vi.fn();
    onReconnect(reconnected);

    on('task', () => {}); // the only way to start a connection
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].emit('open');
    expect(reconnected).not.toHaveBeenCalled();

    // A dropped connection schedules a retry 5s out (sse.ts's error handler).
    FakeEventSource.instances[0].emit('error');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1].emit('open');
    expect(reconnected).toHaveBeenCalledTimes(1);

    // Every open after the first counts as a reconnect, not just the second.
    FakeEventSource.instances[1].emit('error');
    await vi.advanceTimersByTimeAsync(5_000);
    FakeEventSource.instances[2].emit('open');
    expect(reconnected).toHaveBeenCalledTimes(2);
  });

  it('stops firing once unregistered via the returned cleanup', async () => {
    const { on, onReconnect } = await import('./sse.js');
    const reconnected = vi.fn();
    onReconnect(reconnected)(); // register then immediately unregister

    on('task', () => {});
    FakeEventSource.instances[0].emit('error');
    await vi.advanceTimersByTimeAsync(5_000);
    FakeEventSource.instances[1].emit('open');
    expect(reconnected).not.toHaveBeenCalled();
  });
});

/**
 * connect()'s reconnect timer used to be a bare, untracked `setTimeout`. Two
 * consequences, both closed by the fix:
 *
 *  1. Stacking. `on()` calls `connect()` unconditionally; its only guard was "is
 *     there a LIVE EventSource right now", which is false during the whole gap
 *     between an error and the (untracked) timer firing. A NEW `on()` call arriving
 *     in that window — a component mounting mid-outage, and this app has dozens of
 *     `on()` call sites — opened a SECOND EventSource, which itself errored and
 *     scheduled its OWN timer. Under a real, sustained outage with normal navigation
 *     happening, this compounds: more sockets, more pending timers, every one of
 *     them independently retrying.
 *  2. No backoff. A single persistent failure retried on a fixed 5s cadence forever.
 */
describe('sse.ts — reconnect stacking + backoff', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('on() during the reconnect gap does not open a second EventSource', async () => {
    const { on } = await import('./sse.js');

    on('task', () => {});
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0].emit('error'); // schedules the one reconnect timer

    // A DIFFERENT part of the app subscribes to a different event while still
    // disconnected — exactly the scenario that used to open a second socket.
    on('block', () => {});
    expect(FakeEventSource.instances).toHaveLength(1); // still just the one, pending

    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.instances).toHaveLength(2); // the ONE scheduled reconnect fires
  });

  it('repeated on() calls during one gap never arm more than one timer', async () => {
    const { on } = await import('./sse.js');

    on('task', () => {});
    FakeEventSource.instances[0].emit('error');

    for (let i = 0; i < 10; i++) on(`event-${i}`, () => {});
    expect(FakeEventSource.instances).toHaveLength(1); // ten more subscribes, still one pending reconnect

    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeEventSource.instances).toHaveLength(2); // exactly one reconnect happened, not ten
  });

  it('the delay doubles on each consecutive failure', async () => {
    const { on } = await import('./sse.js');
    on('task', () => {});

    FakeEventSource.instances[0].emit('error');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(FakeEventSource.instances).toHaveLength(1); // not yet — base delay is 5s
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2); // 5s elapsed

    FakeEventSource.instances[1].emit('error');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(FakeEventSource.instances).toHaveLength(2); // not yet — doubled to 10s
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    FakeEventSource.instances[2].emit('error');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(FakeEventSource.instances).toHaveLength(3); // not yet — doubled again to 20s
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it('the delay caps at 30s and does not keep doubling forever', async () => {
    const { on } = await import('./sse.js');
    on('task', () => {});

    // Fail enough times in a row to run well past the point the delay would have
    // doubled past the cap if nothing bounded it (5→10→20→30→30…).
    for (let i = 0; i < 5; i++) {
      FakeEventSource.instances[FakeEventSource.instances.length - 1].emit('error');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const countBefore = FakeEventSource.instances.length;
    FakeEventSource.instances[FakeEventSource.instances.length - 1].emit('error');
    await vi.advanceTimersByTimeAsync(30_000); // exactly the cap — must be enough
    expect(FakeEventSource.instances).toHaveLength(countBefore + 1);
  });

  it('a successful open resets the backoff back to the 5s base', async () => {
    const { on } = await import('./sse.js');
    on('task', () => {});

    // Climb the backoff a couple of steps (5s → 10s).
    FakeEventSource.instances[0].emit('error');
    await vi.advanceTimersByTimeAsync(5_000);
    FakeEventSource.instances[1].emit('error');
    await vi.advanceTimersByTimeAsync(10_000);

    // Connectivity returns.
    FakeEventSource.instances[2].emit('open');

    // A later failure retries at the BASE delay again, not a further-doubled one.
    FakeEventSource.instances[2].emit('error');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(FakeEventSource.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(4);
  });
});

/**
 * The app shell cannot hold an EventSource (its page is on another origin, so the stream
 * carries no session cookie and the server allows no foreign origin), so the same `on()`
 * is served by polling `GET /api/sync/changes` there. The poll loop itself is pinned in
 * live-poll.test.ts; what is pinned here is the wiring: which transport each environment
 * gets, where the cursor lives, and that a subscriber cannot tell the difference.
 */
describe('sse.ts — in the app shell', () => {
  const SERVER = 'http://192.168.1.20:3848';

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

  const changes = (cursor: number, events: { seq: number; event: string; data: unknown }[] = [], resync = false) => ({
    events, cursor, resync,
  });

  let answers: unknown[];
  let fetchMock: ReturnType<typeof vi.fn>;
  const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.stubGlobal('localStorage', memoryStorage());
    localStorage.setItem(SERVER_URL_KEY, SERVER);
    answers = [];
    fetchMock = vi.fn(async () => {
      const next = answers.shift() ?? changes(0);
      if (next instanceof Error) throw next;
      if (typeof next === 'number') return { ok: false, status: next, statusText: 'x', json: async () => ({ error: 'x' }) };
      return { ok: true, status: 200, json: async () => next };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('polls the server instead of opening an EventSource, asking for "now" first and then from the cursor', async () => {
    answers.push(changes(40), changes(40));
    const { on } = await import('./sse.js');
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(urls()).toEqual([`${SERVER}/api/sync/changes`]);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(urls()).toEqual([`${SERVER}/api/sync/changes`, `${SERVER}/api/sync/changes?since=40`]);
  });

  it('hands polled events to the subscribers of that event, and keeps the cursor where the stream did', async () => {
    answers.push(
      changes(40),
      changes(43, [
        { seq: 41, event: 'task:updated', data: { id: 'a' } },
        { seq: 42, event: 'block:created', data: { id: 'b' } },
        { seq: 43, event: 'task:updated', data: { id: 'c' } },
      ]),
    );
    const { on } = await import('./sse.js');
    const tasks = vi.fn();
    const blocks = vi.fn();
    on('task:updated', tasks);
    on('block:created', blocks);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(tasks.mock.calls).toEqual([[{ id: 'a' }], [{ id: 'c' }]]);
    expect(blocks.mock.calls).toEqual([[{ id: 'b' }]]);
    expect(localStorage.getItem('sse-cursor')).toBe('43'); // the key lib/server-config.ts clears on a server change
  });

  it('a resync reaches whoever subscribed to sync:resync, as it does from the stream', async () => {
    answers.push(changes(5), changes(9, [], true));
    const { on } = await import('./sse.js');
    const resync = vi.fn();
    on('sync:resync', resync);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(resync).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('sse-cursor')).toBe('9');
  });

  it('carries on from the cursor a previous session left, and treats anything that is not a cursor as none', async () => {
    localStorage.setItem('sse-cursor', '12');
    answers.push(changes(12));
    const { on } = await import('./sse.js');
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([`${SERVER}/api/sync/changes?since=12`]);

    vi.resetModules();
    fetchMock.mockClear();
    localStorage.setItem('sse-cursor', 'not-a-cursor');
    const again = await import('./sse.js');
    again.on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([`${SERVER}/api/sync/changes`]);
  });

  it('runs the registered flush hook before each poll, as it does before a (re)connect', async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push('poll');
      return { ok: true, status: 200, json: async () => changes(1) };
    });
    const { on, registerFlushHook } = await import('./sse.js');
    registerFlushHook(() => void order.push('flush'));
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(order).toEqual(['flush', 'poll', 'flush', 'poll']);
  });

  it('onReconnect fires when a poll works again after failing, never for the first poll', async () => {
    answers.push(changes(1), new Error('offline'), changes(1), changes(1));
    const { on, onReconnect } = await import('./sse.js');
    const reconnected = vi.fn();
    onReconnect(reconnected);
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000); // fails
    await vi.advanceTimersByTimeAsync(15_000); // works again
    expect(reconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it('a write this client made brings the next poll forward', async () => {
    const { on } = await import('./sse.js');
    const { noteWrite } = await import('./write-signal.js');
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    noteWrite();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an older server (404) ends the polling quietly, and the subscribers stay registered', async () => {
    answers.push(404);
    const { on } = await import('./sse.js');
    const handler = vi.fn();
    on('task:updated', handler);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('asks for changes at once when the app is resumed or the network comes back, not at the next tick', async () => {
    const doc = Object.assign(new EventTarget(), { hidden: false });
    const win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    answers.push(changes(40), changes(40), changes(40), changes(40));

    const { on } = await import('./sse.js');
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toHaveLength(1);

    // Each step is well inside the 15 s poll interval, so only the resume can make a request.
    await vi.advanceTimersByTimeAsync(3_000);
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(3_000);
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(3_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toHaveLength(4);
  });

  it('before a server is chosen there is nothing to poll', async () => {
    localStorage.removeItem(SERVER_URL_KEY);
    const { on } = await import('./sse.js');
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('in a browser it is still the EventSource and never a poll', async () => {
    vi.stubGlobal('Capacitor', undefined);
    const { on } = await import('./sse.js');
    on('task:updated', () => {});
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/events');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
