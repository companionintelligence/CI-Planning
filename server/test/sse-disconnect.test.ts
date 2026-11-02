/**
 * A client closing the SSE stream is how every stream ends: a reload, a closed tab, a phone
 * that locked, a network change. Koa pipes a stream body into the response with
 * `stream.pipeline`, and when the response is closed underneath it, pipeline reports
 * `ERR_STREAM_PREMATURE_CLOSE`. Koa hands that to `app.emit('error')`, and with no listener
 * its default prints the stack to stderr. So every disconnect wrote a stack trace that
 * looked like a failure and was not one, in the logs people read when something is wrong.
 *
 * The app now owns the `error` listener: it drops that one code and still reports the rest.
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { logger } from '../src/lib/logger.js';
import { __clientCount } from '../src/routes/sse.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `done()` holds, so a test fails with a name for what never happened, not a bare timeout. */
async function waitFor(what: string, done: () => boolean, budgetMs = 10_000): Promise<void> {
  for (let waited = 0; waited < budgetMs && !done(); waited += 10) await sleep(10);
  if (!done()) throw new Error(`gave up waiting for ${what}`);
}

/** Every line anything wrote to the two places an app-level error can surface. */
function spyOnErrorOutput() {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
  return {
    text: () =>
      [...consoleSpy.mock.calls, ...loggerSpy.mock.calls]
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n'),
    restore: () => {
      consoleSpy.mockRestore();
      loggerSpy.mockRestore();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('SSE disconnect', () => {
  it('a client that closes the stream leaves nothing in the error output', async () => {
    resetDb();
    const server = await startTestServer();
    const out = spyOnErrorOutput();
    try {
      const res = await fetch(`${server.url}/api/events`, { headers: { Accept: 'text/event-stream' } });
      const reader = res.body!.getReader();
      // ':ok' is the last thing written before the stream goes quiet, so reading it means
      // the route has registered the client and Koa is piping.
      let seen = '';
      while (!seen.includes(':ok')) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += Buffer.from(value).toString();
      }
      expect(__clientCount()).toBe(1);

      await reader.cancel(); // the client goes away without being told to

      // The route notices on the request's own 'close'; the pipeline's verdict lands a
      // moment later. Wait for the first, then give the second room to arrive.
      for (let i = 0; i < 100 && __clientCount() > 0; i++) await sleep(10);
      expect(__clientCount()).toBe(0);
      await sleep(150);

      // The stack Node prints starts "Error: Premature close"; the code only rides on the error.
      expect(out.text()).not.toMatch(/premature close/i);
    } finally {
      out.restore();
      await server.close();
    }
  });
});

/*
 * However the connection ends, the route has to stop that stream's heartbeat and release the
 * stream. A heartbeat that outlives its client keeps writing to a dead stream for as long as the
 * process runs, and a phone that locks and reconnects leaves one behind every time. Each way a
 * connection can end has a connector below, and the same assertions run against all of them.
 */

/** A live /api/events connection that can be read and then ended. */
interface Connection {
  /** Everything the server has sent on it so far. */
  text: () => string;
  /** End the connection the way this mode does. Safe to call again. */
  drop: () => void;
}

/** The client aborts: the AbortController signal a page hands fetch to stop reading a stream. */
async function connectThenAbort(baseUrl: string): Promise<Connection> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  let seen = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += Buffer.from(value).toString();
    }
  })().catch(() => undefined); // the abort rejects the read that is waiting; that is the point
  return { text: () => seen, drop: () => controller.abort() };
}

/** The socket is destroyed: the transport goes away under the response with nothing said over HTTP, as a dropped network does. */
function connectThenDestroySocket(baseUrl: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let seen = '';
      res.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
      });
      res.on('error', () => undefined); // destroying the socket aborts the response
      resolve({ text: () => seen, drop: () => res.socket.destroy() });
    });
    req.on('error', reject); // a no-op once the promise has settled
  });
}

const DISCONNECTS: [string, (baseUrl: string) => Promise<Connection>][] = [
  ['the client aborts', connectThenAbort],
  ['the socket is destroyed', connectThenDestroySocket],
];

describe('SSE disconnect, however the connection ends', () => {
  let server: TestServer;

  beforeAll(async () => {
    resetDb();
    server = await startTestServer();
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The heartbeat cannot be seen from outside the route. It is the route's only setInterval, so
  // with that pair faked the number of pending timers is the number of live heartbeats. Only the
  // pair is faked: the polling below and the HTTP exchange keep their real timers.
  it.each(DISCONNECTS)('%s: the server stops the heartbeat and releases the stream', async (_mode, connect) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const idle = vi.getTimerCount();
    expect(__clientCount()).toBe(0);

    const conn = await connect(server.url);
    try {
      // ':ok' is the last thing written before the stream goes quiet, so reading it means the
      // route has registered the client and started its heartbeat.
      await waitFor(`':ok' from the server`, () => conn.text().includes(':ok'));
      expect(__clientCount()).toBe(1);
      expect(vi.getTimerCount()).toBe(idle + 1);

      // The pending timer is this stream's heartbeat: run it and the client gets the frame.
      vi.advanceTimersToNextTimer();
      await waitFor(`the heartbeat frame`, () => conn.text().includes(':heartbeat'));

      conn.drop();

      // Two separate leaks, so two checks: a stream still registered for broadcasts, and a
      // heartbeat still ticking at a dead socket.
      await waitFor('the route to release the stream', () => __clientCount() === 0);
      expect(vi.getTimerCount()).toBe(idle);
    } finally {
      conn.drop();
    }
  });
});

describe('app error listener', () => {
  it('drops a premature close but still reports a real error', async () => {
    const app = await buildApp();
    const out = spyOnErrorOutput();
    try {
      app.emit('error', Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
      expect(out.text()).toBe('');

      app.emit('error', new Error('a real fault'));
      expect(out.text()).toMatch(/a real fault/);
    } finally {
      out.restore();
    }
  });
});
