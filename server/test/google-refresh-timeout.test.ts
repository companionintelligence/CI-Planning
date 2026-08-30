import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleCalendarConnector } from '../src/connectors/google.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

/**
 * connectors/google.ts's token REFRESH (`postToken` → `refreshToken`) had no
 * AbortSignal at all — the single most consequential of the seven un-bounded `fetch`
 * calls found in the adversarial review, because `getAccessToken()` (connectors/base.ts)
 * single-flights the refresh across every concurrent caller sharing an owner/account.
 * A hang here doesn't just stall the request that triggered it; every OTHER caller
 * already waiting on that same in-flight promise hangs with it, for as long as the
 * token endpoint stays silent — which, before this fix, was forever.
 *
 * `TestConnector` subclasses the REAL `GoogleCalendarConnector` (not a fake) and adds
 * only a public wrapper around the protected `getAccessToken()` — `refreshToken()` and
 * the `postToken()` it calls are the untouched production implementation, so this
 * exercises the actual `fetch(config.google.tokenUri, ...)` call site, not a stand-in.
 *
 * Follows base-refresh.test.ts's seedTokenRow/KEY idiom exactly (that file covers the
 * single-flight MECHANISM with a fake refreshToken; this one covers the REAL refresh
 * implementation's network bound).
 */

const KEY = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;
const SAVED_TOKEN_URI = config.google.tokenUri;

class TestConnector extends GoogleCalendarConnector {
  public token(): Promise<string> {
    // getAccessToken() is protected on BaseOAuth2Client; this is the same
    // narrow-exposure pattern base-refresh.test.ts's CountingConnector uses.
    return (this as unknown as { getAccessToken(): Promise<string> }).getAccessToken();
  }
}

function seedTokenRow(account: string): void {
  const sealed = seal(
    JSON.stringify({ accessToken: 'stale', refreshToken: 'RT-1', expiresAt: '2000-01-01T00:00:00.000Z' }),
    Buffer.from(KEY, 'base64'),
  );
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 1)`,
    )
    .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext);
}

const listen = (srv: Server) => new Promise<number>((resolve) => {
  srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
});
const close = (srv: Server) => new Promise<void>((resolve) => srv.close(() => resolve()));

beforeEach(() => {
  resetDb();
  process.env.CP_KEK_B64 = KEY;
});
afterEach(() => {
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
  config.google.tokenUri = SAVED_TOKEN_URI;
});

describe('Google token refresh — bounded against a silent endpoint', () => {
  it(
    'a token endpoint that never answers does not hang getAccessToken() forever',
    { timeout: 15_000 },
    async () => {
      // Accepts the connection, then does nothing — no response, no close, no error.
      const blackHole = createServer(() => { /* deliberately silent */ });
      const port = await listen(blackHole);

      try {
        config.google.tokenUri = `http://127.0.0.1:${port}`;
        seedTokenRow('silent-refresh@x.io');
        const c = new TestConnector('silent-refresh@x.io');

        const started = Date.now();
        await expect(
          runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => c.token()),
        ).rejects.toThrow(); // postToken has no domain error class; a raw abort is expected
        const elapsed = Date.now() - started;

        // Bounded by TOKEN_TIMEOUT_MS (10s), not the OS's own multi-minute TCP timeout.
        expect(elapsed).toBeGreaterThan(8_000);
        expect(elapsed).toBeLessThan(13_000);
      } finally {
        await close(blackHole);
      }
    },
  );

  it(
    'concurrent callers sharing the single-flighted refresh are ALL released once it times out',
    { timeout: 15_000 },
    async () => {
      const blackHole = createServer(() => {});
      const port = await listen(blackHole);

      try {
        config.google.tokenUri = `http://127.0.0.1:${port}`;
        seedTokenRow('silent-refresh-2@x.io');
        const c = new TestConnector('silent-refresh-2@x.io');

        // Five concurrent readers on one expired token — connectors/base.ts single-flights
        // these into ONE refreshToken() call. Before the fix, that one call hanging meant
        // ALL FIVE hung with it, with no way out.
        const settled = await runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () =>
          Promise.allSettled([c.token(), c.token(), c.token(), c.token(), c.token()]),
        );
        expect(settled.every((r) => r.status === 'rejected')).toBe(true);
      } finally {
        await close(blackHole);
      }
    },
  );
});
