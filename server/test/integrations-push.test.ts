import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, api, type TestServer } from './helpers.js';

// Phase H (b): GET /api/integrations exposes whether Web Push is configured (VAPID keys
// present), so the client/diagnostics can show push as dormant rather than broken.
// VAPID keys are now auto-provisioned on first boot (services/vapid-config.ts), so with no
// env keypair pinned push reports configured=true out of the box.
let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('GET /api/integrations — push status', () => {
  it('reports push.configured true (VAPID auto-generated on boot)', async () => {
    const r = await api(srv.url, '/api/integrations');
    expect(r.status).toBe(200);
    expect(typeof r.body.push?.configured).toBe('boolean');
    expect(r.body.push.configured).toBe(true);
  });
});
