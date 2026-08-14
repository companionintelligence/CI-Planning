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
