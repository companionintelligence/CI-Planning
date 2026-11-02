/**
 * CI-Portal OAuth server discovery for the client. Like Companion Memory's OIDC client
 * (`@ci-tm/memory-client`, src/auth.ts), the Portal's endpoints come from its published
 * `/.well-known/openid-configuration`, not from configuration. The native sign-in flow uses
 * this to find the authorize and token endpoints before it starts the PKCE exchange.
 *
 * The rules are the server's (server/src/lib/auth/oidcDiscovery.ts), so a client and the
 * server accept the same document. Every endpoint must live on the origin the document was
 * fetched from, because the token endpoint receives the authorization code and the PKCE
 * verifier. A document is cached for an hour only after it passes these checks.
 */

export interface CiPortalDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

/** The one fetch this module needs, so tests can replace it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** Every field of the document that names a URL the client will use. */
const ENDPOINT_FIELDS = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'jwks_uri',
  'userinfo_endpoint',
  'end_session_endpoint',
] as const;

const cache = new Map<string, { at: number; doc: CiPortalDiscovery }>();

/**
 * The Portal address as the discovery base, without a trailing slash. Only https is accepted,
 * or plain http to a loopback host for development. An address that carries credentials is
 * refused: they do not belong in a stored or logged address.
 */
export function normalizeIssuer(address: string): string {
  const base = address.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`The Portal address is not a URL: ${address}`);
  }
  if (url.username || url.password) {
    throw new Error('The Portal address must not carry a username or password.');
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('The Portal address must use https (plain http is only for a loopback host).');
  }
  return base;
}

/**
 * Check a discovery document that was fetched from `fetchedFrom`. Throws with a plain reason
 * when a required field is missing, a field is malformed, or an endpoint points off-origin.
 */
export function validateDiscovery(doc: unknown, fetchedFrom: string): CiPortalDiscovery {
  if (typeof doc !== 'object' || doc === null) {
    throw new Error('The Portal discovery document is not an object.');
  }
  const record = doc as Record<string, unknown>;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`The Portal discovery document is missing ${field}.`);
    }
  }
  const origin = new URL(fetchedFrom).origin;
  for (const field of ENDPOINT_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    let endpointOrigin: string;
    try {
      endpointOrigin = new URL(String(value)).origin;
    } catch {
      throw new Error(`The Portal discovery document has a malformed ${field}.`);
    }
    if (endpointOrigin !== origin) {
      throw new Error(
        `The Portal discovery document's ${field} points off-origin (${endpointOrigin} ≠ ${origin}); refusing to follow it.`,
      );
    }
  }
  return record as unknown as CiPortalDiscovery;
}

/**
 * Fetch (and cache for an hour) the Portal's discovery document. Throws with a plain reason
 * when the Portal does not answer, answers with an error, sends something that is not JSON,
 * or sends a document that fails `validateDiscovery`. Nothing is cached unless it passed.
 */
export async function discoverCiPortal(
  address: string,
  options: { fetch?: FetchLike; now?: () => number } = {},
): Promise<CiPortalDiscovery> {
  const base = normalizeIssuer(address);
  const now = options.now ?? Date.now;
  const hit = cache.get(base);
  if (hit && now() - hit.at < TTL_MS) return hit.doc;

  const url = `${base}/.well-known/openid-configuration`;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`The Portal did not answer at ${url}. Check the address and your connection.`);
  }
  if (!response.ok) {
    throw new Error(`The Portal's discovery document is not available (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('The Portal answered, but its discovery document is not JSON.');
  }
  const doc = validateDiscovery(body, url);
  cache.set(base, { at: now(), doc });
  return doc;
}

/** Test-only: drop the cache so one test's document cannot leak into the next. */
export function __resetCiPortalDiscoveryCache(): void {
  cache.clear();
}
