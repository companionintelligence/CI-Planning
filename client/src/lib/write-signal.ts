/**
 * "This client just changed something on the server."
 *
 * lib/api.ts raises it after every request the server accepted that was not a read;
 * lib/sse.ts listens, in the app shell only, to poll for the effects (blocks placed, a
 * streak counted) a moment later instead of at the next tick. A leaf module so neither
 * has to import the other, and with nobody listening, as in every browser, it does nothing.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe. Returns the unsubscribe. */
export function onWrite(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteWrite(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener's bug is not the request's failure */
    }
  }
}
