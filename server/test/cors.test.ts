import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';

/**
 * The API sits behind requireAuth, so a wildcard Access-Control-Allow-Origin would let
 * any page that gets a browser to attach valid credentials read authenticated JSON
 * cross-origin. Guards against that regressing, and confirms an operator-named origin
 * (CORS_ALLOWED_ORIGINS) is the only way in.
 */
describe('CORS', () => {
  let srv: TestServer;
  const savedCorsOrigins = config.corsOrigins;

  beforeAll(async () => {
    srv = await startTestServer();
  });

  afterAll(async () => {
    await srv.close();
  });

  afterEach(() => {
    config.corsOrigins = savedCorsOrigins;
  });

  it('never reflects a wildcard origin', async () => {
    const res = await fetch(`${srv.url}/api/auth/config`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('denies an origin not on the allowlist', async () => {
    config.corsOrigins = ['https://app.example'];
    const res = await fetch(`${srv.url}/api/auth/config`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows an origin explicitly named via CORS_ALLOWED_ORIGINS', async () => {
    config.corsOrigins = ['https://app.example'];
    const res = await fetch(`${srv.url}/api/auth/config`, {
      headers: { Origin: 'https://app.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  it('sets no CORS header at all when the allowlist is empty (default)', async () => {
    config.corsOrigins = [];
    const res = await fetch(`${srv.url}/api/auth/config`, {
      headers: { Origin: 'https://app.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
