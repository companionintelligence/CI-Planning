import { createSignal } from 'solid-js';

/**
 * Whether there is a signed-in session. The SessionGate (App.tsx) sets it from
 * GET /api/auth/me while the shell is mounted, and clears it when the shell unmounts.
 *
 * The account-data resources in stores/index.ts are created at import time, before any
 * gate has run. Each of them waits on this signal: before sign-in every one of them
 * would be refused with a 401, and in the Capacitor shell, before a server is chosen,
 * there is nothing to ask at all. A resource that has errored is rethrown to whichever
 * reader touches it next, and that is how the 'unauthenticated' and 'No server selected'
 * rejections reached the console on every cold start.
 */
export const [signedIn, setSignedIn] = createSignal(false);

/** A createResource source that yields `source()` only once a session exists; until then
 *  it is `false`, which tells Solid not to fetch. */
export const whenSignedIn = <T>(source: () => T): (() => T | false) => () => signedIn() && source();
