import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { COMMON } from '../../lib/learning-copy.js';

/**
 * Settings → Learning: one card's read of its endpoint, as three states.
 *
 *   loading  the first read, or a retry, is in flight
 *   ready    the read answered; `data()` holds the response
 *   error    the read failed; `error()` says which kind, in words the owner can act on
 *
 * Why this is not createResource, and why a failure is not null:
 *   - an errored createResource THROWS when it is read, and a card that threw would blank
 *     its neighbours;
 *   - turning a failure into null (as the Triality tiles do) makes "the server could not be
 *     reached" look the same as "nothing has been measured". Here a failed read is never
 *     `ready`, so a card can never show a failure as an empty readout.
 *
 * A late answer is ignored: after a retry, or once the card is gone, only the newest request
 * may change anything. The loader runs once when the card mounts and again only on retry; a
 * clear never calls it, because the readings cannot change before Monday.
 *
 * The error kind is read by duck-typing `.status` (0 means the browser never reached the
 * server, 404 means an older server without the route), so this file never imports ApiError
 * and a component test can mock ../../lib/api.js with only `api`. The raw server text is
 * never exposed: the message is one of the fixed strings in COMMON.
 */

export type ReadoutStatus = 'loading' | 'ready' | 'error';

export interface ReadoutError {
  kind: 'offline' | 'unsupported' | 'failed';
  message: string;
}

export interface Readout<T> {
  data: Accessor<T | undefined>;
  status: Accessor<ReadoutStatus>;
  error: Accessor<ReadoutError | undefined>;
  retry: () => void;
}

function classify(err: unknown): ReadoutError {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (status === 0) return { kind: 'offline', message: COMMON.errorOffline };
  if (status === 404) return { kind: 'unsupported', message: COMMON.errorUnsupported };
  return { kind: 'failed', message: COMMON.errorFailed };
}

export function useReadout<T>(load: () => Promise<T>): Readout<T> {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [status, setStatus] = createSignal<ReadoutStatus>('loading');
  const [error, setError] = createSignal<ReadoutError | undefined>(undefined);

  // Only the newest request may write, and nothing may write once the card is gone.
  let latest = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  function run(): void {
    const mine = ++latest;
    setStatus('loading');
    setError(undefined);
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(load());
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => {
        if (!alive || mine !== latest) return;
        setData(() => value);
        setStatus('ready');
      },
      (err: unknown) => {
        if (!alive || mine !== latest) return;
        setError(classify(err));
        setStatus('error');
      },
    );
  }

  run();

  return { data, status, error, retry: run };
}
