import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { open, loadKek } from '../src/lib/crypto/index.js';
import { provisionOwner } from '../src/lib/owners.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { memoryConnectorScopes } from '../src/routes/memory.js';
import {
  storeMemoryOidcConnection,
  resolveLiveMemoryCreds,
  memoryCreds,
  MemoryUnavailable,
  MEMORY_PROVIDER,
} from '../src/connectors/memory.js';

/**
 * Phase AA · AA0b — CI-Portal SSO bearer for the memory connector.
 *
 * Two halves:
 *  1. The connector's OIDC refresh path (storeMemoryOidcConnection → resolveLiveMemoryCreds):
 *     stored-token pass-through when fresh, single-flighted refresh when expiring,
 *     rotation-safety, and MemoryUnavailable on a dead refresh token.
 *  2. The routes: /start scope (offline_access) + gating, and the public /callback
 *     (token exchange → refresh-token requirement → id_token verify → subject binding
 *     → KEK-sealed oidc connection + memory_account stamp), against a stubbed portal.
 */

const PORTAL = {
  clientId: 'companion-planning-test',
  issuer: 'https://portal.test',
  authorizeUri: 'https://portal.test/authorize',
  tokenUri: 'https://portal.test/token',
  jwksUri: 'https://portal.test/jwks',
};
const CI_SERVER = 'https://memory.ci.test';
const KEY_B64 = randomBytes(32).toString('base64');

const realFetch = globalThis.fetch.bind(globalThis);

const SAVED_ENV = { kek: process.env.CP_KEK_B64, url: process.env.CI_SERVER_URL, mode: process.env.MEMORY_MODE };

beforeAll(() => {
  process.env.CP_KEK_B64 = KEY_B64;
  delete process.env.MEMORY_MODE;
});
afterAll(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('CP_KEK_B64', SAVED_ENV.kek);
  restore('CI_SERVER_URL', SAVED_ENV.url);
  restore('MEMORY_MODE', SAVED_ENV.mode);
});

// ── 1. connector OIDC refresh ────────────────────────────────────────────────────
describe('connector OIDC refresh (resolveLiveMemoryCreds)', () => {
  const OWNER = SYSTEM_OWNER;
  const base = {
    url: CI_SERVER,
    refreshToken: 'refresh-1',
    tokenEndpoint: PORTAL.tokenUri,
    clientId: PORTAL.clientId,
  };
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  const past = () => new Date(Date.now() - 1_000).toISOString();

  beforeEach(() => resetDb());
  afterEach(() => vi.unstubAllGlobals());

  it('memoryCreds exposes the stored access token as the bearer with authKind=oidc (no network)', () => {
    storeMemoryOidcConnection(OWNER, { ...base, accessToken: 'stored-tok', expiresAt: future() });
    expect(memoryCreds(OWNER)).toEqual({ url: CI_SERVER, bearer: 'stored-tok', source: 'settings', authKind: 'oidc' });
  });

  it('returns the stored token WITHOUT refreshing while it is still fresh', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    storeMemoryOidcConnection(OWNER, { ...base, accessToken: 'fresh-tok', expiresAt: future() });
    const creds = await resolveLiveMemoryCreds(OWNER);
    expect(creds).toEqual({ url: CI_SERVER, bearer: 'fresh-tok' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token, persists it, and is rotation-safe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'new-tok', refresh_token: 'refresh-2', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    storeMemoryOidcConnection(OWNER, { ...base, accessToken: 'old-tok', expiresAt: past() });
    const creds = await resolveLiveMemoryCreds(OWNER);
    expect(creds).toEqual({ url: CI_SERVER, bearer: 'new-tok' });
    // The new access token + rotated refresh token are persisted and now-fresh.
    expect(memoryCreds(OWNER)?.bearer).toBe('new-tok');
    const next = await resolveLiveMemoryCreds(OWNER); // no refresh — the new expiry is future
    expect(next?.bearer).toBe('new-tok');
  });

  it('keeps the existing refresh token when the provider omits a new one', async () => {
    // Provider never returns a refresh_token — the ORIGINAL must survive the refresh.
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'rot-tok', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    storeMemoryOidcConnection(OWNER, { ...base, accessToken: 'old', expiresAt: past() });

    const creds = await resolveLiveMemoryCreds(OWNER);
    expect(creds?.bearer).toBe('rot-tok');
    // We SENT the stored refresh token…
    expect(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).toContain('refresh_token=refresh-1');
    // …and the re-sealed blob KEPT it (rotation-safe), ready for the next refresh.
    const row = sqlite
      .prepare(`SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ?`)
      .get(OWNER, MEMORY_PROVIDER) as { iv: string; auth_tag: string; ciphertext: string };
    const blob = JSON.parse(open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, loadKek()));
    expect(blob.refreshToken).toBe('refresh-1');
    expect(blob.accessToken).toBe('rot-tok');
  });

  it('single-flights concurrent refreshes (one token-endpoint hit)', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'sf-tok', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    storeMemoryOidcConnection(OWNER, { ...base, accessToken: 'old', expiresAt: past() });
    const [a, b, c] = await Promise.all([resolveLiveMemoryCreds(OWNER), resolveLiveMemoryCreds(OWNER), resolveLiveMemoryCreds(OWNER)]);
    expect([a?.bearer, b?.bearer, c?.bearer]).toEqual(['sf-tok', 'sf-tok', 'sf-tok']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces MemoryUnavailable when the refresh token is dead (HTTP 401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })));
    storeMemoryOidcConnection(OWNER, { ...base, accessToken: 'old', expiresAt: past() });
    await expect(resolveLiveMemoryCreds(OWNER)).rejects.toBeInstanceOf(MemoryUnavailable);
  });
});

