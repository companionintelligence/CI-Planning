import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPoller,
  BEFORE_POLL_TIMEOUT_MS,
  MIN_POLL_GAP_MS,
  NUDGE_DELAY_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_BACKOFF_MS,
  REQUEST_TIMEOUT_MS,
  type PollerOptions,
} from './live-poll.js';
import type { SyncChanges } from './api.js';

/**
 * lib/live-poll.ts is the loop that stands in for the SSE stream in the app shell. Timers
 * are faked, and the network is a queue of answers the test hands it, so every case below
 * is about when it asks, what it does with the answer, and when it stops asking.
 */

const ev = (seq: number, event: string, data: unknown = { id: `e${seq}` }) => ({ seq, event, data });
const ok = (cursor: number, events: SyncChanges['events'] = [], resync = false): SyncChanges => ({ events, cursor, resync });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

type Answer = SyncChanges | Error | 'hang';

function rig(overrides: Partial<PollerOptions> = {}) {
  let cursor: number | null = null;
  const dispatched: [string, unknown][] = [];
  const startedAt: number[] = [];
  const answers: Answer[] = [];

  const fetchChanges = vi.fn(async (_since: number | null): Promise<SyncChanges> => {
    startedAt.push(Date.now());
    const next = answers.shift() ?? ok(cursor ?? 0);
    if (next === 'hang') return new Promise<never>(() => {});
    if (next instanceof Error) throw next;
    return next;
  });

  const poller = createPoller({
    fetchChanges,
    getCursor: () => cursor,
    setCursor: (seq) => {
      cursor = seq;
    },
    dispatch: (event, data) => {
      dispatched.push([event, data]);
    },
    ...overrides,
  });

  return {
    poller,
    fetchChanges,
    dispatched,
    answers,
    startedAt,
    cursor: () => cursor,
    /** Seconds between each poll and the one before it, as the loop saw them. */
    gaps: () => startedAt.slice(1).map((t, i) => t - startedAt[i]!),
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('what it asks, and what it does with the answer', () => {
  it('asks where "now" is first, with no cursor, and keeps the cursor it is given', async () => {
    const r = rig();
    r.answers.push(ok(40));
    r.poller.start();
    await tick(0);

    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
    expect(r.fetchChanges).toHaveBeenLastCalledWith(null);
    expect(r.cursor()).toBe(40);
    expect(r.dispatched).toEqual([]);

    await tick(POLL_INTERVAL_MS);
    expect(r.fetchChanges).toHaveBeenLastCalledWith(40);
  });

  it('delivers each event to its subscriber, in order, moving the cursor as it goes', async () => {
    const cursors: number[] = [];
    const r = rig({ setCursor: (seq) => void cursors.push(seq) });
    r.answers.push(ok(10), ok(13, [ev(11, 'task:updated'), ev(12, 'block:created'), ev(13, 'task:updated')]));
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS);

    expect(r.dispatched.map(([e]) => e)).toEqual(['task:updated', 'block:created', 'task:updated']);
    expect(r.dispatched[1]).toEqual(['block:created', { id: 'e12' }]);
    // 10 from the first answer; then each delivered event moves it, and the answer's own cursor lands last.
    expect(cursors).toEqual([10, 11, 12, 13, 13]);
  });

  it('announces a resync before anything else, and adopts the cursor even if it went down', async () => {
    const r = rig();
    r.answers.push(ok(900), ok(5, [], true)); // a server that was reset sits below the client's cursor
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS);

    expect(r.dispatched).toEqual([['sync:resync', {}]]);
    expect(r.cursor()).toBe(5);
  });

  it('a subscriber that throws costs the rest of the answer nothing', async () => {
    const delivered: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = rig({
      dispatch: (event) => {
        if (event === 'bad') throw new Error('boom');
        delivered.push(event);
      },
    });
    r.answers.push(ok(1), ok(4, [ev(2, 'good-1'), ev(3, 'bad'), ev(4, 'good-2')]));
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS);

    expect(delivered).toEqual(['good-1', 'good-2']);
    expect(r.cursor()).toBe(4);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('when it asks', () => {
  it('polls on the interval', async () => {
    const r = rig();
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS * 3);
    expect(r.gaps()).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it('never has two in the air: asking mid-poll earns one more when it lands', async () => {
    let release!: (v: SyncChanges) => void;
    const slow = new Promise<SyncChanges>((res) => {
      release = res;
    });
    const r = rig();
    r.fetchChanges.mockImplementationOnce(async () => {
      r.startedAt.push(Date.now());
      return slow;
    });
    r.poller.start();
    await tick(0);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      r.poller.nudge();
      r.poller.resume();
    }
    await tick(10_000);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1); // still the one

    release(ok(1));
    await tick(NUDGE_DELAY_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2); // the one more, sooner than the interval
    await tick(NUDGE_DELAY_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2); // and only one
  });

  it('is quiet in the background and asks straight away when the app is back', async () => {
    let visible = false;
    const r = rig({ isVisible: () => visible });
    r.poller.start();
    await tick(POLL_INTERVAL_MS * 4);
    expect(r.fetchChanges).not.toHaveBeenCalled();

    r.poller.resume(); // the network came back while still hidden: still nothing
    await tick(0);
    expect(r.fetchChanges).not.toHaveBeenCalled();

    visible = true;
    r.poller.resume();
    await tick(0);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
    await tick(POLL_INTERVAL_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
  });

  it('a nudge polls soon, and a burst of them is one poll', async () => {
    const r = rig();
    r.poller.start();
    await tick(0);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 10; i++) r.poller.nudge();
    await tick(NUDGE_DELAY_MS - 1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
    await tick(NUDGE_DELAY_MS * 2);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2); // the burst did not queue more
  });

  it('a nudge never pushes back a poll that is already nearer', async () => {
    const r = rig();
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS - 200); // the next tick is 200ms away
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);

    r.poller.nudge(); // would be 1500ms out
    await tick(200);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
  });

  it('after a nudge poll, the interval starts over from it', async () => {
    const r = rig();
    r.poller.start();
    await tick(0);
    await tick(5_000);
    r.poller.nudge();
    await tick(NUDGE_DELAY_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
    await tick(POLL_INTERVAL_MS - 1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(3);
  });

  it('two resumes in a row, and a resume right after a poll, stay a second apart', async () => {
    const r = rig();
    r.poller.start();
    await tick(0); // a poll starts now
    r.poller.resume();
    r.poller.resume();
    await tick(MIN_POLL_GAP_MS - 1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
    expect(r.gaps()[0]).toBeGreaterThanOrEqual(MIN_POLL_GAP_MS);
  });

  it('waits for the op-log before asking, and asks anyway if it is stuck', async () => {
    const order: string[] = [];
    let drained = false;
    const r = rig({
      beforePoll: async () => {
        order.push('drain-start');
        await new Promise((res) => setTimeout(res, 100));
        drained = true;
        order.push('drain-done');
      },
    });
    r.fetchChanges.mockImplementationOnce(async () => {
      order.push(drained ? 'fetch-after-drain' : 'fetch-before-drain');
      return ok(1);
    });
    r.poller.start();
    await tick(200);
    expect(order).toEqual(['drain-start', 'drain-done', 'fetch-after-drain']);

    const stuck = rig({ beforePoll: () => new Promise<void>(() => {}) });
    stuck.poller.start();
    await tick(BEFORE_POLL_TIMEOUT_MS - 1);
    expect(stuck.fetchChanges).not.toHaveBeenCalled();
    await tick(1);
    expect(stuck.fetchChanges).toHaveBeenCalledTimes(1);

    const failing = rig({ beforePoll: () => Promise.reject(new Error('drain failed')) });
    failing.poller.start();
    await tick(0);
    expect(failing.fetchChanges).toHaveBeenCalledTimes(1);
  });
});

describe('when something goes wrong', () => {
  it('backs off 15s, 30s, 60s, 60s, and starts over after one success', async () => {
    const r = rig();
    r.answers.push(new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), ok(1));
    r.poller.start();
    await tick(0);
    await tick(15_000 + 30_000 + 60_000 + 60_000);
    await tick(POLL_INTERVAL_MS * 2);

    expect(r.gaps()).toEqual([15_000, 30_000, POLL_MAX_BACKOFF_MS, POLL_MAX_BACKOFF_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(POLL_MAX_BACKOFF_MS).toBe(60_000);
  });

  it('reports a recovery once, after a failure, and never for the first success', async () => {
    const onRecovered = vi.fn();
    const r = rig({ onRecovered });
    r.answers.push(ok(1), ok(1), httpError(502), httpError(503), ok(1), ok(1));
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS); // second success: still not a recovery
    expect(onRecovered).not.toHaveBeenCalled();

    await tick(POLL_INTERVAL_MS); // 502
    await tick(15_000); // 503
    await tick(30_000); // ok: recovered
    expect(onRecovered).toHaveBeenCalledTimes(1);
    await tick(POLL_INTERVAL_MS); // ok again: not another one
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('a nudge during a backoff still polls soon: a write that landed means the server is back', async () => {
    const r = rig();
    r.answers.push(new Error('offline'), new Error('offline'));
    r.poller.start();
    await tick(0); // fails; next try in 15s
    await tick(15_000); // fails again; next try in 30s
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);

    r.poller.nudge();
    await tick(NUDGE_DELAY_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(3);
  });

  it('a request that never answers is abandoned, counted as a failure, and the loop carries on', async () => {
    const r = rig();
    r.answers.push('hang', ok(7));
    r.poller.start();
    await tick(REQUEST_TIMEOUT_MS - 1);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
    await tick(1); // timed out: failure 1, so 15s
    await tick(15_000);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
    expect(r.cursor()).toBe(7);
  });

  it.each([404, 405])('a %i means the server predates the endpoint: stop for good', async (status) => {
    const r = rig();
    r.answers.push(httpError(status));
    r.poller.start();
    await tick(0);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);

    r.poller.resume();
    r.poller.nudge();
    await tick(POLL_MAX_BACKOFF_MS * 3);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('a %i means nobody is signed in: stop until the app is resumed', async (status) => {
    const r = rig();
    r.answers.push(httpError(status), ok(3));
    r.poller.start();
    await tick(0);
    await tick(POLL_MAX_BACKOFF_MS * 3);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1); // not retried on a timer

    r.poller.nudge(); // a write cannot have succeeded; nothing to poll for
    await tick(NUDGE_DELAY_MS * 2);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);

    r.poller.resume();
    await tick(0);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
    expect(r.cursor()).toBe(3);
    await tick(POLL_INTERVAL_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(3); // and it is polling again
  });

  it('after stop() nothing more is asked, and an answer still in the air is ignored', async () => {
    let release!: (v: SyncChanges) => void;
    const r = rig();
    r.fetchChanges.mockImplementationOnce(
      () =>
        new Promise<SyncChanges>((res) => {
          release = res;
        }),
    );
    r.poller.start();
    await tick(0);
    r.poller.stop();
    release(ok(9, [ev(9, 'task:updated')]));
    await tick(POLL_INTERVAL_MS * 3);

    expect(r.fetchChanges).toHaveBeenCalledTimes(1);
    expect(r.dispatched).toEqual([]);
    expect(r.cursor()).toBeNull();
  });

  it('a restart while a poll is still in the air does not start a second one', async () => {
    let release!: (v: SyncChanges) => void;
    const r = rig();
    r.fetchChanges.mockImplementationOnce(
      () =>
        new Promise<SyncChanges>((res) => {
          release = res;
        }),
    );
    r.poller.start();
    await tick(0);
    r.poller.stop();
    r.poller.start();
    await tick(MIN_POLL_GAP_MS * 2);
    expect(r.fetchChanges).toHaveBeenCalledTimes(1);

    release(ok(1));
    await tick(NUDGE_DELAY_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2); // the restart's poll, once the first has landed
  });

  it('start() twice is one loop', async () => {
    const r = rig();
    r.poller.start();
    r.poller.start();
    await tick(0);
    await tick(POLL_INTERVAL_MS);
    expect(r.fetchChanges).toHaveBeenCalledTimes(2);
  });
});
