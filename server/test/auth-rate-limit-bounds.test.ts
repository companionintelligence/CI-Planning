import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config } from '../src/lib/config.js';
import { __resetAuthRateLimit, __authRateLimitSize, __rateLimitedKeyForTest } from '../src/routes/auth.js';

/**
 * The login rate-limiter's bucket map must stay bounded.
 *
 * It used to grow without limit: a bucket was re-inserted on every read even once its
 * whole window had expired, and nothing removed one. The `reset:` axis is keyed on a
 * request-supplied identifier from a PUBLIC endpoint, so a distinct identifier per
 * request minted a permanent entry — 100k requests measured at 100k retained keys, and
 * the 20mb body limit meant the caller chose how many bytes each one cost.
 *
 * These exercise the limiter directly rather than through HTTP: the bounds are about the
 * map, and driving thousands of requests through a test server to observe it would be
 * slow and would prove less.
 */

let saved: typeof config.auth.rateLimit;

beforeEach(() => {
  saved = config.auth.rateLimit;
  config.auth.rateLimit = { windowMs: 60_000, max: 60, issueMax: 5 };
  __resetAuthRateLimit();
});
afterEach(() => {
  config.auth.rateLimit = saved;
  __resetAuthRateLimit();
});

describe('rate-limiter bucket map bounds', () => {
  it('stays under the ceiling across far more distinct keys than the ceiling', () => {
    for (let i = 0; i < 50_000; i++) __rateLimitedKeyForTest(`reset:user-${i}@example.com`);
    // Before the fix this was 50,000.
    expect(__authRateLimitSize()).toBeLessThanOrEqual(4_096);
  });

  it('reclaims buckets whose window has fully expired', async () => {
    // Short window, filled fast enough that every bucket is still LIVE while filling —
    // so the sweep that runs during the loop has nothing to collect and the map really
    // does hold all 1200. Then let them all age out and poke it once more.
    config.auth.rateLimit = { windowMs: 300, max: 60, issueMax: 5 };
    for (let i = 0; i < 1_200; i++) __rateLimitedKeyForTest(`reset:stale-${i}`);
    const beforeExpiry = __authRateLimitSize();
    expect(beforeExpiry).toBeGreaterThan(1_024); // over SWEEP_AT, so the next call sweeps

    await new Promise((r) => setTimeout(r, 400)); // every bucket's window has now closed
    __rateLimitedKeyForTest('reset:trigger');

    // Everything expired is gone; only the key that triggered the sweep remains.
    expect(__authRateLimitSize()).toBeLessThanOrEqual(2);
  });

  it('truncates an over-long key instead of storing it whole', () => {
    const huge = 'reset:' + 'a'.repeat(100_000);
    __rateLimitedKeyForTest(huge);
    expect(__authRateLimitSize()).toBe(1);
    // One bucket, and its key is capped — not the 100kB the caller sent.
    expect(__rateLimitedKeyForTest(huge)).toBe(false); // still under issueMax
  });

  it('still limits: issueMax attempts on one key, then refuses', () => {
    const key = 'ip:198.51.100.7';
    const verdicts = Array.from({ length: 6 }, () => __rateLimitedKeyForTest(key));
    expect(verdicts).toEqual([false, false, false, false, false, true]);
  });

  it('eviction under flood never turns into a lockout for a fresh key', () => {
    for (let i = 0; i < 20_000; i++) __rateLimitedKeyForTest(`reset:flood-${i}`);
    // A legitimate login arriving mid-flood must still be allowed its attempts. Failing
    // closed here would let any stranger lock everyone out of the login form.
    expect(__rateLimitedKeyForTest('ip:203.0.113.9')).toBe(false);
  });
});
