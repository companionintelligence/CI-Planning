import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, api, type TestServer } from './helpers.js';

describe('settings / prefs API', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());

  it('GET /api/prefs returns the seeded scheduling prefs', async () => {
    const { status, body } = await api(server.url, '/api/prefs');
    expect(status).toBe(200);
    expect(body.prefs).toBeTruthy();
    expect(body.prefs.workday_start).toBeTruthy();
    expect(body.prefs.workday_end).toBeTruthy();
    expect(body.prefs.planning_mode).toBeTruthy();
  });

  it('PATCH /api/prefs updates and persists work hours + planning mode', async () => {
    const patch = await api(server.url, '/api/prefs', {
      method: 'PATCH',
      json: { workday_start: '08:00', workday_end: '17:30', max_focus_block_minutes: 120, planning_mode: 'smart' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.prefs.workday_start).toBe('08:00');
    expect(patch.body.prefs.max_focus_block_minutes).toBe(120);
    expect(patch.body.prefs.planning_mode).toBe('smart');

    // Confirm it persisted.
    const get = await api(server.url, '/api/prefs');
    expect(get.body.prefs.workday_start).toBe('08:00');
    expect(get.body.prefs.workday_end).toBe('17:30');
    expect(get.body.prefs.planning_mode).toBe('smart');
  });

  it('GET /api/llm/status reports availability + configured models', async () => {
    const { status, body } = await api(server.url, '/api/llm/status');
    expect(status).toBe(200);
    expect(body).toHaveProperty('available');
    expect(Array.isArray(body.models)).toBe(true);
    expect(typeof body.fastModel).toBe('string');
  });

  // The "Re-check" path. This asserts the ROUTE contract only: `?fresh=1` is accepted and
  // answers the same shape as the plain call. It deliberately does NOT prove cache-busting —
  // the probe cache is disabled under NODE_ENV=test (`cacheable` in mcp/ollama.ts), so every
  // call here probes regardless of the flag. The cache semantics are proven where they can
  // be: ollama.test.ts stubs fetch and counts /api/tags hits under a production NODE_ENV
  // ("two calls inside the TTL issue ONE /api/tags fetch; fresh:true issues a second").
  it('GET /api/llm/status?fresh=1 answers the same shape', async () => {
    const { status, body } = await api(server.url, '/api/llm/status?fresh=1');
    expect(status).toBe(200);
    expect(body).toHaveProperty('available');
    expect(typeof body.fastModel).toBe('string');
  });

  it('GET /api/integrations reports Ollama + Google modes', async () => {
    const { status, body } = await api(server.url, '/api/integrations');
    expect(status).toBe(200);
    expect(body.ollama).toBeTruthy();
    expect(body.google.mode).toBe('fixture');
  });
});
