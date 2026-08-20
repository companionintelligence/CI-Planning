import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W11 — SchedulingPrefsType end-to-end over HTTP. Proves the grouped
 * read shape, the PATCH-preserve write semantics (reusing the SAME services/prefs.ts
 * path routes/prefs.ts calls, cross-checked via REST GET), the recurrence-horizon
 * validation + auto-prune-on-shorten side effect (mirrors recurrence-horizon.test.ts,
 * but driven through the GraphQL mutation), viewPrefs round-trip/validation, and
 * cross-owner isolation.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  return { status: res.status, body };
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('W11 — SchedulingPrefsType query', () => {
  it('returns the grouped shape for the owner (id = owner id)', async () => {
    const r = await gql(`{
      schedulingPrefs {
        id
        timezone
        timeSenseEnabled
        viewPrefs
        capacityHoursPerWeek
        limits { maxFocusBlockMinutes minBreakMinutes maxTimeBlockMinutes minTimeBlockMinutes defaultTimeBlockMinutes conceptDefaultMinutes }
        planning { horizonDays recurrenceHorizonDays }
        models { fast quality embed }
        memory { syncEnabled syncCompleted syncHabits syncReflections account lastSyncedAt }
      }
    }`);
    expect(r.body.errors).toBeUndefined();
    const p = r.body.data.schedulingPrefs;
    expect(p.id).toBe(OWNER);
    expect(p.timezone).toBe('UTC'); // resetDb pins this
    expect(p.timeSenseEnabled).toBe(false);
    expect(p.viewPrefs).toBeNull();
    expect(p.capacityHoursPerWeek).toBe(56); // 0156 default (8h/day x 7)
    expect(p.limits).toEqual({
      maxFocusBlockMinutes: 90,
      minBreakMinutes: 10,
      maxTimeBlockMinutes: 240,
      minTimeBlockMinutes: 15,
      defaultTimeBlockMinutes: 60,
      conceptDefaultMinutes: 60,
    });
    expect(p.planning).toEqual({ horizonDays: 7, recurrenceHorizonDays: 7 });
    expect(p.models).toEqual({ fast: null, quality: null, embed: null });
    expect(p.memory).toEqual({
      syncEnabled: false, syncCompleted: true, syncHabits: true, syncReflections: true, account: null, lastSyncedAt: null,
    });
  });
});

