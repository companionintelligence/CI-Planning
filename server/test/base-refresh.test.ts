import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { BaseOAuth2Client } from '../src/connectors/base.js';
import type { RemoteEvent, RemoteEventInput, ListEventsResult } from '../src/connectors/base.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

const KEY = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

/** A connector that counts refreshToken calls and hands back a fresh, far-future token. */
class CountingConnector extends BaseOAuth2Client {
  readonly provider = 'google';
  readonly account: string;
  refreshCalls = 0;

  constructor(account: string) {
    super();
    this.account = account;
  }

  // Expose the protected accessor for the test.
  public token(): Promise<string> {
    return this.getAccessToken();
  }

  protected async refreshToken(): Promise<{ accessToken: string; expiresAt: string }> {
    this.refreshCalls++;
    // Yield so concurrent callers all reach the single-flight gate before this resolves.
    await new Promise((r) => setTimeout(r, 5));
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    return { accessToken: `access-${this.refreshCalls}`, expiresAt };
  }

  async listEvents(): Promise<ListEventsResult> {
    throw new Error('unused');
  }
  async createEvent(_i: RemoteEventInput): Promise<RemoteEvent> {
    throw new Error('unused');
  }
  async updateEvent(): Promise<RemoteEvent> {
    throw new Error('unused');
  }
  async deleteEvent(): Promise<void> {
    throw new Error('unused');
  }
}

function seedTokenRow(account: string, expiresAt: string) {
  const sealed = seal(JSON.stringify({ accessToken: 'stale', refreshToken: 'RT-1', expiresAt }), Buffer.from(KEY, 'base64'));
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 1)`,
    )
    .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext);
}

describe('BaseOAuth2Client — refresh single-flight', () => {
  beforeEach(() => {
    resetDb();
    process.env.CP_KEK_B64 = KEY;
  });
  afterEach(() => {
    if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
    else process.env.CP_KEK_B64 = SAVED_KEK;
  });

  it('coalesces N concurrent expired-token reads into ONE refresh', async () => {
    seedTokenRow('sf@x.io', '2000-01-01T00:00:00.000Z'); // expired
    const c = new CountingConnector('sf@x.io');

    const results = await runWithOwner(SYSTEM_OWNER, () =>
      Promise.all([c.token(), c.token(), c.token(), c.token(), c.token()]),
    );

    expect(c.refreshCalls).toBe(1);
    // All callers got the same refreshed access token.
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('access-1');
  });

  it('refreshes again on a later, separate expiry', async () => {
    seedTokenRow('sf2@x.io', '2000-01-01T00:00:00.000Z');
    const c = new CountingConnector('sf2@x.io');

    await runWithOwner(SYSTEM_OWNER, () => c.token());
    expect(c.refreshCalls).toBe(1);

    // Force the stored token expired again, then read once more → a fresh refresh.
    const expired = seal(JSON.stringify({ accessToken: 'access-1', refreshToken: 'RT-1', expiresAt: '2000-01-01T00:00:00.000Z' }), Buffer.from(KEY, 'base64'));
    sqlite
      .prepare(`UPDATE connection_tokens SET iv = ?, auth_tag = ?, ciphertext = ? WHERE account = 'sf2@x.io'`)
      .run(expired.iv, expired.authTag, expired.ciphertext);

    await runWithOwner(SYSTEM_OWNER, () => c.token());
    expect(c.refreshCalls).toBe(2);
  });

  it('does not refresh a still-valid token', async () => {
    seedTokenRow('sf3@x.io', new Date(Date.now() + 3600_000).toISOString());
    const c = new CountingConnector('sf3@x.io');
    const tok = await runWithOwner(SYSTEM_OWNER, () => c.token());
    expect(c.refreshCalls).toBe(0);
    expect(tok).toBe('stale'); // the seeded access token, unrefreshed
  });
});

describe('BaseOAuth2Client.mergeRefreshToken', () => {
  it('returns incoming when present', () => {
    expect(BaseOAuth2Client.mergeRefreshToken('old', 'new')).toBe('new');
  });
  it('keeps existing when incoming is empty', () => {
    expect(BaseOAuth2Client.mergeRefreshToken('old', '')).toBe('old');
    expect(BaseOAuth2Client.mergeRefreshToken('old', undefined)).toBe('old');
    expect(BaseOAuth2Client.mergeRefreshToken('old', null)).toBe('old');
  });
  it('throws when both are empty (never persist an empty refresh token)', () => {
    expect(() => BaseOAuth2Client.mergeRefreshToken('', '')).toThrow(/empty refresh token/);
    expect(() => BaseOAuth2Client.mergeRefreshToken(null, undefined)).toThrow(/empty refresh token/);
  });
});
