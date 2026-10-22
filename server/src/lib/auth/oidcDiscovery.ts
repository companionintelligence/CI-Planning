/**
 * OIDC discovery (U1 alignment). CI-Portal — like every consumer, e.g. CI-Import-Tools
 * — is discovery-driven: given an `issuer`, everything else comes from
 * `<issuer>/.well-known/openid-configuration`. We fetch it, cache it briefly, and read
 * the authorize/token/JWKS endpoints AND the canonical `issuer` claim from the document.
 *
 * The `issuer` claim matters (better-auth quirk): Companion Portal serves discovery at
 * `https://hub.ci.computer/api/auth` but the id_token `iss` claim is the BARE ORIGIN
 * `https://hub.ci.computer` (same shape on the staging/dev origins). The callback must
 * validate `iss` against `doc.issuer` (returned here), never against the configured
 * discovery URL.
 *
 * No new dependency — plain `fetch` + a Map cache (mirrors the Google connector's
 * hand-rolled JWKS style rather than pulling in `jose`).
 */

export interface OidcDiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

const TTL_MS = 60 * 60 * 1000; // 1h, matching CI-Import-Tools
const TIMEOUT_MS = 5_000; // fail fast if the issuer is slow/unreachable (aligns with the Ollama client)
const cache = new Map<string, { at: number; doc: OidcDiscoveryDoc }>();

/**
 * Every URL we take from the document must live on the SAME ORIGIN we fetched it from.
 *
 * The document is retrieved from the operator-configured `CIPORTAL_ISSUER`, but its
 * CONTENTS are provider-supplied — so without this the doc is an open redirect into the
 * heart of the flow: `token_endpoint` receives the authorization code and PKCE verifier,
 * and `jwks_uri` decides which key is allowed to sign an identity we then trust. A doc
 * that had been tampered with (or served by a compromised/hijacked issuer host) could
 * point either at an attacker and the flow would follow it. Anchoring on the origin the
 * operator configured means a rogue document can only ever redirect within that host.
 *
 * Compared against the FETCH origin rather than `doc.issuer`, because `doc.issuer` is
 * provider-controlled too and could simply be forged to match the endpoints.
 *
 * This is stricter than OIDC requires — the spec permits, for example, a cross-host
 * `jwks_uri` (Google does exactly that). It is safe here because discovery is used ONLY
 * for CI-Portal, which serves everything from one origin; the Google connector uses its
 * own hardcoded endpoints and never reaches this code. A provider that genuinely needs
 * cross-origin endpoints still has the documented escape hatch: set all three
 * `CIPORTAL_AUTHORIZE_URI`/`CIPORTAL_TOKEN_URI`/`CIPORTAL_JWKS_URI` overrides, which
 * bypass discovery entirely.
 */
function assertSameOrigin(field: string, value: string, expectedOrigin: string): void {
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(`OIDC discovery document has a malformed ${field}: ${value}`);
  }
  if (origin !== expectedOrigin) {
    throw new Error(
      `OIDC discovery document ${field} points off-origin (${origin} ≠ ${expectedOrigin}); refusing to follow it`,
    );
  }
}

/**
 * Fetch (and cache) the issuer's discovery document. Throws on network failure, a
 * document missing the required endpoints, or one whose endpoints point off-origin —
 * callers turn that into a 503. Nothing is cached unless it passed validation.
 */
export async function discoverOidc(issuer: string): Promise<OidcDiscoveryDoc> {
  const key = issuer.replace(/\/$/, '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.doc;

  const url = `${key}/.well-known/openid-configuration`;
  // Bounded fetch: a slow/unreachable issuer must not hang /api/auth/ciportal/start.
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${url} → HTTP ${res.status}`);
  const doc = (await res.json()) as OidcDiscoveryDoc;
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document missing required fields (issuer/authorization_endpoint/token_endpoint/jwks_uri)');
  }
  // Validated BEFORE the cache write, so a rejected document can't be served for an hour.
  const expectedOrigin = new URL(key).origin;
  assertSameOrigin('issuer', doc.issuer, expectedOrigin);
  assertSameOrigin('authorization_endpoint', doc.authorization_endpoint, expectedOrigin);
  assertSameOrigin('token_endpoint', doc.token_endpoint, expectedOrigin);
  assertSameOrigin('jwks_uri', doc.jwks_uri, expectedOrigin);
  cache.set(key, { at: Date.now(), doc });
  return doc;
}

/** Test-only: drop the discovery cache so tests don't leak a stubbed doc into each other. */
export function __resetOidcDiscoveryCache(): void {
  cache.clear();
}
