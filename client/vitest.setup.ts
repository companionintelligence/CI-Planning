// Setup for the jsdom `dom` project only (see vitest.config.ts).
//
// - jest-dom adds DOM matchers (toBeInTheDocument, toHaveTextContent, …) to
//   vitest's `expect`.
// - cleanup() unmounts anything rendered by @solidjs/testing-library after each
//   test so DOM + reactive roots don't leak between cases.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@solidjs/testing-library';

afterEach(() => {
  cleanup();
});