describe('W11 — updateSchedulingPrefs', () => {
  it('round-trips a field in each group, visible via REST GET', async () => {
    const m = await gql(`mutation {
      updateSchedulingPrefs(input: {
        capacityHoursPerWeek: 40
        limits: { minBreakMinutes: 15 }
        planning: { horizonDays: 10 }
        models: { fast: "llama3.2" }
        memory: { syncEnabled: true, account: "acct-1" }
      }) {
        success
        pruned
        prefs { capacityHoursPerWeek limits { minBreakMinutes } planning { horizonDays } models { fast } memory { syncEnabled account } }
      }
    }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.updateSchedulingPrefs).toEqual({
      success: true,
      pruned: null,
      prefs: {
        capacityHoursPerWeek: 40,
        limits: { minBreakMinutes: 15 },
        planning: { horizonDays: 10 },
        models: { fast: 'llama3.2' },
        memory: { syncEnabled: true, account: 'acct-1' },
      },
    });

    const rest = await api(srv.url, '/api/prefs');
    expect(rest.body.prefs.capacity_hours_per_week).toBe(40);
    expect(rest.body.prefs.min_break_minutes).toBe(15);
    expect(rest.body.prefs.planning_horizon_days).toBe(10);
    expect(rest.body.prefs.fast_model).toBe('llama3.2');
    expect(rest.body.prefs.memory_sync_enabled).toBe(true);
    expect(rest.body.prefs.memory_account).toBe('acct-1');
  });

  it('an absent group/key leaves those columns unchanged (PATCH-preserve)', async () => {
    await gql('mutation { updateSchedulingPrefs(input: { capacityHoursPerWeek: 40 }) { success } }');
    const r = await gql('mutation { updateSchedulingPrefs(input: { limits: { minBreakMinutes: 20 } }) { prefs { capacityHoursPerWeek limits { minBreakMinutes } } } }');
    expect(r.body.data.updateSchedulingPrefs.prefs.capacityHoursPerWeek).toBe(40); // untouched by the second call
    expect(r.body.data.updateSchedulingPrefs.prefs.limits.minBreakMinutes).toBe(20);
  });

  describe('recurrenceHorizonDays validation', () => {
    it('rejects a value outside {7,15,30,60,90,180} (BAD_USER_INPUT) and does not persist it', async () => {
      const r = await gql('mutation { updateSchedulingPrefs(input: { planning: { recurrenceHorizonDays: 45 } }) { success } }');
      expect(r.body.errors?.[0]?.message).toMatch(/recurrenceHorizonDays/);
      expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      const after = await gql('{ schedulingPrefs { planning { recurrenceHorizonDays } } }');
      expect(after.body.data.schedulingPrefs.planning.recurrenceHorizonDays).toBe(7); // unchanged default
    });

    it('accepts an allowed value and persists it', async () => {
      const r = await gql('mutation { updateSchedulingPrefs(input: { planning: { recurrenceHorizonDays: 30 } }) { success prefs { planning { recurrenceHorizonDays } } } }');
      expect(r.body.data.updateSchedulingPrefs.prefs.planning.recurrenceHorizonDays).toBe(30);
    });
  });

  describe('viewPrefs', () => {
    const CAL = { calendar: { deselected: { direction: ['Home'], intention: [], category: ['Errands'] }, prio: [1, 2], topExpanded: true, bottomExpanded: false } };

    it('round-trips a real object via a JSON literal (not a string)', async () => {
      const query = `mutation { updateSchedulingPrefs(input: { viewPrefs: ${toGraphQLLiteral(CAL)} }) { prefs { viewPrefs } } }`;
      const m = await gql(query);
      expect(m.body.errors).toBeUndefined();
      expect(m.body.data.updateSchedulingPrefs.prefs.viewPrefs).toEqual(CAL);
      const after = await gql('{ schedulingPrefs { viewPrefs } }');
      expect(after.body.data.schedulingPrefs.viewPrefs).toEqual(CAL);
      expect(typeof after.body.data.schedulingPrefs.viewPrefs).toBe('object');
    });

    it('rejects a non-object viewPrefs (BAD_USER_INPUT) and does not persist it', async () => {
      for (const bad of ['[]', '"x"', '42', 'true']) {
        const r = await gql(`mutation { updateSchedulingPrefs(input: { viewPrefs: ${bad} }) { success } }`);
        expect(r.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      }
      const after = await gql('{ schedulingPrefs { viewPrefs } }');
      expect(after.body.data.schedulingPrefs.viewPrefs).toBeNull();
    });

    it('can be cleared back to null', async () => {
      await gql(`mutation { updateSchedulingPrefs(input: { viewPrefs: ${toGraphQLLiteral(CAL)} }) { success } }`);
      const r = await gql('mutation { updateSchedulingPrefs(input: { viewPrefs: null }) { prefs { viewPrefs } } }');
      expect(r.body.data.updateSchedulingPrefs.prefs.viewPrefs).toBeNull();
    });
  });

  describe('auto-prune on shorten', () => {
    it('lowering recurrenceHorizonDays triggers the SAME prune REST does', async () => {
      // Raise the horizon first (mirrors recurrence-horizon.test.ts), materialize a
      // daily recurring block across it, then shorten via the GraphQL mutation.
      //
      // Dates are RELATIVE TO TODAY on purpose. This fixture used to hard-code
      // 2026-06-15 → 2026-07-25 against a horizon that rolls forward from the current
      // day; the two only overlapped by >7 days while real time stayed on the near side
      // of 2026-07-19, then the test began failing every run with "expected 7 to be
      // greater than 7" on commits that changed nothing. Anchor on today and the overlap
      // is the full horizon forever.
      const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      const dtstart = day(0);

      await gql('mutation { updateSchedulingPrefs(input: { planning: { recurrenceHorizonDays: 30 } }) { success } }');
      const created = await api(srv.url, '/api/blocks', {
        method: 'POST',
        json: {
          title: 'Deep Work', block_kind: 'timeblock', block_type: 'scheduled', tag: 'focus',
          start_at: `${dtstart}T09:00:00.000Z`, end_at: `${dtstart}T11:00:00.000Z`, recurrence_rule: 'FREQ=DAILY',
        },
      });
      const tpl = created.body.block;
      const wide = await api(srv.url, `/api/blocks?from=${dtstart}T00:00:00.000Z&to=${day(40)}T23:59:00.000Z`);
      expect(wide.status).toBe(200);
      const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE recurrence_parent_id = ?`).get(tpl.id) as { n: number }).n;
      expect(before).toBeGreaterThan(7); // materialized under the 30-day horizon

      const r = await gql('mutation { updateSchedulingPrefs(input: { planning: { recurrenceHorizonDays: 7 } }) { success pruned } }');
      expect(r.body.errors).toBeUndefined();
      expect(r.body.data.updateSchedulingPrefs.pruned).toBeGreaterThan(0);

      const after = (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE recurrence_parent_id = ?`).get(tpl.id) as { n: number }).n;
      expect(after).toBeLessThan(before);
      // Template itself survives — only instances beyond the new horizon are pruned.
      expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(tpl.id)).toBeTruthy();
    });
  });
});

describe('W11 — owner scoping', () => {
  it('another owner\'s schedulingPrefs/updateSchedulingPrefs never touches this owner\'s row', async () => {
    createOwner(OTHER); // seeds a cloned scheduling_prefs row for OTHER

    await gql('mutation { updateSchedulingPrefs(input: { capacityHoursPerWeek: 30 }) { success } }'); // as OWNER
    const otherPatch = await gql('mutation { updateSchedulingPrefs(input: { capacityHoursPerWeek: 70 }) { prefs { id capacityHoursPerWeek } } }', { 'x-test-owner': OTHER });
    expect(otherPatch.body.errors).toBeUndefined();
    expect(otherPatch.body.data.updateSchedulingPrefs.prefs.id).toBe(OTHER);
    expect(otherPatch.body.data.updateSchedulingPrefs.prefs.capacityHoursPerWeek).toBe(70);

    // OWNER's row is untouched by OTHER's mutation.
    const mine = await gql('{ schedulingPrefs { id capacityHoursPerWeek } }');
    expect(mine.body.data.schedulingPrefs.id).toBe(OWNER);
    expect(mine.body.data.schedulingPrefs.capacityHoursPerWeek).toBe(30);

    // Direct DB check for good measure.
    const row = sqlite.prepare(`SELECT capacity_hours_per_week FROM scheduling_prefs WHERE owner_id = ?`).get(OWNER) as { capacity_hours_per_week: number };
    expect(row.capacity_hours_per_week).toBe(30);
  });
});

/** Render a plain JS value as a GraphQL input literal (object/array/string/number/boolean/null). */
function toGraphQLLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(toGraphQLLiteral).join(', ')}]`;
  if (typeof v === 'object') {
    return `{ ${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}: ${toGraphQLLiteral(val)}`).join(', ')} }`;
  }
  return 'null';
}
