import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { newId, SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';

/**
 * U1 — CI-Portal SSO (OAuth 2.1 + PKCE Relying-Party login).
 *
 * Endpoints are exercised against a STUBBED portal (vi.stubGlobal fetch for the
 * token + JWKS endpoints, real RS256 keypairs — the exact pattern oauth.test.ts
 * proved for Google). No real network. The negative matrix from the ticket:
 * no code, wrong/replayed state, expired state, alg:none, HS256-forged, wrong
 * iss/aud, expired token, tampered signature — all rejected; auto-provisioning
 * creates exactly one FUNCTIONAL owner per new `sub` (G-BASETAG seeds included),
 * excludes the sentinel, and repeat logins reuse the owner.
 */

const PORTAL = {
  clientId: 'companion-planning-test',
  issuer: 'https://portal.test',
  authorizeUri: 'https://portal.test/authorize',
  tokenUri: 'https://portal.test/token',
  jwksUri: 'https://portal.test/jwks',
};

// Capture the REAL fetch before stubbing — the client driving our server must not hit the stub.
const realFetch = globalThis.fetch.bind(globalThis);

let srv: TestServer;
let savedAuth: typeof config.auth;
let savedPortal: typeof config.ciportal;

async function rawGet(path: string) {
  const res = await realFetch(`${srv.url}${path}`, { redirect: 'manual' });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {
    status: res.status,
    location: res.headers.get('location'),
    setCookies: res.headers.getSetCookie?.() ?? [],
    body,
  };
}

const cookieHeader = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]).join('; ');