// ── 2. scope helper ────────────────────────────────────────────────────────────
describe('memoryConnectorScopes', () => {
  it('adds offline_access to the login scopes (deduped)', () => {
    const saved = config.ciportal.scopes;
    try {
      config.ciportal.scopes = 'openid profile email';
      expect(memoryConnectorScopes().split(' ').sort()).toEqual(['email', 'offline_access', 'openid', 'profile']);
      config.ciportal.scopes = 'openid offline_access'; // already present → not duplicated
      expect(memoryConnectorScopes().split(' ').filter((s) => s === 'offline_access')).toHaveLength(1);
    } finally {
      config.ciportal.scopes = saved;
    }
  });
});

// ── 3. routes ────────────────────────────────────────────────────────────────────
function makeIdToken(overrides: { sub?: string | null; nonce?: string; iss?: string; aud?: string }, opts?: { signWith?: KeyObject }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'kid-mem';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: overrides.iss ?? PORTAL.issuer,
      aud: overrides.aud ?? PORTAL.clientId,
      ...(overrides.sub === null ? {} : { sub: overrides.sub ?? 'mem-sub-1' }),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: overrides.nonce,
      name: 'Portal User',
      email: 'portal.user@ci.test',
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(opts?.signWith ?? privateKey).toString('base64url');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { idToken: `${header}.${payload}.${signature}`, jwks: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}

function stubPortal(tokenResponse: unknown, jwks: unknown[] = [], tokenStatus = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.startsWith(PORTAL.tokenUri))
      return new Response(JSON.stringify(tokenResponse), { status: tokenStatus, headers: { 'Content-Type': 'application/json' } });
    if (u.startsWith(PORTAL.jwksUri))
      return new Response(JSON.stringify({ keys: jwks }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`unexpected fetch in test: ${u}`);
  }));
}

