import { describe, it, expect } from 'vitest';
import {
  scrubBreadcrumbData,
  scrubHeaders,
  scrubString,
  scrubUrl,
  scrubValue,
} from '../src/lib/telemetry/scrub.js';
import {
  BARE_VALUE,
  INNOCUOUS_KEYS,
  keyFilteringCases,
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

/**
 * EVERY key/value walker consults the key.
 *
 * This is the regression pin for the bug the CI-Hermes port found in CI-Server's
 * browser scrubber: its `scrubBreadcrumbData` passed each VALUE to `scrubValue`
 * individually, so the key check never ran and a breadcrumb carrying
 * `data.token = "abc123456"` shipped intact. The Node copy was fine only because it
 * happened to hand over the whole object.
 *
 * `BARE_VALUE` matches no secret pattern, no home path and no URL, so a passing
 * assertion here can only be the key check doing the work — nothing else could redact
 * it. Adding a key to the fixture list covers all three walkers in both packages.
 */
describe('key filtering (server twin) — every walker consults the key', () => {
  const walkers: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {
    scrubValue: (input) => scrubValue(input) as Record<string, unknown>,
    scrubHeaders: (input) => scrubHeaders(input),
    scrubBreadcrumbData: (input) => scrubBreadcrumbData(input),
  };

  it.each(keyFilteringCases())('$walker: $key → filtered=$filtered', ({ walker, key, filtered }) => {
    const result = walkers[walker]!({ [key]: BARE_VALUE })[key];

    expect(result).toBe(filtered ? '[Filtered]' : BARE_VALUE);
  });
});