/** Seed an auth_states row directly (as /start would) and return its state value. */
function seedState(opts?: { nonce?: string; expiresAt?: string }): { state: string; nonce: string } {
  const state = `state-${newId()}`;
  const nonce = opts?.nonce ?? `nonce-${newId()}`;
  sqlite
    .prepare(
      `INSERT INTO auth_states (id, state, code_verifier, nonce, redirect_uri, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      state,
      'verifier-1234567890abcdefghij1234567890abcdefghij',
      nonce,
      config.ciportal.redirectUri,
      opts?.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
    );
  return { state, nonce };
}

interface TokenPayloadOverrides {
  iss?: string;
  aud?: string;
  sub?: string | null;
  exp?: number;
  nonce?: string;
  name?: string;
  email?: string;
}

/** Mint a keypair + RS256-sign an id_token; serve its public JWK from the stubbed JWKS. */
function makeIdToken(overrides: TokenPayloadOverrides, opts?: { alg?: string; signWith?: KeyObject; kid?: string }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = opts?.kid ?? 'kid-test';
  const header = Buffer.from(JSON.stringify({ alg: opts?.alg ?? 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: overrides.iss ?? PORTAL.issuer,
      aud: overrides.aud ?? PORTAL.clientId,
      ...(overrides.sub === null ? {} : { sub: overrides.sub ?? 'portal-sub-1' }),
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 300,
      nonce: overrides.nonce,
      name: overrides.name ?? 'Portal User',
      email: overrides.email ?? 'portal.user@ci.test',
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(opts?.signWith ?? privateKey).toString('base64url');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { idToken: `${header}.${payload}.${signature}`, jwks: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}

/** Stub fetch: token endpoint → tokenResponse; JWKS endpoint → keys. */
function stubPortal(tokenResponse: unknown, jwks: unknown[] = [], tokenStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith(PORTAL.tokenUri)) {
        return new Response(JSON.stringify(tokenResponse), {
          status: tokenStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.startsWith(PORTAL.jwksUri)) {
        return new Response(JSON.stringify({ keys: jwks }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );
}

beforeAll(async () => {
  savedAuth = { ...config.auth };
  savedPortal = { ...config.ciportal };
  config.auth.mode = 'sso';
  config.auth.disableOidc = false;
  config.auth.sessionSecret = 'test-session-secret';
  config.auth.autoProvision = true;
  config.auth.rateLimit = { ...config.auth.rateLimit, issueMax: 1000 };
  Object.assign(config.ciportal, PORTAL, { redirectUri: 'http://localhost:3848/api/auth/ciportal/callback' });
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  Object.assign(config.auth, savedAuth);
  Object.assign(config.ciportal, savedPortal);
});

beforeEach(() => {
  resetDb();
  __resetAuthRateLimit();
  config.auth.autoProvision = true;
});

afterEach(() => {
  sqlite.exec('DELETE FROM auth_states;');
  vi.unstubAllGlobals();
});

// ── /start ────────────────────────────────────────────────────────────────────
describe('GET /api/auth/ciportal/start', () => {
  it('302s to the portal with PKCE S256 + state + nonce, and stores the auth_states row', async () => {
    const { status, location } = await rawGet('/api/auth/ciportal/start');
    expect(status).toBe(302);
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(PORTAL.authorizeUri);
    expect(url.searchParams.get('client_id')).toBe(PORTAL.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.ciportal.redirectUri); // verbatim from config
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();

    const rows = sqlite.prepare('SELECT * FROM auth_states').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(url.searchParams.get('state'));
    expect(rows[0].nonce).toBe(url.searchParams.get('nonce'));
    // The PKCE verifier must NEVER appear in the redirect URL.
    const verifier = String(rows[0].code_verifier);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(location).not.toContain(verifier);
  });

  it('prunes expired auth_states rows on each start', async () => {
    seedState({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await rawGet('/api/auth/ciportal/start');
    const rows = sqlite.prepare('SELECT expires_at FROM auth_states').all() as { expires_at: string }[];
    expect(rows).toHaveLength(1); // only the fresh row — the expired one is gone
    expect(new Date(rows[0].expires_at) > new Date()).toBe(true);
  });

  it('404s when DISABLE_OIDC=true (local mode owns login)', async () => {
    config.auth.disableOidc = true;
    try {
      const { status } = await rawGet('/api/auth/ciportal/start');
      expect(status).toBe(404);
    } finally {
      config.auth.disableOidc = false;
    }
  });

  it('503s when the CIPORTAL_* endpoints are not configured', async () => {
    const saved = config.ciportal.clientId;
    config.ciportal.clientId = undefined;
    try {
      const { status } = await rawGet('/api/auth/ciportal/start');
      expect(status).toBe(503);
      expect(sqlite.prepare('SELECT COUNT(*) n FROM auth_states').get()).toEqual({ n: 0 });
    } finally {
      config.ciportal.clientId = saved;
    }
  });

  it('rate limits (429) once issueMax attempts are exceeded', async () => {
    const saved = config.auth.rateLimit;
    config.auth.rateLimit = { windowMs: 60_000, max: 60, issueMax: 2 };
    __resetAuthRateLimit();
    try {
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(302);
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(302);
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(429);
    } finally {
      config.auth.rateLimit = saved;
    }
  });
});

// ── /callback: state handling ───────────────────────────────────────────────────
describe('GET /api/auth/ciportal/callback — state handling', () => {
  it('is public (400 on unknown state, NOT 401)', async () => {
    const { status, body } = await rawGet('/api/auth/ciportal/callback?state=nope&code=abc');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'unknown_or_consumed_state' });
  });

  it('400s when state or code is missing', async () => {
    expect((await rawGet('/api/auth/ciportal/callback?code=abc')).status).toBe(400);
    expect((await rawGet('/api/auth/ciportal/callback?state=abc')).status).toBe(400);
  });

  it('400s on an expired state row', async () => {
    const { state } = seedState({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const { status, body } = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=abc`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'expired_state' });
  });

  it('a state is single-use: a replayed callback is rejected', async () => {
    const { state, nonce } = seedState();
    const { idToken, jwks } = makeIdToken({ nonce });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);

    expect((await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C1`)).status).toBe(302);
    const replay = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C1`);
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: 'unknown_or_consumed_state' });
  });

  it('a provider error bounces back to /login with a displayable reason', async () => {
    const { status, location } = await rawGet('/api/auth/ciportal/callback?error=access_denied');
    expect(status).toBe(302);
    expect(location).toContain('/login?sso_error=access_denied');
  });
});

