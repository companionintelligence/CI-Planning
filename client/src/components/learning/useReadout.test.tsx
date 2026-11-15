import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@solidjs/testing-library';
import { createRoot, createSignal } from 'solid-js';
import { COMMON } from '../../lib/learning-copy.js';
import { useReadout, type Readout } from './useReadout.js';

/**
 * useReadout: one card's read, as loading / ready / error.
 *
 * What it must never do:
 *   - report a failed read as ready or as empty (that is how "the server is down" becomes
 *     "nothing has been measured");
 *   - show the raw server text;
 *   - let an old request overwrite a newer one, or write after the card is gone;
 *   - throw when read, which would blank the card's neighbours.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const failure = (status: number | undefined, message = 'raw server text') => Object.assign(new Error(message), { status });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The hook without a DOM, plus the means to unmount it. */
function mountHook<T>(load: () => Promise<T>): { r: Readout<T>; dispose: () => void } {
  let dispose!: () => void;
  const r = createRoot((d) => {
    dispose = d;
    return useReadout(load);
  });
  return { r, dispose };
}

describe('useReadout: reading', () => {
  it('starts loading, then is ready with the data', async () => {
    const d = deferred<{ n: number }>();
    const { r } = mountHook(() => d.promise);
    expect(r.status()).toBe('loading');
    expect(r.data()).toBeUndefined();
    expect(r.error()).toBeUndefined();
    d.resolve({ n: 3 });
    await tick();
    expect(r.status()).toBe('ready');
    expect(r.data()).toEqual({ n: 3 });
    expect(r.error()).toBeUndefined();
  });

  it('calls the loader once on creation and not again by itself', async () => {
    const load = vi.fn(async () => 1);
    mountHook(load);
    await tick();
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not call the loader again when something unrelated re-renders', async () => {
    const load = vi.fn(async () => 'x');
    const [other, setOther] = createSignal(0);
    function Probe() {
      const r = useReadout(load);
      return (
        <div data-testid="probe">
          {r.status()}:{other()}
        </div>
      );
    }
    render(() => <Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready:0'));
    setOther(1);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready:1'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a function-valued answer as data instead of calling it', async () => {
    const fn = () => 'hello';
    const { r } = mountHook(async () => fn);
    await tick();
    expect(r.data()).toBe(fn);
  });

  it('drives the DOM: loading, then ready', async () => {
    const d = deferred<string>();
    function Probe() {
      const r = useReadout(() => d.promise);
      return <div data-testid="probe">{r.status()}</div>;
    }
    render(() => <Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('loading');
    d.resolve('ok');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready'));
  });
});

describe('useReadout: a failure is an error, never ready and never empty', () => {
  it.each([
    [0, 'offline', COMMON.errorOffline],
    [404, 'unsupported', COMMON.errorUnsupported],
    [500, 'failed', COMMON.errorFailed],
    [403, 'failed', COMMON.errorFailed],
    [undefined, 'failed', COMMON.errorFailed],
  ] as const)('status %s is %s', async (status, kind, message) => {
    const { r } = mountHook(() => Promise.reject(failure(status)));
    await tick();
    expect(r.status()).toBe('error');
    expect(r.error()).toEqual({ kind, message });
    expect(r.data()).toBeUndefined();
  });

  it('never exposes the raw server text', async () => {
    const { r } = mountHook(() => Promise.reject(failure(500, 'SQLITE_CORRUPT: database disk image is malformed')));
    await tick();
    expect(JSON.stringify(r.error())).not.toContain('SQLITE');
    expect(r.error()!.message).toBe(COMMON.errorFailed);
  });

  it('survives a rejection that is not an Error at all', async () => {
    for (const reason of [null, undefined, 'a string', 42, {}]) {
      const { r } = mountHook(() => Promise.reject(reason));
      await tick();
      expect(r.status()).toBe('error');
      expect(r.error()!.kind).toBe('failed');
    }
  });

  it('survives a loader that throws before it returns a promise', async () => {
    const { r } = mountHook((): Promise<number> => {
      throw failure(0);
    });
    await tick();
    expect(r.status()).toBe('error');
    expect(r.error()!.kind).toBe('offline');
  });

  it('reading the accessors of a failed read never throws', async () => {
    const { r } = mountHook(() => Promise.reject(failure(500)));
    await tick();
    expect(() => {
      r.data();
      r.status();
      r.error();
    }).not.toThrow();
  });

  it('is never "ready" at any point of a failed read', async () => {
    const seen: string[] = [];
    const d = deferred<number>();
    function Probe() {
      const r = useReadout(() => d.promise);
      // Record every status the component is ever shown.
      return <div data-testid="probe">{(seen.push(r.status()), r.status())}</div>;
    }
    render(() => <Probe />);
    d.reject(failure(500));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('error'));
    expect(seen).not.toContain('ready');
  });
});

describe('useReadout: retry', () => {
  it('calls the loader exactly once more, shows loading until it settles, then the new answer', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { r } = mountHook<string>(load);
    first.reject(failure(500));
    await tick();
    expect(r.status()).toBe('error');

    r.retry();
    expect(load).toHaveBeenCalledTimes(2);
    expect(r.status()).toBe('loading');
    expect(r.error()).toBeUndefined();

    second.resolve('fine');
    await tick();
    expect(r.status()).toBe('ready');
    expect(r.data()).toBe('fine');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a second failure is an error again', async () => {
    const load = vi.fn(() => Promise.reject(failure(0)));
    const { r } = mountHook(load);
    await tick();
    r.retry();
    expect(r.status()).toBe('loading');
    await tick();
    expect(r.status()).toBe('error');
    expect(r.error()!.kind).toBe('offline');
  });

  it('a late answer from the older request does not overwrite the newer one', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { r } = mountHook<string>(load);
    r.retry(); // a second request while the first is still in flight
    newer.resolve('new');
    await tick();
    expect(r.data()).toBe('new');
    expect(r.status()).toBe('ready');

    older.resolve('old');
    await tick();
    expect(r.data()).toBe('new');
    expect(r.status()).toBe('ready');
  });

  it('a late FAILURE from the older request does not turn a newer success into an error', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { r } = mountHook<string>(load);
    r.retry();
    newer.resolve('new');
    await tick();
    older.reject(failure(500));
    await tick();
    expect(r.status()).toBe('ready');
    expect(r.data()).toBe('new');
    expect(r.error()).toBeUndefined();
  });

  it('a late answer from the older request does not end the newer request\'s loading', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { r } = mountHook<string>(load);
    r.retry();
    older.resolve('old');
    await tick();
    expect(r.status()).toBe('loading');
    expect(r.data()).toBeUndefined();
  });
});

describe('useReadout: after the card is gone', () => {
  it('ignores an answer that arrives after unmount', async () => {
    const d = deferred<string>();
    const { r, dispose } = mountHook(() => d.promise);
    dispose();
    d.resolve('too late');
    await tick();
    expect(r.status()).toBe('loading');
    expect(r.data()).toBeUndefined();
  });

  it('ignores a failure that arrives after unmount', async () => {
    const d = deferred<string>();
    const { r, dispose } = mountHook(() => d.promise);
    dispose();
    d.reject(failure(500));
    await tick();
    expect(r.status()).toBe('loading');
    expect(r.error()).toBeUndefined();
  });
});
