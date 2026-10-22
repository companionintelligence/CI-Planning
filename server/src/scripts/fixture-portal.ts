import { createServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign, createHash, randomBytes } from 'node:crypto';

/**
 * U1 — a fixture CI-Portal: a minimal, standards-shaped OIDC provider used to
 * exercise the real `/api/auth/ciportal/*` Relying-Party flow end to end WITHOUT
 * the real CI-Portal (whose discovery values/client registration are pending from
 * the CI-Portal team). Dev/demo/manual-testing only — never part of the app.
 *
 * It implements just enough, correctly:
 *   GET  /.well-known/openid-configuration  → discovery document
 *   GET  /authorize   → renders a consent page; "Continue" mints a one-time code
 *   GET  /approve     → binds code→{nonce, code_challenge, redirect_uri}, 302 back
 *   POST /token       → validates the code + PKCE S256 verifier, mints a REAL
 *                       signed id_token (in-memory keypair)
 *   GET  /jwks        → the signing key's public JWK
 *
 * Signing algorithm: EdDSA / Ed25519 by default — what the real CI-Portal issues
 * (better-auth's `jwt()` plugin with its default key config; the live JWKS at
 * https://hub.ci.computer/api/auth/jwks holds exactly one OKP/Ed25519 key). Set
 * FIXTURE_PORTAL_ALG=RS256 to mint RSA-signed tokens instead (the Google shape).
 * The fixture used to be RS256-only, which is how a verifier that could not check
 * EdDSA passed every end-to-end run while failing against production.
 *
 * Run:  pnpm --filter server exec tsx src/scripts/fixture-portal.ts
 * Then point the app at it:
 *   AUTH_MODE=sso SESSION_SECRET=dev AUTH_AUTO_PROVISION=true
 *   CIPORTAL_CLIENT_ID=companion-planning-dev
 *   CIPORTAL_ISSUER=http://localhost:9899
 *   CIPORTAL_AUTHORIZE_URI=http://localhost:9899/authorize
 *   CIPORTAL_TOKEN_URI=http://localhost:9899/token
 *   CIPORTAL_JWKS_URI=http://localhost:9899/jwks
 */

const PORT = Number(process.env.FIXTURE_PORTAL_PORT ?? 9899);
const ISSUER = process.env.FIXTURE_PORTAL_ISSUER ?? `http://localhost:${PORT}`;
const USER = {
  sub: process.env.FIXTURE_SUB ?? 'fixture-user-001',
  name: process.env.FIXTURE_NAME ?? 'Avery Fixture',
  email: process.env.FIXTURE_EMAIL ?? 'avery@fixture.local',
};

const ALG = (process.env.FIXTURE_PORTAL_ALG ?? 'EdDSA') as 'EdDSA' | 'RS256';
if (ALG !== 'EdDSA' && ALG !== 'RS256') {
  throw new Error(`FIXTURE_PORTAL_ALG='${ALG}' — set EdDSA (default, CI-Portal) or RS256 (Google)`);
}
const { publicKey, privateKey } =
  ALG === 'EdDSA' ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fixture-key-1';
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, alg: ALG, use: 'sig' };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** One-time authorization codes → the flow they were minted for. */
const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; clientId: string }>();