// ── /callback: token & id_token verification (the negative matrix) ─────────────
describe('GET /api/auth/ciportal/callback — id_token verification', () => {
  async function expectRejected(idToken: string, jwks: unknown[], error = 'invalid_id_token') {
    const { state } = seedState({ nonce: 'expected-nonce' });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    // And no owner was created, no session issued.
    expect((sqlite.prepare('SELECT COUNT(*) n FROM owners').get() as { n: number }).n).toBe(1); // sentinel only
    expect(res.setCookies.join('')).not.toContain('cp_session=');
  }

  it('rejects a failed token exchange', async () => {
    const { state } = seedState();
    stubPortal({ error: 'invalid_grant' }, [], 400);
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=BAD`);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('token_exchange_failed');
  });

  it('rejects a token response with no id_token', async () => {
    const { state } = seedState();
    stubPortal({ access_token: 'A-only' });
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_id_token' });
  });

  it('rejects alg:none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: PORTAL.issuer, aud: PORTAL.clientId, sub: 'x', nonce: 'expected-nonce', exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    await expectRejected(`${header}.${payload}.`, []);
  });

  it('rejects an HS256-forged token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: PORTAL.issuer, aud: PORTAL.clientId, sub: 'x', nonce: 'expected-nonce', exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    const sig = Buffer.from('hmac-forgery').toString('base64url');
    await expectRejected(`${header}.${payload}.${sig}`, []);
  });

  it('rejects a tampered signature (signed by an unrelated key)', async () => {
    const { privateKey: rogue } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { idToken, jwks } = makeIdToken({ nonce: 'expected-nonce' }, { signWith: rogue });
    await expectRejected(idToken, jwks); // JWKS holds the real key; token signed by the rogue one
  });

  it('rejects a wrong issuer', async () => {
    const { idToken, jwks } = makeIdToken({ iss: 'https://evil.example', nonce: 'expected-nonce' });
    await expectRejected(idToken, jwks);
  });

  it('rejects a wrong audience', async () => {
    const { idToken, jwks } = makeIdToken({ aud: 'some-other-app', nonce: 'expected-nonce' });
    await expectRejected(idToken, jwks);
  });

  it('rejects an expired token', async () => {
    const { idToken, jwks } = makeIdToken({ exp: Math.floor(Date.now() / 1000) - 10, nonce: 'expected-nonce' });
    await expectRejected(idToken, jwks);
  });

  it('rejects a nonce mismatch (token spliced from another flow)', async () => {
    const { idToken, jwks } = makeIdToken({ nonce: 'a-DIFFERENT-nonce' });
    await expectRejected(idToken, jwks);
  });

  it('rejects a verified token with no sub', async () => {
    const { idToken, jwks } = makeIdToken({ sub: null, nonce: 'expected-nonce' });
    await expectRejected(idToken, jwks);
  });
});

// ── /callback: provisioning + session ───────────────────────────────────────────
describe('GET /api/auth/ciportal/callback — provisioning & session', () => {
  function login(sub = 'portal-sub-1', extra: TokenPayloadOverrides = {}) {
    const { state, nonce } = seedState();
    const { idToken, jwks } = makeIdToken({ sub, nonce, ...extra });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    return rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`);
  }

  it('auto-provisions a FUNCTIONAL owner on first login: session + G-BASETAG seeds', async () => {
    const res = await login('sub-new', { name: 'Ada Portal', email: 'ada@ci.test' });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');

    // Signed session cookie pair, httpOnly.
    const joined = res.setCookies.join('\n');
    expect(joined).toMatch(/cp_session=/);
    expect(joined).toMatch(/cp_session\.sig=/);
    expect(res.setCookies.every((c) => /httponly/i.test(c))).toBe(true);

    // Owner row mapped to the token sub, with identity claims.
    const owner = sqlite
      .prepare(`SELECT id, name, email, external_subject FROM owners WHERE external_subject = 'sub-new'`)
      .get() as { id: string; name: string; email: string };
    expect(owner).toBeTruthy();
    expect(owner.name).toBe('Ada Portal');
    expect(owner.email).toBe('ada@ci.test');

    // G-BASETAG: the new owner is a functional tenant.
    const tags = sqlite
      .prepare(`SELECT name, kind, is_base FROM tags WHERE owner_id = ? ORDER BY name`)
      .all(owner.id) as { name: string; kind: string; is_base: number }[];
    expect(tags.map((t) => `${t.kind}:${t.name}`).sort()).toEqual([
      'category:family', 'category:me', 'category:social',
      'pattern:community', 'pattern:home', 'pattern:work',
    ]);
    expect(tags.every((t) => t.is_base === 1)).toBe(true);
    const catPrefs = sqlite
      .prepare(`SELECT COUNT(*) n FROM tag_prefs WHERE owner_id = ? AND kind = 'category'`)
      .get(owner.id) as { n: number };
    expect(catPrefs.n).toBe(3);
    const dayTypes = sqlite.prepare(`SELECT key FROM day_types WHERE owner_id = ? ORDER BY key`).all(owner.id);
    expect(dayTypes).toEqual([{ key: 'weekend' }, { key: 'workday' }]);
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM day_of_week_map WHERE owner_id = ?`).get(owner.id) as { n: number }).n).toBe(7);
    const patternTypes = sqlite
      .prepare(`SELECT name, catch_all FROM pattern_types WHERE owner_id = ? ORDER BY name`)
      .all(owner.id) as { name: string; catch_all: number }[];
    expect(patternTypes.map((p) => p.name)).toEqual(['Community', 'Habit', 'Ritual', 'Routine']);
    expect(patternTypes.find((p) => p.name === 'Community')!.catch_all).toBe(1);
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM scheduling_prefs WHERE owner_id = ?`).get(owner.id)).toEqual({ n: 1 });
  });

  it('the issued session authenticates gated routes; /api/auth/me reports the identity', async () => {
    const res = await login('sub-session', { name: 'Sess Ion', email: 'sess@ci.test' });
    const cookie = cookieHeader(res.setCookies);

    const tasks = await realFetch(`${srv.url}/api/tasks`, { headers: { Cookie: cookie } });
    expect(tasks.status).toBe(200);

    const me = await realFetch(`${srv.url}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const identity = (await me.json()) as { name: string; email: string };
    expect(identity.name).toBe('Sess Ion');
    expect(identity.email).toBe('sess@ci.test');

    const anon = await realFetch(`${srv.url}/api/auth/me`);
    expect(anon.status).toBe(401);
  });

  it('a repeat login with the same sub reuses the owner (no duplicates)', async () => {
    await login('sub-repeat');
    await login('sub-repeat');
    const n = (sqlite.prepare(`SELECT COUNT(*) n FROM owners WHERE external_subject = 'sub-repeat'`).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('403s an unknown sub when auto-provision is off', async () => {
    config.auth.autoProvision = false;
    const res = await login('sub-unknown');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unknown_subject_auto_provision_disabled' });
    expect(res.setCookies.join('')).not.toContain('cp_session=');
  });

  it('N-SENTINEL: a login can never bind to the SYSTEM_OWNER sentinel — it fails closed', async () => {
    // Defensive: force the sentinel to carry the incoming sub. The lookup's
    // `id <> SYSTEM_OWNER_ID` guard must skip it, and provisioning a duplicate sub is
    // blocked by U0's UNIQUE index — so the only safe outcome is a clean 403: no
    // session for the sentinel, no session at all, no 500.
    sqlite.prepare(`UPDATE owners SET external_subject = 'sub-sentinel-attack' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const res = await login('sub-sentinel-attack');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'subject_unavailable' });
      expect(res.setCookies.join('')).not.toContain('cp_session=');
      // And the sentinel remains the ONLY holder of that sub — nothing was provisioned.
      const holders = sqlite
        .prepare(`SELECT id FROM owners WHERE external_subject = 'sub-sentinel-attack'`)
        .all() as { id: string }[];
      expect(holders).toEqual([{ id: SYSTEM_OWNER_ID }]);
    } finally {
      sqlite.prepare(`UPDATE owners SET external_subject = NULL WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });

  it('logout clears the SSO session', async () => {
    const res = await login('sub-logout');
    const cookie = cookieHeader(res.setCookies);
    const out = await realFetch(`${srv.url}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    const cleared = cookieHeader(out.headers.getSetCookie?.() ?? []);
    const after = await realFetch(`${srv.url}/api/tasks`, { headers: { Cookie: cleared } });
    expect(after.status).toBe(401);
  });
});
