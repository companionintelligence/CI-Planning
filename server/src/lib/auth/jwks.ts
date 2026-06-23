import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { sqlite } from '../../db/index.js';
import { newId } from '../ids.js';
import { config } from '../config.js';
import { httpError } from '../http-error.js';
import { logger } from '../logger.js';
import { SCOPE_READ, type VerifiedClaims } from './types.js';

/**
 * SSO mode (D5) — a verify-only JWKS resource server. Planning validates a
 * CI-Server-minted JWT against the published JWKS endpoint (asymmetric RS256/EdDSA);
 * it never holds a signing secret and cannot mint. `jose` handles key rotation +
 * caching. We NEVER accept `alg: none` or any `HS*` — those imply a shared secret
 * we refuse to hold.
 */

// The remote key set is keyed by URL and built lazily (config is read at request
// time, and the tests point jwksUrl at a stub endpoint after import). Rebuilt only
// when the configured URL changes.
let cached: { url: string; set: JWTVerifyGetKey } | null = null;

function jwks(): JWTVerifyGetKey {
  const url = config.auth.jwksUrl;
  if (!url) throw httpError(401, 'sso not configured');
  if (!cached || cached.url !== url) {
    cached = { url, set: createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000 }) };
  }
  return cached.set;
}

/** Test-only: drop the memoized key set so a new stub JWKS URL takes effect. */
export function _resetJwksCache(): void {
  cached = null;
}

/**
 * Map verified JWT claims to a local owner. `sub` is the external subject; an owner
 * row with a matching `external_subject` resolves to its id. An unknown subject is
 * provisioned (when `auth.autoProvision`) or rejected with 403 (fail closed).
 */
function mapClaims(payload: JWTPayload): VerifiedClaims {
  const sub = payload.sub;
  if (!sub) throw httpError(401, 'token missing sub');

  // `scope` (space-delimited, OAuth convention) or `scopes` (array). Default to the
  // least privilege (read) rather than failing open on an absent claim.
  const raw = (payload as Record<string, unknown>).scope ?? (payload as Record<string, unknown>).scopes;
  const scopes = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/\s+/).filter(Boolean)
      : [SCOPE_READ];

  const existing = sqlite
    .prepare(`SELECT id FROM owners WHERE external_subject = ?`)
    .get(sub) as { id: string } | undefined;
  if (existing) return { ownerId: existing.id, scopes };

  if (!config.auth.autoProvision) throw httpError(403, 'unknown subject');

  const id = newId();
  const name = typeof payload.name === 'string' ? payload.name : sub;
  const email = typeof payload.email === 'string' ? payload.email : null;
  sqlite
    .prepare(`INSERT INTO owners (id, name, email, external_subject) VALUES (?, ?, ?, ?)`)
    .run(id, name, email, sub);
  logger.info('auth: provisioned owner from SSO subject', { ownerId: id });
  return { ownerId: id, scopes };
}

export async function verifyBearer(token: string): Promise<VerifiedClaims> {
  // Defense in depth (the boot assertion in config.ts is the primary guard): never
  // call jwtVerify without an issuer to pin — `jose` skips the `iss` check entirely
  // when `issuer` is undefined, which would silently accept tokens for any service.
  if (!config.auth.issuer) throw httpError(401, 'sso issuer not configured');
  // Pin issuer + audience so a rotated-but-valid key for the wrong service is still
  // rejected; restrict algorithms to the asymmetric set (never none / HS*).
  const { payload } = await jwtVerify(token, jwks(), {
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    algorithms: ['RS256', 'EdDSA'],
  });
  return mapClaims(payload);
}
