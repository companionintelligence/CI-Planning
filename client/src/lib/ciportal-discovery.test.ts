import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetCiPortalDiscoveryCache,
  discoverCiPortal,
  normalizeIssuer,
  validateDiscovery,
} from './ciportal-discovery.js';

/**
 * The Portal's OAuth server discovery, as the client does it. The fetch is stubbed, so this runs
 * in the node `unit` project and checks the decisions: what is accepted, what is refused, and what
 * is cached.
 */

const PORTAL = 'https://hub.ci.computer/api/auth';
const DISCOVERY_URL = `${PORTAL}/.well-known/openid-configuration`;

const GOOD = {
  issuer: 'https://hub.ci.computer',
  authorization_endpoint: 'https://hub.ci.computer/api/auth/oauth2/authorize',
  token_endpoint: 'https://hub.ci.computer/api/auth/oauth2/token',
  jwks_uri: 'https://hub.ci.computer/api/auth/jwks',
  userinfo_endpoint: 'https://hub.ci.computer/api/auth/oauth2/userinfo',
  end_session_endpoint: 'https://hub.ci.computer/api/auth/oauth2/end-session',
};

function answering(body: unknown, init: ResponseInit = {}) {
  return vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    }),
  );
}

beforeEach(() => __resetCiPortalDiscoveryCache());

describe('normalizeIssuer', () => {
  it('drops trailing slashes', () => {
    expect(normalizeIssuer('https://hub.ci.computer/api/auth/')).toBe(PORTAL);
  });

  it('allows plain http only for a loopback host (development)', () => {
    expect(normalizeIssuer('http://localhost:8787/api/auth')).toBe('http://localhost:8787/api/auth');
    expect(() => normalizeIssuer('http://hub.example.com/api/auth')).toThrow(/must use https/);
  });

  it('refuses an address that carries credentials, and anything that is not a URL', () => {
    expect(() => normalizeIssuer('https://user:secret@hub.ci.computer')).toThrow(/username or password/);
    expect(() => normalizeIssuer('not a url')).toThrow(/not a URL/);
  });
});

describe('validateDiscovery', () => {
  it('accepts a document whose endpoints share the origin it was fetched from', () => {
    expect(validateDiscovery(GOOD, DISCOVERY_URL)).toEqual(GOOD);
  });

  it('refuses a token endpoint on another origin, since it receives the code and the verifier', () => {
    const doc = { ...GOOD, token_endpoint: 'https://attacker.example/token' };
    expect(() => validateDiscovery(doc, DISCOVERY_URL)).toThrow(/token_endpoint points off-origin/);
  });

  it('refuses a document with no token endpoint, and one whose field is not a URL', () => {
    const { token_endpoint: _omitted, ...missing } = GOOD;
    expect(() => validateDiscovery(missing, DISCOVERY_URL)).toThrow(/missing token_endpoint/);
    expect(() => validateDiscovery({ ...GOOD, jwks_uri: 'not a url' }, DISCOVERY_URL)).toThrow(
      /malformed jwks_uri/,
    );
  });

  it('accepts a document that leaves the optional endpoints out', () => {
    const minimal = {
      issuer: GOOD.issuer,
      authorization_endpoint: GOOD.authorization_endpoint,
      token_endpoint: GOOD.token_endpoint,
    };
    expect(validateDiscovery(minimal, DISCOVERY_URL)).toEqual(minimal);
  });
});

describe('discoverCiPortal', () => {
  it('fetches the discovery document under the Portal address and returns its endpoints', async () => {
    const fetch = answering(GOOD);
    const doc = await discoverCiPortal(PORTAL, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(DISCOVERY_URL);
    expect(doc.authorization_endpoint).toBe(GOOD.authorization_endpoint);
    expect(doc.token_endpoint).toBe(GOOD.token_endpoint);
  });

  it('keeps a document for an hour, then fetches it again', async () => {
    const fetch = answering(GOOD);
    let clock = 0;
    const now = () => clock;
    await discoverCiPortal(PORTAL, { fetch, now });
    clock = 59 * 60 * 1000;
    await discoverCiPortal(PORTAL, { fetch, now });
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = 61 * 60 * 1000;
    await discoverCiPortal(PORTAL, { fetch, now });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not keep a document that fails the checks, so the next try fetches it again', async () => {
    const bad = answering({ ...GOOD, token_endpoint: 'https://attacker.example/token' });
    await expect(discoverCiPortal(PORTAL, { fetch: bad })).rejects.toThrow(/off-origin/);
    const good = answering(GOOD);
    await expect(discoverCiPortal(PORTAL, { fetch: good })).resolves.toMatchObject({
      token_endpoint: GOOD.token_endpoint,
    });
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the Portal does not answer at all', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await expect(discoverCiPortal(PORTAL, { fetch })).rejects.toThrow(/did not answer/);
  });

  it('says plainly when the Portal answers with an error, or with something that is not JSON', async () => {
    await expect(discoverCiPortal(PORTAL, { fetch: answering({}, { status: 404 }) })).rejects.toThrow(
      /HTTP 404/,
    );
    const html = vi.fn(async () => new Response('<html>a sign-in page</html>', { status: 200 }));
    await expect(discoverCiPortal(PORTAL, { fetch: html })).rejects.toThrow(/not JSON/);
  });
});
