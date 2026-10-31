/**
 * Live updates by polling, for the Capacitor app shell.
 *
 * A browser tab holds an `EventSource` to `/api/events` (lib/sse.ts) and the server pushes
 * each change down it. The shell cannot: it is served from its own origin
 * (`capacitor://localhost`, `https://localhost`), so an `EventSource` there carries no
 * session cookie and the server allows no foreign origin. Requests made with `fetch`, on the
 * other hand, go through the native HTTP stack with the cookie jar, which is why everything
 * else in the shell works. So the shell asks instead of being told: `GET /api/sync/changes`
 * returns the same `sync_events` rows the stream would have pushed, from a cursor.
 *
 * This module is the loop and nothing else; it knows no URLs, storage or DOM, which is what
 * lets it be tested with fake timers. lib/sse.ts wires it to the real ones.
 *
 * What the loop does:
 *  - Polls every {@link POLL_INTERVAL_MS} while the app is visible, and not at all while it
 *    is hidden. `resume()` (the app came back, the network came back) polls straight away.
 *  - `nudge()` polls soon, for after the user's own write, whose server-side effects (blocks
 *    placed, a streak counted) otherwise show up only at the next tick.
 *  - Never overlaps: a poll in flight turns another request into "once more when it ends".
 *    The native `fetch` ignores an `AbortSignal`, so a request that never answers is
 *    abandoned after {@link REQUEST_TIMEOUT_MS} instead; otherwise one lost packet would wedge
 *    the loop for good.
 *  - Backs off on failure (15s, 30s, then 60s) and resets on the first success. The first
 *    success after a failure is reported as a recovery, the polling twin of an `EventSource`
 *    reopening.
 *  - Gives up quietly where retrying cannot help: `404`/`405` means the server predates the
 *    endpoint (stop for good, which is where live updates were before it existed), and
 *    `401`/`403` means nobody is signed in (stop until the next `resume()`).
 */

import type { SyncChanges } from './api.js';

export const POLL_INTERVAL_MS = 15_000;
export const POLL_MAX_BACKOFF_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 20_000;
/** How long to wait for the op-log to drain before polling regardless. */
export const BEFORE_POLL_TIMEOUT_MS = 5_000;
/** After a nudge: long enough for the server to finish what the write set off. */
export const NUDGE_DELAY_MS = 1_500;
/** No two polls start closer than this, whatever asks for them. */
export const MIN_POLL_GAP_MS = 1_000;

export interface PollerOptions {
  /** `since` is null until a cursor exists; the answer to that is where to start from. */
  fetchChanges: (since: number | null) => Promise<SyncChanges>;
  getCursor: () => number | null;
  setCursor: (seq: number) => void;
  /** Hand one event to whoever subscribed to it. */
  dispatch: (event: string, data: unknown) => void;
  /** Run before each poll, so the user's own edits reach the server first and do not come back as someone else's. */
  beforePoll?: () => Promise<void> | void;
  /** A poll worked after one or more had failed. */
  onRecovered?: () => void;
  /** False while the app is in the background. Default: always visible. */
  isVisible?: () => boolean;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** The app is back (foreground, online): poll now, and wake a poller that paused on 401. */
  resume(): void;
  /** The user wrote something: poll soon. */
  nudge(): void;
}

/** Reject after `ms`. The loser of the race is dropped, which is the only cancellation `fetch` offers in the shell. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createPoller(opts: PollerOptions): Poller {
  const isVisible = opts.isVisible ?? (() => true);

  let started = false;
  /** Stopped for good: the server has no such endpoint. */
  let unsupported = false;
  /** Waiting for a `resume()`: hidden, or not signed in. */
  let idle = false;
  let inFlight = false;
  /** A poll was asked for while one was in flight. */
  let again = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  let lastStartedAt = -Infinity;

  /**
   * Arm the one timer. Keeps whichever is sooner: a nudge must not push back a tick that
   * is nearly due, and a tick must not push back a nudge. Never earlier than
   * {@link MIN_POLL_GAP_MS} after the last poll started.
   */
  function schedule(ms: number): void {
    if (!started || unsupported) return;
    const now = Date.now();
    const at = Math.max(now + ms, lastStartedAt + MIN_POLL_GAP_MS);
    if (timer !== undefined && at >= dueAt) return;
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, Math.max(0, at - now));
  }

  /** Deliver one answer: the resync marker first, then each event, advancing the cursor as it goes. */
  function apply(res: SyncChanges): void {
    const deliver = (event: string, data: unknown): void => {
      // A subscriber that throws must not take the rest of the answer, or the cursor, with it.
      try {
        opts.dispatch(event, data);
      } catch (err) {
        console.error(`live update handler for "${event}" failed`, err);
      }
    };
    if (res.resync) deliver('sync:resync', {});
    for (const ev of res.events) {
      deliver(ev.event, ev.data);
      opts.setCursor(ev.seq);
    }
    opts.setCursor(res.cursor);
  }

  async function run(): Promise<void> {
    if (!started || unsupported) return;
    if (!isVisible()) {
      idle = true; // resume() re-arms it
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    again = false;
    lastStartedAt = Date.now();

    let nextMs = POLL_INTERVAL_MS;
    try {
      try {
        await withTimeout(Promise.resolve(opts.beforePoll?.()), BEFORE_POLL_TIMEOUT_MS);
      } catch {
        /* a failed or slow drain is the op-log's own retry to worry about; poll anyway */
      }
      const res = await withTimeout(opts.fetchChanges(opts.getCursor()), REQUEST_TIMEOUT_MS);
      if (!started) return; // stopped while it was in the air
      apply(res);
      if (failures > 0) {
        failures = 0;
        opts.onRecovered?.();
      }
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 404 || status === 405) {
        unsupported = true; // an older server: nothing to poll
        return;
      }
      if (status === 401 || status === 403) {
        idle = true; // not signed in; resume() tries again
        return;
      }
      failures++;
      nextMs = Math.min(POLL_INTERVAL_MS * 2 ** (failures - 1), POLL_MAX_BACKOFF_MS);
    } finally {
      inFlight = false;
    }
    // A nudge that arrived mid-poll earns one more soon, but never inside a backoff.
    schedule(again && failures === 0 ? Math.min(nextMs, NUDGE_DELAY_MS) : nextMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule(0);
    },
    stop() {
      started = false;
      clearTimeout(timer);
      timer = undefined;
    },
    resume() {
      if (!started || unsupported) return;
      idle = false;
      if (inFlight) {
        again = true;
        return;
      }
      schedule(0);
    },
    nudge() {
      if (!started || unsupported || idle) return;
      if (inFlight) {
        again = true;
        return;
      }
      schedule(NUDGE_DELAY_MS);
    },
  };
}
