/**
 * OIDC discovery (U1 alignment). CI-Portal — like every consumer, e.g. CI-Import-Tools
 * — is discovery-driven: given an `issuer`, everything else comes from
 * `<issuer>/.well-known/openid-configuration`. We fetch it, cache it briefly, and read
 * the authorize/token/JWKS endpoints AND the canonical `issuer` claim from the document.
 *
 * The `issuer` claim matters (better-auth quirk): CI-Portal serves discovery at
 * `https://hub.companionintelligence.com/api/auth` but the id_token `iss` claim is the
 * BARE ORIGIN `https://hub.companionintelligence.com`. The callback must validate `iss`
 * against `doc.issuer` (returned here), never against the configured discovery URL.
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
 * Fetch (and cache) the issuer's discovery document. Throws on network failure or a
 * document missing the required endpoints — callers turn that into a 503.
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
  cache.set(key, { at: Date.now(), doc });
  return doc;
}

/** Test-only: drop the discovery cache so tests don't leak a stubbed doc into each other. */
export function __resetOidcDiscoveryCache(): void {
  cache.clear();
}
