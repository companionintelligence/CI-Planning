import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { provisionOwner } from '../src/lib/owners.js';
import { hashPassword, findOwnerByUsername, localOwnerCount, verifyLoginPassword } from '../src/lib/auth/password.js';
import { ensureLocalAuthBootstrap } from '../src/lib/auth/localBootstrap.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';

/**
 * U2 — local username/password mode (AUTH_MODE=sso + DISABLE_OIDC=true).
 * Exercises the login/logout/config routes, the signed-cookie session, the
 * requireAuth dispatch, the sentinel exclusion (N-SENTINEL), and the boot guard.
 */

const USER = 'admin';
const PW = 'correct-horse-battery-staple';

let srv: TestServer;
let savedAuth: typeof config.auth;

/** Keep only "name=value" from each Set-Cookie so we can echo them back as a Cookie header. */
function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function login(username: string, password: string) {
  const res = await fetch(`${srv.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, setCookies, cookie: cookieHeader(setCookies) };
}

const savedTrustProxy = config.trustProxy;

beforeAll(async () => {
  savedAuth = { ...config.auth };
  // Enter local-login mode BEFORE building the app (app.keys + app.proxy are read at build time).
  config.auth.mode = 'sso';
  config.auth.disableOidc = true;
  config.auth.sessionSecret = 'test-session-secret';
  config.auth.rateLimit = { ...config.auth.rateLimit, issueMax: 1000 }; // don't trip during functional tests
  config.trustProxy = true; // behind-a-TLS-terminator posture, so X-Forwarded-Proto is honored
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  Object.assign(config.auth, savedAuth); // restore singleton for other files
  config.trustProxy = savedTrustProxy;
});

beforeEach(() => {
  resetDb(); // prunes non-sentinel owners (and their prefs)
  __resetAuthRateLimit();
});

/** Seed a local owner with a real argon2id hash; tests that need a login call this. */
async function seedUser(username = USER, password = PW): Promise<string> {
  const hash = await hashPassword(password);
  return provisionOwner({ name: username, username, passwordHash: hash });
}

describe('U2 — GET /api/auth/config (public)', () => {
  it('reports the active mode without any credential', async () => {
    const res = await fetch(`${srv.url}/api/auth/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'sso', disableOidc: true });
  });
});