async function rawGet(srv: TestServer, path: string, headers?: Record<string, string>) {
  const res = await realFetch(`${srv.url}${path}`, { redirect: 'manual', headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, location: res.headers.get('location'), body };
}

/** Seed an oauth_states row exactly as /start would, so the public /callback can consume it. */
function seedState(ownerId: string, nonce: string): string {
  const state = `st-${newId()}`;
  sqlite
    .prepare(
      `INSERT INTO oauth_states (id, owner_id, provider, state, code_verifier, nonce, redirect_uri, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), ownerId, MEMORY_PROVIDER, state, 'verifier-xyz', nonce, config.ciportal.memoryRedirectUri,
      new Date(Date.now() + 600_000).toISOString());
  return state;
}

describe('AA0b routes', () => {
  let srv: TestServer;
  let savedAuth: typeof config.auth;
  let savedPortal: typeof config.ciportal;

  beforeAll(async () => {
    savedAuth = { ...config.auth };
    savedPortal = { ...config.ciportal };
    config.auth.mode = 'sso';
    config.auth.disableOidc = false;
    config.auth.sessionSecret = 'test-session-secret';
    Object.assign(config.ciportal, PORTAL, { memoryRedirectUri: 'http://localhost:3848/api/memory/ciportal/callback' });
    process.env.CI_SERVER_URL = CI_SERVER;
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    Object.assign(config.auth, savedAuth);
    Object.assign(config.ciportal, savedPortal);
  });

  beforeEach(() => resetDb());
  afterEach(() => {
    sqlite.exec(`DELETE FROM oauth_states;`);
    vi.unstubAllGlobals();
  });

  it('GET /api/memory/ciportal/start is gated — 401 without a session', async () => {
    const res = await rawGet(srv, '/api/memory/ciportal/start');
    expect(res.status).toBe(401);
  });

  it('the public callback stores an oidc connection + stamps memory_account, then redirects connected', async () => {
    const owner = provisionOwner({ name: 'Mem User', email: 'mem@ci.test', externalSubject: 'mem-sub-1' });
    const nonce = 'nonce-happy';
    const state = seedState(owner, nonce);
    const { idToken, jwks } = makeIdToken({ sub: 'mem-sub-1', nonce });
    stubPortal({ access_token: 'AT', refresh_token: 'RT', id_token: idToken, expires_in: 3600 }, jwks);

    const res = await rawGet(srv, `/api/memory/ciportal/callback?state=${state}&code=CODE`);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/settings?memory=connected');

    // Stored as an oidc connection whose live bearer is the access token.
    expect(memoryCreds(owner)).toEqual({ url: CI_SERVER, bearer: 'AT', source: 'settings', authKind: 'oidc' });
    const acct = sqlite.prepare(`SELECT memory_account FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { memory_account: string };
    expect(acct.memory_account).toBe('memory.ci.test');
    // The state row is single-use (consumed).
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM oauth_states`).get()).toEqual({ n: 0 });
  });

  it('refuses a grant with no refresh token (offline_access is required to self-refresh)', async () => {
    const owner = provisionOwner({ name: 'No RT', externalSubject: 'mem-sub-2' });
    const nonce = 'nonce-nort';
    const state = seedState(owner, nonce);
    const { idToken, jwks } = makeIdToken({ sub: 'mem-sub-2', nonce });
    stubPortal({ access_token: 'AT', id_token: idToken, expires_in: 3600 }, jwks); // no refresh_token

    const res = await rawGet(srv, `/api/memory/ciportal/callback?state=${state}&code=CODE`);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/settings?memory=error&reason=no_refresh_token');
    expect(memoryCreds(owner)).toBeNull();
  });

  it('rejects an id_token whose subject is not the connecting owner (subject binding)', async () => {
    const owner = provisionOwner({ name: 'Bound', externalSubject: 'the-owner-sub' });
    const nonce = 'nonce-bind';
    const state = seedState(owner, nonce);
    const { idToken, jwks } = makeIdToken({ sub: 'someone-else', nonce }); // mismatched subject
    stubPortal({ access_token: 'AT', refresh_token: 'RT', id_token: idToken, expires_in: 3600 }, jwks);

    const res = await rawGet(srv, `/api/memory/ciportal/callback?state=${state}&code=CODE`);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/settings?memory=error&reason=subject_mismatch');
    expect(memoryCreds(owner)).toBeNull();
  });

  it('400s an unknown/consumed state', async () => {
    const res = await rawGet(srv, '/api/memory/ciportal/callback?state=nope&code=CODE');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_or_consumed_state' });
  });
});
