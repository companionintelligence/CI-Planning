import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Shared OIDC id_token verification (U1). Extracted verbatim from the proven Google
 * implementation (routes/oauth.ts, WP2/I1) and parameterized over issuer/audience/
 * JWKS so the CI-Portal login (U1) and the Google connector verify id_tokens through
 * ONE piece of security-sensitive code instead of two copies. No new dependency —
 * hand-rolled RS256 over node:crypto, exactly as before.
 *
 * Returns the claims ONLY if:
 *  - the token is a well-formed 3-segment JWT whose header says RS256 (alg:none,
 *    HS*, ES*, EdDSA … are all rejected — asymmetric RS256 is the one contract),
 *  - its signature checks against a JWKS key (matched by `kid` when present),
 *  - `iss` is in the caller's allow-list,
 *  - `aud` equals the caller's audience (the client_id),
 *  - `exp` is in the future,
 *  - `nonce` matches, when the caller expects one.
 * Anything else returns null — a tampered/forged token can NEVER establish identity.
 */

export interface OidcClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  sub?: string;
  email?: string;
  name?: string;
  nonce?: string;
  [k: string]: unknown;
}

export interface OidcVerifyParams {
  /** Accepted `iss` values (Google publishes two spellings; CI-Portal has one). */
  issuers: ReadonlySet<string>;
  /** Expected `aud` — our client_id at this provider. Empty/undefined ⇒ reject. */
  audience: string | undefined;
  /** The provider's JWKS endpoint. */
  jwksUri: string;
  /** Enforced when provided (we always send a nonce on flows we initiate). */
  expectedNonce: string | null;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/**
 * Bounded like the discovery fetch (lib/auth/oidcDiscovery.ts): this call sits on the
 * synchronous path of the login and memory-connector callbacks, so an unresponsive JWKS
 * endpoint — one that accepts the connection and then never answers — would otherwise
 * hold the request open indefinitely. `fetch` has no default timeout.
 */
const JWKS_TIMEOUT_MS = 5_000;

/** Fetch the provider's signing keys (JWKS). Returns [] on any failure (treated as unverifiable). */
async function fetchJwks(jwksUri: string): Promise<Jwk[]> {
  try {
    const res = await fetch(jwksUri, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!res.ok) return [];
    const json = (await res.json()) as { keys?: Jwk[] };
    return Array.isArray(json.keys) ? json.keys : [];
  } catch {
    // Includes the abort: a timed-out JWKS fetch yields no keys, so the caller finds no
    // candidate and rejects the token. Fail-CLOSED — a slow provider can never be the
    // reason a signature check is skipped.
    return [];
  }
}

export async function verifyOidcIdToken(
  idToken: string,
  params: OidcVerifyParams,
): Promise<OidcClaims | null> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: OidcClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  // Reject anything that isn't an asymmetric RS256 signature (notably alg=none).
  if (header.alg !== 'RS256') return null;
  if (!signatureB64) return null;

  const jwks = await fetchJwks(params.jwksUri);
  const candidates = header.kid ? jwks.filter((k) => k.kid === header.kid) : jwks;
  if (candidates.length === 0) return null;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, 'base64url');

  let signatureValid = false;
  for (const jwk of candidates) {
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    try {
      const key = createPublicKey({ key: jwk as object, format: 'jwk' });
      if (cryptoVerify('RSA-SHA256', signingInput, key, signature)) {
        signatureValid = true;
        break;
      }
    } catch {
      // try the next key
    }
  }
  if (!signatureValid) return null;

  // Signature is genuine — now enforce the registered-claims contract.
  if (!claims.iss || !params.issuers.has(claims.iss)) return null;
  if (!params.audience || claims.aud !== params.audience) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  if (params.expectedNonce && claims.nonce !== params.expectedNonce) return null;

  return claims;
}
