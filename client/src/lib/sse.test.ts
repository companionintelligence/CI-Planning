import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