function signIdToken(clientId: string, nonce: string): string {
  const header = b64url(JSON.stringify({ alg: ALG, kid: KID, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER,
      aud: clientId,
      sub: USER.sub,
      name: USER.name,
      email: USER.email,
      nonce,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  );
  // Ed25519 is "pure" EdDSA: node takes a null digest and refuses any other. RS256 is
  // RSASSA-PKCS1-v1_5 over SHA-256, the same one-shot API with the digest named.
  const signature = cryptoSign(ALG === 'EdDSA' ? null : 'RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

const CONSENT_PAGE = (approveUrl: string, clientId: string) => `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Companion Portal (fixture)</title>
<style>
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0b1220; color:#e6edf6;
         display:grid; place-items:center; min-height:100vh; }
  .card { background:#121a2b; border:1px solid #24304a; border-radius:16px; padding:32px; width:min(380px,90vw);
          box-shadow:0 18px 60px rgba(0,0,0,.45); }
  .badge { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:#7dd3b9; }
  h1 { font-size:20px; margin:10px 0 4px; } p { color:#93a4bd; font-size:13px; line-height:1.5; }
  .user { display:flex; gap:10px; align-items:center; background:#0e1626; border:1px solid #223050;
          border-radius:12px; padding:10px 12px; margin:18px 0; }
  .avatar { width:34px; height:34px; border-radius:50%; background:linear-gradient(135deg,#37d0a2,#2b8ea3);
            display:grid; place-items:center; font-weight:700; color:#04161f; }
  .u-name { font-size:14px; font-weight:600; } .u-mail { font-size:12px; color:#7c8db0; }
  a.btn { display:block; text-align:center; background:linear-gradient(135deg,#37d0a2,#31b8a0); color:#04161f;
          font-weight:700; text-decoration:none; padding:11px 0; border-radius:12px; font-size:14px; }
  .client { color:#c9d6ea; font-weight:600; }
</style></head><body>
  <div class="card">
    <div class="badge">Companion Portal · developer fixture</div>
    <h1>Sign in to <span class="client">${clientId}</span></h1>
    <p>This application is requesting your identity (<code>openid profile email</code>).</p>
    <div class="user"><div class="avatar">${USER.name[0] ?? 'U'}</div>
      <div><div class="u-name">${USER.name}</div><div class="u-mail">${USER.email}</div></div></div>
    <a class="btn" href="${approveUrl}">Continue as ${USER.name.split(' ')[0]}</a>
  </div>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  const send = (status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };

  if (url.pathname === '/.well-known/openid-configuration') {
    return send(200, JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      // The real portal advertises both and issues EdDSA; mirror that so a verifier
      // can't lean on the discovery list to decide what it will receive.
      id_token_signing_alg_values_supported: ['RS256', 'EdDSA'],
    }, null, 2));
  }

  if (url.pathname === '/jwks') {
    return send(200, JSON.stringify({ keys: [jwk] }));
  }

  if (url.pathname === '/authorize') {
    const q = url.searchParams;
    const missing = ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge'].filter((k) => !q.get(k));
    if (missing.length || q.get('code_challenge_method') !== 'S256' || q.get('response_type') !== 'code') {
      return send(400, JSON.stringify({ error: 'invalid_request', missing }));
    }
    const approve = new URL('/approve', ISSUER);
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) {
      approve.searchParams.set(k, q.get(k)!);
    }
    return send(200, CONSENT_PAGE(approve.pathname + approve.search, q.get('client_id')!), 'text/html');
  }

  if (url.pathname === '/approve') {
    const q = url.searchParams;
    const code = b64url(randomBytes(24));
    codes.set(code, {
      nonce: q.get('nonce')!,
      challenge: q.get('code_challenge')!,
      redirectUri: q.get('redirect_uri')!,
      clientId: q.get('client_id')!,
    });
    const back = new URL(q.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state')!);
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const grant = codes.get(p.get('code') ?? '');
      codes.delete(p.get('code') ?? ''); // single-use
      if (!grant) return send(400, JSON.stringify({ error: 'invalid_grant' }));
      if (p.get('grant_type') !== 'authorization_code') return send(400, JSON.stringify({ error: 'unsupported_grant_type' }));
      if (p.get('redirect_uri') !== grant.redirectUri) return send(400, JSON.stringify({ error: 'redirect_uri_mismatch' }));
      // REAL PKCE check: S256(verifier) must equal the challenge from /authorize.
      if (!p.get('code_verifier') || s256(p.get('code_verifier')!) !== grant.challenge) {
        return send(400, JSON.stringify({ error: 'invalid_pkce_verifier' }));
      }
      return send(200, JSON.stringify({
        access_token: b64url(randomBytes(24)),
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: signIdToken(grant.clientId, grant.nonce),
      }));
    });
    return;
  }

  send(404, JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Fixture CI-Portal on ${ISSUER}
  discovery: ${ISSUER}/.well-known/openid-configuration
  id_token alg: ${ALG}${ALG === 'EdDSA' ? ' (Ed25519 — what the real CI-Portal issues)' : ' (FIXTURE_PORTAL_ALG override)'}
  signing as: ${USER.name} <${USER.email}> (sub=${USER.sub})`);
});
