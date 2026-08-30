import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

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
    const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { capacity_hours_per_week: 40 } });
    expect(r.status).toBe(200);
    expect(r.body.prefs.capacity_hours_per_week).toBe(40);
    expect((await api(srv.url, '/api/prefs')).body.prefs.capacity_hours_per_week).toBe(40);
  });

  // 0164 (balance-targets wave, bal-2) — bias gate, default ON.
  describe('balance_bias_enabled', () => {
    it('defaults to true when never patched', async () => {
      expect((await api(srv.url, '/api/prefs')).body.prefs.balance_bias_enabled).toBe(true);
    });

    it('round-trips false: save false → reload → false', async () => {
      const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { balance_bias_enabled: false } });
      expect(r.status).toBe(200);
      expect(r.body.prefs.balance_bias_enabled).toBe(false);
      expect((await api(srv.url, '/api/prefs')).body.prefs.balance_bias_enabled).toBe(false);
    });
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

  // Cross-device calendar view-state (0111) — a JSON blob stored as TEXT but
  // exposed/accepted as a nested object.
  describe('view_prefs (calendar UI view-state)', () => {
    const CAL = {
      calendar: {
        deselected: { direction: ['Home'], intention: [], category: ['Errands'] },
        prio: [1, 2],
        topExpanded: true,
        bottomExpanded: false,
      },
    };

    it('is null by default (no saved view state)', async () => {
      expect((await api(srv.url, '/api/prefs')).body.prefs.view_prefs).toBeNull();
    });

    it('round-trips a view_prefs object as a parsed object (not a string)', async () => {
      const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { view_prefs: CAL } });
      expect(r.status).toBe(200);
      expect(r.body.prefs.view_prefs).toEqual(CAL); // PATCH response already parsed
      const after = (await api(srv.url, '/api/prefs')).body.prefs.view_prefs;
      expect(after).toEqual(CAL); // and it persists across a fresh GET
      expect(typeof after).toBe('object');
    });

    it('rejects a non-object view_prefs (422) and does not persist it', async () => {
      for (const bad of [[], 'x', 42, true]) {
        const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { view_prefs: bad } });
        expect(r.status).toBe(422);
      }
      expect((await api(srv.url, '/api/prefs')).body.prefs.view_prefs).toBeNull();
    });

    it('can be cleared back to null', async () => {
      await api(srv.url, '/api/prefs', { method: 'PATCH', json: { view_prefs: CAL } });
      const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { view_prefs: null } });
      expect(r.status).toBe(200);
      expect(r.body.prefs.view_prefs).toBeNull();
    });

    it('is owner-scoped — patching the system owner never touches a second owner', async () => {
      createOwner(); // seeds a scheduling_prefs row for SECOND_OWNER_ID with view_prefs NULL
      await api(srv.url, '/api/prefs', { method: 'PATCH', json: { view_prefs: CAL } });
      // The HTTP request runs as SYSTEM_OWNER; assert the other owner's row is untouched.
      const otherRow = sqlite
        .prepare(`SELECT view_prefs FROM scheduling_prefs WHERE owner_id = ?`)
        .get(SECOND_OWNER_ID) as { view_prefs: string | null } | undefined;
      expect(otherRow?.view_prefs ?? null).toBeNull();
      // ...and the system owner's own row did get it.
      expect((await api(srv.url, '/api/prefs')).body.prefs.view_prefs).toEqual(CAL);
    });

    it('recovers gracefully from a malformed stored blob (returns null, never throws)', async () => {
      sqlite.prepare(`UPDATE scheduling_prefs SET view_prefs = ? WHERE owner_id = ?`).run('{not json', SYSTEM_OWNER);
      const r = await api(srv.url, '/api/prefs');
      expect(r.status).toBe(200);
      expect(r.body.prefs.view_prefs).toBeNull();
    });
  });
});