describe('U2 — login / session / logout', () => {
  it('logs in with correct credentials and issues a signed httpOnly cookie', async () => {
    await seedUser();
    const r = await login(USER, PW);
    expect(r.status).toBe(200);
    // Both the value cookie and Koa's HMAC `.sig` cookie, both httpOnly.
    const joined = r.setCookies.join('\n');
    expect(joined).toMatch(/cp_session=/);
    expect(joined).toMatch(/cp_session\.sig=/);
    expect(r.setCookies.every((c) => /httponly/i.test(c))).toBe(true);
    // Plain http (no proxy header): not Secure, so the cookie still works on the tailnet.
    expect(r.setCookies.join('\n')).not.toMatch(/;\s*secure/i);
  });

  it('sets the Secure flag when X-Forwarded-Proto is https (TLS-terminated / proxied deploy)', async () => {
    await seedUser();
    const res = await fetch(`${srv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ username: USER, password: PW }),
    });
    expect(res.status).toBe(200);
    const session = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('cp_session='));
    expect(session).toMatch(/;\s*secure/i); // Secure applied even though the socket is http
  });

  it('the session cookie authenticates a gated request; missing cookie is 401', async () => {
    await seedUser();
    const { cookie } = await login(USER, PW);

    const authed = await fetch(`${srv.url}/api/tasks`, { headers: { Cookie: cookie } });
    expect(authed.status).toBe(200);

    const anon = await fetch(`${srv.url}/api/tasks`);
    expect(anon.status).toBe(401);
  });

  it('logout clears the session so the cookie no longer authenticates', async () => {
    await seedUser();
    const { cookie } = await login(USER, PW);

    const out = await fetch(`${srv.url}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    // Behavioral: the cleared cookie the logout hands back no longer authenticates.
    const clearedCookie = cookieHeader(out.headers.getSetCookie?.() ?? []);
    const after = await fetch(`${srv.url}/api/tasks`, { headers: { Cookie: clearedCookie } });
    expect(after.status).toBe(401);
  });

  it('logout WITHOUT a session cookie is a no-op — no forced Set-Cookie (logout-CSRF defense)', async () => {
    const res = await fetch(`${srv.url}/api/auth/logout`, { method: 'POST' }); // no Cookie presented
    expect(res.status).toBe(200);
    // Nothing to clear ⇒ no cp_session deletion cookie, so a cross-site POST can't force logout.
    const setCookies = res.headers.getSetCookie?.() ?? [];
    expect(setCookies.some((c) => c.startsWith('cp_session='))).toBe(false);
  });

  it('rejects a wrong password and an unknown username with an identical generic 401', async () => {
    await seedUser();
    const wrong = await login(USER, 'nope');
    const unknown = await login('ghost', PW);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const res = await fetch(`${srv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x' }), // no password
    });
    expect(res.status).toBe(400);
  });
});

describe('U2 — N-SENTINEL exclusion', () => {
  it('findOwnerByUsername never returns the sentinel, even if it carries a username', () => {
    // Defensive: the sentinel never has auth columns in prod. Force them, and confirm
    // the `id <> SYSTEM_OWNER_ID` guard still hides it (without the guard this returns the row).
    sqlite.prepare(`UPDATE owners SET username = 'root', password_hash = 'x' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      expect(findOwnerByUsername('root')).toBeUndefined();
    } finally {
      sqlite.prepare(`UPDATE owners SET username = NULL, password_hash = NULL WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });

  it('a login attempt as the sentinel-shaped user is rejected end to end', async () => {
    sqlite.prepare(`UPDATE owners SET username = 'root', password_hash = 'x' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const r = await login('root', 'x');
      expect(r.status).toBe(401);
    } finally {
      sqlite.prepare(`UPDATE owners SET username = NULL, password_hash = NULL WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });
});

describe('U2 — login rate limiting (config.auth.rateLimit.issueMax)', () => {
  it('returns 429 once issueMax attempts in the window are exceeded', async () => {
    await seedUser();
    __resetAuthRateLimit();
    const saved = config.auth.rateLimit;
    config.auth.rateLimit = { windowMs: 60_000, max: 60, issueMax: 3 };
    try {
      // 3 allowed (wrong password → 401), the 4th is rate-limited (429).
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await login(USER, 'wrong')).status);
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes[3]).toBe(429);
    } finally {
      config.auth.rateLimit = saved;
    }
  });
});

describe('U2 — constant-work verify (enumeration-oracle mitigation)', () => {
  it('verifyLoginPassword runs against a decoy for absent/OIDC-only accounts and never matches', async () => {
    const hash = await hashPassword(PW);
    // Real account: correct pw matches, wrong pw does not.
    expect(await verifyLoginPassword(hash, PW)).toBe(true);
    expect(await verifyLoginPassword(hash, 'wrong')).toBe(false);
    // Unknown username (null) and OIDC-only owner (null hash) both verify against the
    // decoy and return false — one argon2id op either way, so no fast-path timing tell.
    expect(await verifyLoginPassword(null, PW)).toBe(false);
    expect(await verifyLoginPassword(undefined, 'anything')).toBe(false);
  });
});

describe('U2 — logout is inert outside local mode (no unauthenticated 500)', () => {
  it('POST /api/auth/logout returns 404, not 500, in standalone mode (app.keys unset)', async () => {
    const saved = { ...config.auth };
    config.auth.mode = 'standalone';
    config.auth.disableOidc = false;
    config.auth.sessionSecret = undefined; // → buildApp leaves app.keys unset
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/api/auth/logout`, { method: 'POST' });
      expect(res.status).toBe(404); // guard returns 404 before clearSession's signed-cookie write
    } finally {
      await s.close();
      Object.assign(config.auth, saved);
    }
  });
});

describe('U2 — boot bootstrap (ensureLocalAuthBootstrap)', () => {
  it('seeds the default owner when none exist and AUTH_DEFAULT_PASSWORD is set', async () => {
    resetDb();
    expect(localOwnerCount()).toBe(0);
    const saved = { u: config.auth.defaultUsername, p: config.auth.defaultPassword };
    config.auth.defaultUsername = 'boot-admin';
    config.auth.defaultPassword = 'boot-pw-123';
    try {
      await ensureLocalAuthBootstrap();
      expect(localOwnerCount()).toBe(1);
      const owner = findOwnerByUsername('boot-admin');
      expect(owner?.password_hash).toBeTruthy();
      // Idempotent: a second run does not create a duplicate.
      await ensureLocalAuthBootstrap();
      expect(localOwnerCount()).toBe(1);
    } finally {
      config.auth.defaultUsername = saved.u;
      config.auth.defaultPassword = saved.p;
    }
  });

  it('fails closed when no local owners exist and no default password is set', async () => {
    resetDb();
    const saved = config.auth.defaultPassword;
    config.auth.defaultPassword = undefined;
    try {
      await expect(ensureLocalAuthBootstrap()).rejects.toThrow(/no way to log in|AUTH_DEFAULT_PASSWORD/i);
    } finally {
      config.auth.defaultPassword = saved;
    }
  });

  it('does NOT count a username-only owner (null password_hash) as a usable login path', async () => {
    resetDb();
    // An owner with a username but no password_hash can never authenticate
    // (verifyLoginPassword always fails against the decoy), so it must not satisfy the
    // boot guard — otherwise we'd skip seeding AND skip failing closed, leaving no login.
    sqlite
      .prepare(`INSERT INTO owners (id, name, username) VALUES ('00000000-0000-7000-8000-0000000000c3', 'stub', 'stub-user')`)
      .run();
    expect(localOwnerCount()).toBe(0); // not counted — can't log in
    const saved = config.auth.defaultPassword;
    config.auth.defaultPassword = undefined;
    try {
      await expect(ensureLocalAuthBootstrap()).rejects.toThrow(/no way to log in|AUTH_DEFAULT_PASSWORD/i);
    } finally {
      config.auth.defaultPassword = saved;
    }
  });
});
