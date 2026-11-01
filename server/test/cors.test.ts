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

  // The page origins of the mobile shells: iOS serves its bundle from capacitor://localhost,
  // Android from https://localhost. The shells call the server through the native HTTP stack,
  // which CORS does not apply to, so a stock server grants these two nothing. An operator who
  // wants a WebView to call it directly has to name them like any other origin.
  const SHELL_ORIGINS = ['capacitor://localhost', 'https://localhost'];

  it.each(SHELL_ORIGINS)('sets no CORS header for %s when the allowlist is empty (default)', async (origin) => {
    config.corsOrigins = [];
    const res = await fetch(`${srv.url}/api/auth/config`, { headers: { Origin: origin } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it.each(SHELL_ORIGINS)('echoes %s when it is named via CORS_ALLOWED_ORIGINS', async (origin) => {
    config.corsOrigins = [origin];
    const res = await fetch(`${srv.url}/api/auth/config`, { headers: { Origin: origin } });
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });
});
