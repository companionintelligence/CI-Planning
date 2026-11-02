import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';

/**
 * Track D2 — the security headers app.ts sets on every response, and the two
 * policies (the app's, and the looser one for the vendored GraphiQL sandbox).
 */

let srv: TestServer;
const savedTrustProxy = config.trustProxy;
const savedExtra = config.security.extraConnectSrc;

beforeAll(async () => {
  config.trustProxy = true; // so X-Forwarded-Proto decides ctx.protocol (HSTS case)
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  config.trustProxy = savedTrustProxy;
  config.security.extraConnectSrc = savedExtra;
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${srv.url}${path}`, { headers });

describe('D2 — security headers', () => {
  it('sets the fixed headers and the app CSP on an API response', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';"); // no inline scripts, no eval
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    // Manrope is bundled with the client, so no font host is allowed.
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).toContain("font-src 'self' data:;");
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toMatch(/connect-src 'self'(;|$)/); // nothing extra by default
  });

  it('sends HSTS only when the request is HTTPS (X-Forwarded-Proto behind TRUST_PROXY)', async () => {
    expect((await get('/api/health')).headers.get('strict-transport-security')).toBeNull();
    const https = await get('/api/health', { 'X-Forwarded-Proto': 'https' });
    expect(https.headers.get('strict-transport-security')).toBe('max-age=15552000');
  });

  it('adds CSP_EXTRA_CONNECT_SRC origins to connect-src', async () => {
    config.security.extraConnectSrc = ['https://ingest.example.test', 'wss://relay.example.test'];
    try {
      const csp = (await get('/api/health')).headers.get('content-security-policy') ?? '';
      expect(csp).toContain("connect-src 'self' https://ingest.example.test wss://relay.example.test");
    } finally {
      config.security.extraConnectSrc = savedExtra;
    }
  });

  it('gives the GraphiQL sandbox its own looser policy, not the app one', async () => {
    const res = await get('/api/graphql/sandbox');
    expect(res.status).toBe(200); // on by default outside production, auth via test mode
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    // …and the app policy is unaffected on the next request.
    const app = (await get('/api/health')).headers.get('content-security-policy') ?? '';
    expect(app).not.toContain('unsafe-eval');
  });
});
