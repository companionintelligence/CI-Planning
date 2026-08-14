// Setup for the jsdom `dom` project only (see vitest.config.ts).
//
// - jest-dom adds DOM matchers (toBeInTheDocument, toHaveTextContent, …) to
//   vitest's `expect`.
// - cleanup() unmounts anything rendered by @solidjs/testing-library after each
//   test so DOM + reactive roots don't leak between cases.
// - the localStorage/sessionStorage fixup below repoints two globals vitest's own
//   jsdom environment leaves pointed at a dead Node stub — see the comment there.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@solidjs/testing-library';

afterEach(() => {
  cleanup();
});

// Node ≥22 ships its own `localStorage`/`sessionStorage` globals — present as real
// properties on `globalThis`, but inert (reading them warns "not available" and
// yields undefined) unless the process is started with `--localstorage-file`, which
// nothing here does. vitest's jsdom environment only copies a name from jsdom's
// window onto `globalThis` when that name does NOT already exist there
// (`getWindowKeys` in vitest's jsdom-environment source) — a rule written before
// Node shipped these two, and neither is in vitest's hardcoded copy-allowlist. Net
// effect: `localStorage` in every jsdom test resolves to Node's dead stub, not
// jsdom's real, working Storage — `localStorage.clear()` throws
// "Cannot read properties of undefined". vitest's jsdom environment itself keeps the
// real JSDOM instance reachable at `globalThis.jsdom` precisely as an escape hatch
// for gaps like this one; repoint the two globals at its real implementation rather
// than hand-rolling a second Storage.
const jsdomInstance = (globalThis as { jsdom?: { window?: Window } }).jsdom;
if (jsdomInstance?.window?.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomInstance.window.localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: jsdomInstance.window.sessionStorage,
    configurable: true,
    writable: true,
  });
}
