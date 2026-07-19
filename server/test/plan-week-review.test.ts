import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { priorWeekAnchor, defaultAnchorForOwner } from '../src/services/plan-week-review.js';
import type { PlanWeekReview } from '../src/services/plan-week-review.js';
import { localDateInTZ } from '../src/lib/tz.js';

/**
 * FTUE · T5 (#341) — the deterministic weekly recap.
 *
 * The aggregation adds no stats SQL of its own, so these tests pin the things it DOES
 * own: the default anchor, validation, owner scoping, the week-range filter on T1's
 * sessions, and — most importantly — that extracting globalCalibrationReadout left
 * GET /api/calibration byte-identical.
 */

describe('priorWeekAnchor', () => {
  it('lands seven days back, pivoting at noon UTC', () => {
    expect(priorWeekAnchor('2026-07-18')).toBe('2026-07-11');
    expect(priorWeekAnchor('2026-01-05')).toBe('2025-12-29'); // across a year boundary
    expect(priorWeekAnchor('2026-03-09')).toBe('2026-03-02'); // across a DST shift
  });
});

/**
 * The default anchor must follow the OWNER's calendar, not the server's. A one-day
 * difference becomes a WHOLE-WEEK error here, because the anchor is snapped to Mon→Sun:
 * an owner just past midnight would otherwise be handed the week before last, and one
 * just before midnight their own in-progress week — the very thing the prior-week anchor
 * exists to avoid.
 */
describe('defaultAnchorForOwner — owner timezone, not the server clock', () => {
  beforeEach(() => resetDb());

  const setTz = (tz: string) =>
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(tz, SYSTEM_OWNER);

  it('derives today in the owner zone, so far-east and far-west owners can differ by a week', () => {
    setTz('Pacific/Auckland');
    const east = defaultAnchorForOwner(SYSTEM_OWNER);
    setTz('Pacific/Niue');
    const west = defaultAnchorForOwner(SYSTEM_OWNER);

    // Both must be real anchors...
    for (const a of [east, west]) expect(a).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // ...and each must be exactly 7 days before that owner's own today.
    setTz('Pacific/Auckland');
    expect(east).toBe(priorWeekAnchor(localDateInTZ(new Date().toISOString(), 'Pacific/Auckland')));
    setTz('Pacific/Niue');
    expect(west).toBe(priorWeekAnchor(localDateInTZ(new Date().toISOString(), 'Pacific/Niue')));

    // The two zones are ~23h apart, so they disagree about "today" for most of the day.
    // Whenever they do, the anchors must differ too — a server-clock default could not.
    const eastToday = localDateInTZ(new Date().toISOString(), 'Pacific/Auckland');
    const westToday = localDateInTZ(new Date().toISOString(), 'Pacific/Niue');
    if (eastToday !== westToday) expect(east).not.toBe(west);
  });
});

