// Setup for the jsdom `dom` project only (see vitest.config.ts).
//
// - jest-dom adds DOM matchers (toBeInTheDocument, toHaveTextContent, …) to
//   vitest's `expect`.
// - cleanup() unmounts anything rendered by @solidjs/testing-library after each
//   test so DOM + reactive roots don't leak between cases.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@solidjs/testing-library';

// GOTCHA 4 — Web Storage is missing under jsdom on Node ≥ 23.
//
// vitest's jsdom environment copies the jsdom window's properties onto
// `globalThis`, but it SKIPS every name the Node global object already owns.
// Node now owns `localStorage`/`sessionStorage` itself (its Web Storage API),
// and without `--localstorage-file` those read as `undefined` and warn. So the
// jsdom implementations never get copied across, and the Node ones are inert:
// `globalThis.localStorage` ends up undefined.
//
// On the version this repo pins (.nvmrc 26.3.0) that failed 56 tests across
// TrialityBanner (dismissal key) and OnboardingWizard (FTUE resume key) with
// "Cannot read properties of undefined (reading 'clear')". The suite passed on
// Node 22, which is the only reason CI (node-version: '22') stayed green — and
// nothing ran the client suite anyway.
//
// Note `window === globalThis` here: vitest populates one object and aliases
// `window` to it, so reading through `window` is not a way around this.
// jsdom's own `Storage` is not constructible from user code, so install a
// minimal spec-shaped implementation instead. The app only ever calls
// getItem/setItem/removeItem (tests add clear), but `length`/`key` are cheap
// and keep the object honest to the interface it claims to be.
function createStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(String(k)) ?? null,
    // Web Storage coerces both halves to strings; tests that round-trip a
    // number would otherwise pass here and fail in a browser.
    setItem: (k: string, v: string) => void map.set(String(k), String(v)),
    removeItem: (k: string) => void map.delete(String(k)),
    clear: () => map.clear(),
  } as Storage;
}

for (const key of ['localStorage', 'sessionStorage'] as const) {
  // Guarded: on a Node/vitest combination that does populate these, leave the
  // real one alone rather than shadowing it with a second, divergent store.
  if (globalThis[key] === undefined) {
    const storage = createStorage();
    Object.defineProperty(globalThis, key, { configurable: true, get: () => storage });
  }
}

afterEach(() => {
  cleanup();
});
