/**
 * Wall-clock bound for a promise. Lives in its own module (no Sentry import) so it is
 * unit-testable without pulling the SDK into the test process.
 *
 * Why it exists: `Sentry.close(ms)` is NOT a wall-clock bound. Its timeout only limits
 * how long the transport waits for in-flight requests, and it still resolves on a later
 * event-loop turn — so a crash handler sitting behind queued synchronous work can
 * overrun the budget by an arbitrary amount. On an exit path that is the difference
 * between "flush, then die" and "hang". Racing a real timer is what makes the bound
 * real.
 */

/**
 * Resolve when `promise` settles or when `timeoutMs` elapses, whichever is first.
 * Never rejects — a failed flush must not change how the process exits. The timer is
 * `unref`'d so waiting for it can never be the reason the process stays alive.
 */
export function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<void> {
  return Promise.race([
    Promise.resolve(promise).then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      // Node-only; the optional call keeps this harmless anywhere else.
      timer.unref?.();
    }),
  ]);
}