describe('GET /api/plan-week/review', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  const get = (q = '', headers?: Record<string, string>) =>
    api<PlanWeekReview>(server.url, `/api/plan-week/review${q}`, headers ? { headers } : undefined);

  it('defaults to the week that just ended and echoes the anchor it used', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.anchor).toBe(defaultAnchorForOwner(SYSTEM_OWNER));
    // The anchor must fall inside the returned week...
    expect(r.body.week.days).toContain(r.body.anchor);
    expect(r.body.week.days).toHaveLength(7);
    // ...and that week must be strictly in the past for this owner, never the current one.
    const ownerToday = localDateInTZ(new Date().toISOString(), 'UTC');
    expect(r.body.week.days[6] < ownerToday).toBe(true);
  });

  it('honours an explicit anchor and 422s a malformed one', async () => {
    const ok = await get('?anchor=2026-07-06');
    expect(ok.status).toBe(200);
    expect(ok.body.anchor).toBe('2026-07-06');
    expect(ok.body.week.days[0]).toBe('2026-07-06'); // that Monday

    for (const bad of ['?anchor=nope', '?anchor=2026-13-01', '?anchor=07-06-2026']) {
      expect((await get(bad)).status).toBe(422);
    }
  });

  it('composes every section without inventing stats', async () => {
    const r = (await get('?anchor=2026-07-06')).body;
    expect(Object.keys(r).sort()).toEqual(
      ['anchor', 'calibration', 'note_dates', 'sessions', 'stars', 'week'].sort(),
    );
    expect(r.calibration).toEqual({ calibrated: false, sample_count: 0 }); // no samples seeded
    expect(Array.isArray(r.stars)).toBe(true);
    expect(Array.isArray(r.note_dates)).toBe(true);
    expect(Array.isArray(r.sessions)).toBe(true);
  });

  it('includes only sessions started inside the anchored week', async () => {
    const mk = (id: string, startedAt: string) =>
      sqlite.prepare(
        `INSERT INTO planning_sessions (id, owner_id, started_at, entry_branch) VALUES (?, ?, ?, 'review')`,
      ).run(id, SYSTEM_OWNER, startedAt);

    mk('s-in', '2026-07-08T10:00:00.000Z');    // inside Mon 07-06 → Sun 07-12
    mk('s-edge-mon', '2026-07-06T00:00:01.000Z');
    mk('s-edge-sun', '2026-07-12T23:59:59.000Z');
    mk('s-before', '2026-07-05T10:00:00.000Z');
    mk('s-after', '2026-07-13T10:00:00.000Z');

    const ids = (await get('?anchor=2026-07-08')).body.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['s-edge-mon', 's-edge-sun', 's-in']);
  });

  it('is owner-scoped across every section', async () => {
    createOwner(SECOND_OWNER_ID);
    sqlite.prepare(
      `INSERT INTO planning_sessions (id, owner_id, started_at, entry_branch) VALUES ('s-theirs', ?, '2026-07-08T10:00:00.000Z', 'review')`,
    ).run(SECOND_OWNER_ID);

    const mine = (await get('?anchor=2026-07-08')).body;
    expect(mine.sessions).toEqual([]);

    const theirs = (await get('?anchor=2026-07-08', { 'x-test-owner': SECOND_OWNER_ID })).body;
    expect(theirs.sessions.map((s) => s.id)).toEqual(['s-theirs']);
  });
});

/**
 * The extraction guard. `globalCalibrationReadout` was lifted verbatim out of the
 * /api/calibration handler; if the two ever diverge, the legacy endpoint is the one that
 * silently changes shape for existing clients.
 */
describe('GET /api/calibration is unchanged by the T5 extraction', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  const seed = (over: Record<string, unknown> = {}) => {
    const row = {
      owner_id: SYSTEM_OWNER, scope_kind: 'global', scope_ref: '',
      computed_at: '2026-07-10T00:00:00.000Z', sample_count: 12,
      bias_ratio: 1.25, p25: 20, p50: 30, p75: 45, ...over,
    };
    const keys = Object.keys(row);
    sqlite.prepare(
      `INSERT OR REPLACE INTO estimate_calibration (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...keys.map((k) => (row as Record<string, unknown>)[k]));
  };

  it('returns the uncalibrated shape when there is no usable row', async () => {
    const r = await api(server.url, '/api/calibration');
    expect(r.body).toEqual({ calibrated: false, sample_count: 0 });
  });

  it('returns the full readout, and the aggregation returns exactly the same object', async () => {
    seed();
    const legacy = await api<Record<string, unknown>>(server.url, '/api/calibration');
    expect(legacy.body).toEqual({
      calibrated: true, sample_count: 12, bias_ratio: 1.25,
      p25: 20, p50: 30, p75: 45, computed_at: '2026-07-10T00:00:00.000Z',
      label: 'You tend to take 25% longer than estimated',
    });

    // Same source of truth ⇒ the recap must not paraphrase it differently.
    const agg = await api<PlanWeekReview>(server.url, '/api/plan-week/review');
    expect(agg.body.calibration).toEqual(legacy.body);
  });

  it('keeps the shorter/accurate label branches', async () => {
    seed({ bias_ratio: 0.8 });
    expect((await api<{ label: string }>(server.url, '/api/calibration')).body.label)
      .toBe('You tend to take 20% shorter than estimated');

    seed({ bias_ratio: 1 });
    expect((await api<{ label: string }>(server.url, '/api/calibration')).body.label)
      .toBe('Your estimates are accurate');
  });
});
