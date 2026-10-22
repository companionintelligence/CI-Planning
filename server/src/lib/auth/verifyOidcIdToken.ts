import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Shared OIDC id_token verification (U1). Extracted verbatim from the proven Google
 * implementation (routes/oauth.ts, WP2/I1) and parameterized over issuer/audience/
 * JWKS so the CI-Portal login (U1), the memory connector (AA0b) and the Google
 * connector verify id_tokens through ONE piece of security-sensitive code instead of
 * three copies. No new dependency — hand-rolled over node:crypto.
 *
 * Two signature algorithms, and only two:
 *   - RS256  — RSA JWK (`kty: RSA`); what Google issues.
 *   - EdDSA  — Ed25519 JWK (`kty: OKP`, `crv: Ed25519`); what CI-Portal issues.
 *     CI-Portal runs better-auth's `jwt()` plugin with its default key config, which
 *     is Ed25519, and its live JWKS carries ONLY such a key. Until this verifier
 *     learned EdDSA every real CI-Portal login failed with `invalid_id_token` — the
 *     fixture portal issued RS256, which is why the end-to-end tests never saw it.
 * `alg:none`, HS*, ES*, PS*, Ed448 … are all rejected. The header `alg` decides which
 * key SHAPE may verify it, so a key of one kind can never be driven through the other
 * algorithm (the classic alg-confusion attacks need exactly that).
 *
 * Returns the claims ONLY if:
 *  - the token is a well-formed 3-segment JWT whose header says RS256 or EdDSA,
 *  - its signature checks against a JWKS key of the matching shape (matched by `kid`
 *    when present),
 *  - `iss` is in the caller's allow-list,
 *  - `aud` CONTAINS the caller's audience (the client_id), with `azp` naming us as the
 *    authorized party whenever the token is addressed to more than one audience,
 *  - `exp` is in the future and `nbf`/`iat` are not, each within one minute of skew,
 *  - `nonce` matches, when the caller expects one.
 * Anything else returns null — a tampered/forged token can NEVER establish identity.
 */

export interface OidcClaims {
  iss?: string;
  /** OIDC allows a single audience OR an array of them (§3.1.3.7). */
  aud?: string | string[];
  /** Authorized party — which client the token was actually minted FOR. */
  azp?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  name?: string;
  nonce?: string;
  [k: string]: unknown;
}

/**
 * Tokens are stamped by the PROVIDER's clock, so a small mutual drift is expected rather
 * than suspicious; 60s is the conventional allowance. It is applied in the forgiving
 * direction on each bound — a token that just expired against a fast local clock still
 * verifies, and one issued a moment "in the future" by a slow one is not rejected.
 */
const CLOCK_SKEW_S = 60;

/**
 * OIDC Core §3.1.3.7 (3)–(5). `aud` may be a lone string or an array, and must CONTAIN
 * our client_id — the previous `claims.aud !== audience` rejected every array outright,
 * which is spec-legal and would break on any provider that issues one.
 *
 * `azp` is the other half and matters more: when a token names several audiences, it was
 * minted for ONE client and merely lists the others. Without checking `azp`, a token
 * issued to a DIFFERENT client at the same provider that happens to include us in its
 * `aud` would verify here and log that user in. A present-but-mismatched `azp` is
 * rejected even for a single `aud` — the stricter reading of "if present, it SHOULD be
 * the client_id", and free to enforce.
 */
function audienceOk(claims: OidcClaims, audience: string | undefined): boolean {
  if (!audience) return false; // no configured client_id ⇒ nothing to verify against
  const auds = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (auds.length === 0 || !auds.every((a) => typeof a === 'string')) return false;
  if (!auds.includes(audience)) return false;
  if (auds.length > 1 && claims.azp !== audience) return false; // multi-aud REQUIRES azp
  if (claims.azp !== undefined && claims.azp !== audience) return false;
  return true;
}

/**
 * `exp` is required and enforced with {@link CLOCK_SKEW_S} of leeway. `nbf` and `iat` are
 * optional, but when present must not be meaningfully in the FUTURE: a not-yet-valid
 * token is not valid yet, and a future `iat` is a hallmark of a fabricated or replayed
 * token rather than of clock drift.
 */
function temporalOk(claims: OidcClaims, nowS: number): boolean {
  if (typeof claims.exp !== 'number') return false;
  if (claims.exp + CLOCK_SKEW_S <= nowS) return false;
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) return false;
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) return false;
  return true;
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
  /** RSA (RS256) */
  n?: string;
  e?: string;
  /** OKP (EdDSA) */
  crv?: string;
  x?: string;
}

/**
 * The two accepted JOSE algorithms, each pinned to the one JWK shape it may verify with
 * and the node:crypto digest that drives it (`null` ⇒ Ed25519's built-in, pure-EdDSA
 * mode; node refuses any other digest for an Ed25519 key, which is the point).
 *
 * A key is a candidate for a token only if its SHAPE matches the token's `alg` — and
 * if the JWK itself names an `alg` or `use`, those must agree too. A JWKS that says a
 * key is for RS256 never verifies an EdDSA token, and vice versa, even when the raw
 * bytes would let node try.
 */
const ALGS = {
  RS256: {
    digest: 'RSA-SHA256' as const,
    keyFits: (k: Jwk) => k.kty === 'RSA' && !!k.n && !!k.e,
  },
  EdDSA: {
    digest: null,
    keyFits: (k: Jwk) => k.kty === 'OKP' && k.crv === 'Ed25519' && !!k.x,
  },
} as const;
type SupportedAlg = keyof typeof ALGS;

function isSupportedAlg(alg: unknown): alg is SupportedAlg {
  return typeof alg === 'string' && Object.prototype.hasOwnProperty.call(ALGS, alg);
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

  let header: { alg?: unknown; kid?: unknown };
  let claims: OidcClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  // Reject anything that isn't one of the two asymmetric signatures (notably alg=none).
  if (!isSupportedAlg(header.alg)) return null;
  const alg = ALGS[header.alg];
  if (!signatureB64) return null;

  const jwks = await fetchJwks(params.jwksUri);
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const candidates = (kid ? jwks.filter((k) => k.kid === kid) : jwks).filter(
    (k) => alg.keyFits(k) && (k.alg === undefined || k.alg === header.alg) && (k.use === undefined || k.use === 'sig'),
  );
  if (candidates.length === 0) return null;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, 'base64url');

  let signatureValid = false;
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk as object, format: 'jwk' });
      if (cryptoVerify(alg.digest, signingInput, key, signature)) {
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
  if (!audienceOk(claims, params.audience)) return null;
  if (!temporalOk(claims, Date.now() / 1000)) return null;
  if (params.expectedNonce && claims.nonce !== params.expectedNonce) return null;

  return claims;
}
