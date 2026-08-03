import { describe, it, expect } from 'vitest';
import { scrubString, scrubUrl, scrubValue } from '../src/lib/telemetry/scrub.js';
import {
  INNOCUOUS_KEYS,
  SENSITIVE_KEYS,
  STRING_CASES,
  URL_CASES,
} from '../../client/src/lib/telemetry-fixtures.js';

/**
 * Twin-file parity.
 *
 * `server/src/lib/telemetry/scrub.ts` and `client/src/lib/telemetry-scrub.ts` are
 * deliberate duplicates — they live in separate pnpm packages with different bundlers,
 * so sharing the module would mean a third workspace package for ~100 lines. The cost
 * of that choice is drift, and this is what pays it off: both suites run the SAME
 * fixture set (client/src/lib/telemetry-fixtures.ts) through their own copy, so a rule
 * tightened on one side and forgotten on the other fails here.
 *
 * The client half of this pair lives in client/src/lib/telemetry.test.ts.
 */

describe('scrubString (server twin) matches the shared contract', () => {
  it.each(STRING_CASES)('$name', ({ input, expected, absent }) => {
    const scrubbed = scrubString(input);

    if (expected !== undefined) expect(scrubbed).toBe(expected);
    for (const secret of absent ?? []) expect(scrubbed).not.toContain(secret);
  });
});

describe('scrubUrl (server twin) matches the shared contract', () => {
  it.each(URL_CASES)('$name', ({ input, expected }) => {
    expect(scrubUrl(input)).toBe(expected);
  });
});

describe('scrubValue (server twin) matches the shared contract', () => {
  it.each(SENSITIVE_KEYS)('redacts the %s key wholesale', (key) => {
    expect((scrubValue({ [key]: 'super-secret-value' }) as Record<string, unknown>)[key]).toBe('[Filtered]');
  });

  it.each(INNOCUOUS_KEYS)('keeps the %s key, which carries real signal', (key) => {
    expect((scrubValue({ [key]: 'plain' }) as Record<string, unknown>)[key]).toBe('plain');
  });
});
