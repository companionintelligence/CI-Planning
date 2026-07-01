import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * GET/PATCH /api/prefs — snake_case round-trip + the Phase-P recurrence_horizon_days
 * validation (the auto-prune side-effect is covered in recurrence-horizon.test.ts).
 */
const OWNER = SYSTEM_OWNER;
let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('GET/PATCH /api/prefs', () => {
  it('returns the owner prefs', async () => {
    const r = await api(srv.url, '/api/prefs');
    expect(r.status).toBe(200);
    expect(r.body.prefs.owner_id).toBe(OWNER);
  });

  it('round-trips a patched field (snake_case in and out)', async () => {
    const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { workday_start: '08:30' } });
    expect(r.status).toBe(200);
    expect(r.body.prefs.workday_start).toBe('08:30');
    expect((await api(srv.url, '/api/prefs')).body.prefs.workday_start).toBe('08:30');
  });

  describe('recurrence_horizon_days validation', () => {
    it('rejects a value outside {7,15,30,60,90,180} (422) and does not persist it', async () => {
      const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { recurrence_horizon_days: 45 } });
      expect(r.status).toBe(422);
      expect((await api(srv.url, '/api/prefs')).body.prefs.recurrence_horizon_days).toBe(7); // unchanged default
    });
    it('accepts an allowed value and persists it', async () => {
      const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { recurrence_horizon_days: 30 } });
      expect(r.status).toBe(200);
      expect((await api(srv.url, '/api/prefs')).body.prefs.recurrence_horizon_days).toBe(30);
    });
  });
});
