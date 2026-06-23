import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT, type JWK } from 'jose';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { _resetJwksCache } from '../src/lib/auth/jwks.js';
import { startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase I (PR2) — SSO verify-only path. A local RSA key pair signs fixture JWTs;
 * a stub HTTP endpoint serves its public JWK so `createRemoteJWKSet` can fetch it.
 * Asserts the happy path + auto-provisioning and the full negative matrix.
 */

const ISSUER = 'https://ci-server.test/';
const AUDIENCE = 'companion-planning';
const KID = 'test-key-1';
const ALG = 'RS256';

let priv: CryptoKey;
let jwksServer: HttpServer;
let jwksUrl: string;
let srv: TestServer;

async function signToken(claims: Record<string, unknown>, opts?: { exp?: string }): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(opts?.exp ?? '5m');
  return jwt.sign(priv);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair(ALG);
  priv = privateKey;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: ALG, use: 'sig' };

  jwksServer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, resolve));
  const { port } = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${port}/jwks`;

  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

/** Put the app into SSO mode pointing at the stub JWKS for the duration of a test. */
function enableSso(autoProvision = true): void {
  config.auth.mode = 'sso';
  config.auth.jwksUrl = jwksUrl;
  config.auth.issuer = ISSUER;
  config.auth.audience = AUDIENCE;
  config.auth.autoProvision = autoProvision;
  _resetJwksCache();
}

afterEach(() => {
  config.auth.mode = 'test';
  config.auth.jwksUrl = undefined;
  config.auth.issuer = undefined;
  config.auth.autoProvision = false;
  _resetJwksCache();
  // Drop owners provisioned from a JWT subject; keep the system owner.
  sqlite.exec(`DELETE FROM owners WHERE external_subject IS NOT NULL`);
});

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('SSO — happy path', () => {
  it('accepts a valid JWT and provisions the owner from `sub`', async () => {
    enableSso(true);
    const token = await signToken({ sub: 'user-abc', scope: 'planning:read planning:write', name: 'Abc' });
    const { status } = await api(srv.url, '/api/tasks', bearer(token));
    expect(status).toBe(200);
    const owner = sqlite.prepare(`SELECT name FROM owners WHERE external_subject = ?`).get('user-abc') as { name: string } | undefined;
    expect(owner?.name).toBe('Abc');
  });

  it('maps a known subject to its existing owner (no new row)', async () => {
    enableSso(false); // provisioning off — must resolve via the pre-seeded row
    sqlite.prepare(`INSERT INTO owners (id, name, external_subject) VALUES (?, 'Known', 'user-known')`).run('00000000-0000-7000-8000-0000000000f1');
    const token = await signToken({ sub: 'user-known', scope: 'planning:read' });
    const { status } = await api(srv.url, '/api/tasks', bearer(token));
    expect(status).toBe(200);
    const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM owners WHERE external_subject = 'user-known'`).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('enforces scope — a read-only JWT 403s on a mutation', async () => {
    enableSso(true);
    const token = await signToken({ sub: 'user-ro', scope: 'planning:read' });
    const { status } = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'x' }, ...bearer(token) });
    expect(status).toBe(403);
  });
});

describe('SSO — fail closed', () => {
  it('403s an unknown subject when auto-provision is off', async () => {
    enableSso(false);
    const token = await signToken({ sub: 'stranger', scope: 'planning:read' });
    const { status, body } = await api(srv.url, '/api/tasks', bearer(token));
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'forbidden' });
  });

  it('401s a wrong audience', async () => {
    enableSso(true);
    const jwt = await new SignJWT({ sub: 'u', scope: 'planning:read' })
      .setProtectedHeader({ alg: ALG, kid: KID })
      .setIssuedAt().setIssuer(ISSUER).setAudience('someone-else').setExpirationTime('5m').sign(priv);
    expect((await api(srv.url, '/api/tasks', bearer(jwt))).status).toBe(401);
  });

  it('401s a wrong issuer', async () => {
    enableSso(true);
    const jwt = await new SignJWT({ sub: 'u', scope: 'planning:read' })
      .setProtectedHeader({ alg: ALG, kid: KID })
      .setIssuedAt().setIssuer('https://evil.test/').setAudience(AUDIENCE).setExpirationTime('5m').sign(priv);
    expect((await api(srv.url, '/api/tasks', bearer(jwt))).status).toBe(401);
  });

  it('401s an expired token', async () => {
    enableSso(true);
    const token = await signToken({ sub: 'u', scope: 'planning:read' }, { exp: '-1m' });
    expect((await api(srv.url, '/api/tasks', bearer(token))).status).toBe(401);
  });

  it('401s an HS256 (shared-secret) token', async () => {
    enableSso(true);
    const hs = await new SignJWT({ sub: 'u', scope: 'planning:read' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-we-must-never-accept'));
    expect((await api(srv.url, '/api/tasks', bearer(hs))).status).toBe(401);
  });

  it('401s an unsecured (alg:none) token', async () => {
    enableSso(true);
    const none = new UnsecuredJWT({ sub: 'u', scope: 'planning:read' })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').encode();
    expect((await api(srv.url, '/api/tasks', bearer(none))).status).toBe(401);
  });

  it('401s when the issuer is not pinned (jose would otherwise skip the iss check)', async () => {
    enableSso(true);
    config.auth.issuer = undefined; // operator forgot AUTH_ISSUER
    _resetJwksCache();
    const token = await signToken({ sub: 'u', scope: 'planning:read' });
    expect((await api(srv.url, '/api/tasks', bearer(token))).status).toBe(401);
  });

  it('401s a tampered signature', async () => {
    enableSso(true);
    const token = await signToken({ sub: 'u', scope: 'planning:read' });
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -2) + (parts[2].slice(-2) === 'AA' ? 'BB' : 'AA'); // mangle the sig
    expect((await api(srv.url, '/api/tasks', bearer(parts.join('.')))).status).toBe(401);
  });
});
