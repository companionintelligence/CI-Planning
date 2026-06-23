import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { issueApiKey } from '../src/lib/auth/apiKey.js';
import { SCOPE_READ, SCOPE_WRITE } from '../src/lib/auth/types.js';
import { consume, _resetRateLimit } from '../src/lib/auth/rateLimit.js';
import { startTestServer, type TestServer } from './helpers.js';

/**
 * Phase I (PR3) — auth rate limiting. The limiter must trip BEFORE any signature
 * or hash work, so it blunts (rather than amplifies) a credential-grinding flood.
 */

let srv: TestServer;
const ORIG_MAX = config.auth.rateLimit.max;

beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
afterEach(() => {
  config.auth.mode = 'test';
  config.auth.rateLimit.max = ORIG_MAX;
  _resetRateLimit();
  sqlite.exec('DELETE FROM api_keys');
});

describe('consume — fixed-window core', () => {
  it('allows up to max, then denies with a positive Retry-After', () => {
    _resetRateLimit();
    expect(consume('k', 2, 60_000).ok).toBe(true);
    expect(consume('k', 2, 60_000).ok).toBe(true);
    const third = consume('k', 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it('keys are independent', () => {
    _resetRateLimit();
    expect(consume('a', 1, 60_000).ok).toBe(true);
    expect(consume('a', 1, 60_000).ok).toBe(false);
    expect(consume('b', 1, 60_000).ok).toBe(true); // separate bucket
  });
});

describe('requireAuth — rate limiting', () => {
  it('trips 429 + Retry-After after the cap, ahead of credential handling', async () => {
    config.auth.mode = 'standalone';
    config.auth.rateLimit.max = 3;
    // Credential-free calls normally 401; the limiter counts them all the same.
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${srv.url}/api/tasks`)).status).toBe(401);
    }
    // The (cap+1)th is 429 — proving the limiter runs before the credential check
    // (otherwise this would be another 401).
    const res = await fetch(`${srv.url}/api/tasks`);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('subjects even a valid key to the limit (limiter precedes verify)', async () => {
    config.auth.mode = 'standalone';
    config.auth.rateLimit.max = 2;
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ, SCOPE_WRITE]);
    const h = { headers: { 'x-api-key': key } };
    expect((await fetch(`${srv.url}/api/tasks`, h)).status).toBe(200);
    expect((await fetch(`${srv.url}/api/tasks`, h)).status).toBe(200);
    expect((await fetch(`${srv.url}/api/tasks`, h)).status).toBe(429);
  });

  it('does not rate-limit the allow-listed health probe', async () => {
    config.auth.mode = 'standalone';
    config.auth.rateLimit.max = 1;
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${srv.url}/api/health`)).status).toBe(200);
    }
  });
});
