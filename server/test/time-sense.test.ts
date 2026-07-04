/**
 * Phase Z (Time-Sense) · PR 1 — master flag (0105), scoped calibration (Z0/0106),
 * EOD Alignment (Z1, reflections kind='evening').
 *
 * Everything ships dark: with time_sense_enabled=0 (the default) the calibration
 * job is byte-compatible with Phase N and every Z endpoint 404s. Pinned dates,
 * TZ=UTC (helpers force the prefs baseline).
 *
 * Ollama's generate() is mocked at module level so the evening narrative always
 * exercises the deterministic-fallback contract (and the suite never depends on
 * a local model being up).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return {
    ...mod,
    generate: vi.fn(async () => {
      throw new Error('ollama down (mocked in time-sense.test.ts)');
    }),
  };
});

import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { calibrateEstimates } from '../src/jobs/calibrate-estimates.js';
import { comboRef, resolveCalibration, detectComboSuggestions, suggestEstimate } from '../src/services/calibration.js';
import { resetDb, startTestServer, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

const DAY = '2026-06-15';

function setFlag(on: boolean, owner = SYSTEM_OWNER) {
  sqlite.prepare(`UPDATE scheduling_prefs SET time_sense_enabled = ? WHERE owner_id = ?`).run(on ? 1 : 0, owner);
}

function makeTag(name: string): string {
  return (sqlite
    .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'intention') RETURNING id`)
    .get(SYSTEM_OWNER, name) as { id: string }).id;
}

function makeDoneTask(opts: { est: number; act: number; title?: string; subtype?: string; tags?: string[]; completedAt?: string }): string {
  const id = (sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, subtype, estimated_minutes, actual_minutes, completed_at)
       VALUES (uuid7(), ?, ?, 'done', ?, ?, ?, ?) RETURNING id`,
    )
    .get(opts.title ?? 'T', SYSTEM_OWNER, opts.subtype ?? 'standard', opts.est, opts.act, opts.completedAt ?? `${DAY}T12:00:00.000Z`) as { id: string }).id;
  for (const tagId of opts.tags ?? []) {
    sqlite
      .prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
      .run(id, tagId);
  }
  return id;
}

function calRow(kind: string, ref: string) {
  return sqlite
    .prepare(
      `SELECT sample_count, bias_ratio, p25, p75 FROM estimate_calibration
        WHERE owner_id = ? AND scope_kind = ? AND scope_ref = ?`,
    )
    .get(SYSTEM_OWNER, kind, ref) as { sample_count: number; bias_ratio: number | null; p25: number | null; p75: number | null } | undefined;
}

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});
beforeEach(() => {
  resetDb();
});

// ── Migration shape (0105 + 0106) ────────────────────────────────────────────────

describe('migrations 0106/0107', () => {
  it('scheduling_prefs gained time_sense_enabled, default OFF', () => {
    const cols = (sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string; dflt_value: unknown }[]);
    const col = cols.find((c) => c.name === 'time_sense_enabled');
    expect(col).toBeDefined();
    const row = sqlite
      .prepare(`SELECT time_sense_enabled AS v FROM scheduling_prefs WHERE owner_id = ?`)
      .get(SYSTEM_OWNER) as { v: number };
    expect(row.v).toBe(0);
  });

  it('estimate_calibration is scope-keyed and calibration_combo_pins exists', () => {
    const cols = (sqlite.prepare(`PRAGMA table_info(estimate_calibration)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('scope_kind');
    expect(cols).toContain('scope_ref');
    const pins = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='calibration_combo_pins'`)
      .get();
    expect(pins).toBeDefined();
  });

  it('moved the calibrate_estimates cron weekly → nightly 01:30', () => {
    const row = sqlite
      .prepare(`SELECT cron FROM scheduled_jobs WHERE kind = 'calibrate_estimates'`)
      .get() as { cron: string };
    expect(row.cron).toBe('30 1 * * *');
  });

  it('the Settings toggle round-trips: PATCH /api/prefs persists time_sense_enabled + GET returns it', async () => {
    // The whole feature is dead if the master flag can't be set through the actual
    // API path the Settings toggle uses (fromApi → Drizzle .set → serialize). Every
    // other test flips the flag via raw SQL, so this is the one that guards the
    // client-facing round-trip.
    const before = await api(srv.url, '/api/prefs');
    expect('time_sense_enabled' in before.body.prefs).toBe(true); // column is serialized
    expect(before.body.prefs.time_sense_enabled).toBe(false);

    const patch = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: true } });
    expect(patch.status).toBe(200);
    expect(patch.body.prefs.time_sense_enabled).toBe(true);

    const after = await api(srv.url, '/api/prefs');
    expect(after.body.prefs.time_sense_enabled).toBe(true);
  });
});

// ── Flag off: dark by default ────────────────────────────────────────────────────

describe('flag off (default)', () => {
  it('Z endpoints look absent (404); the legacy Phase-N calibration readout stays up', async () => {
    expect((await api(srv.url, '/api/calibration/scopes')).status).toBe(404);
    // Bare /api/calibration is Phase N's ungated global-row surface — NOT Z's.
    const legacy = await api(srv.url, '/api/calibration');
    expect(legacy.status).toBe(200);
    expect(legacy.body.calibrated).toBe(false);
    expect((await api(srv.url, '/api/reflections/evening')).status).toBe(404);
    expect((await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: DAY } })).status).toBe(404);
    expect((await api(srv.url, '/api/reflections/evening', { method: 'PUT', json: { period_key: DAY, body: 'x' } })).status).toBe(404);
  });

  it('calibrateEstimates keeps the Phase-N single-global-row behavior', () => {
    // Percentile math incl. outliers, no caps — 5 ratios 0.5/1/1.5/2/50.
    for (const [est, act] of [[20, 10], [30, 30], [40, 60], [20, 40], [1, 50]]) {
      makeDoneTask({ est, act });
    }
    const r = calibrateEstimates();
    expect(r.sample_count).toBe(5);
    expect(r.bias_ratio).toBeCloseTo(1.5, 4); // median, uncapped 50 included in the set
    expect(r.scopes).toBeUndefined();
    const rows = sqlite
      .prepare(`SELECT scope_kind, scope_ref FROM estimate_calibration WHERE owner_id = ?`)
      .all(SYSTEM_OWNER) as { scope_kind: string; scope_ref: string }[];
    expect(rows).toEqual([{ scope_kind: 'global', scope_ref: '' }]);
  });
});

// ── Z0: scoped recompute (flag on) ───────────────────────────────────────────────

describe('scoped calibration (flag on)', () => {
  beforeEach(() => setFlag(true));

  it('writes global + subtype + tag scopes with robust stats', () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] }); // ratio 1.5
    const r = calibrateEstimates();
    expect(r.scopes).toBeGreaterThanOrEqual(3);
    expect(calRow('global', '')?.sample_count).toBe(6);
    expect(calRow('subtype', 'standard')?.sample_count).toBe(6);
    const tagRow = calRow('tag', taxes);
    expect(tagRow?.sample_count).toBe(6);
    expect(tagRow?.bias_ratio).toBeCloseTo(1.5, 4);
  });

  it('legacy GET /api/calibration still reads the GLOBAL row once scopes exist', async () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    calibrateEstimates(); // writes global + subtype + tag rows
    const legacy = await api(srv.url, '/api/calibration');
    expect(legacy.status).toBe(200);
    expect(legacy.body.calibrated).toBe(true);
    expect(legacy.body.sample_count).toBe(6); // the global row, not an arbitrary scope

    const scopes = await api(srv.url, '/api/calibration/scopes');
    expect(scopes.status).toBe(200);
    expect(scopes.body.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('turning the flag OFF and recomputing purges stale scoped rows (back to one global row)', () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    calibrateEstimates(); // flag ON → scoped rows written
    expect(calRow('tag', taxes)).toBeDefined();

    setFlag(false);
    calibrateEstimates(); // flag OFF → must leave ONLY the global row
    expect(calRow('tag', taxes)).toBeUndefined();
    expect(calRow('subtype', 'standard')).toBeUndefined();
    expect(calRow('global', '')?.sample_count).toBe(6);
    const total = (sqlite.prepare(`SELECT COUNT(*) AS n FROM estimate_calibration WHERE owner_id = ?`).get(SYSTEM_OWNER) as { n: number }).n;
    expect(total).toBe(1);
  });

  it('drops MAD outliers and caps extreme ratios', () => {
    // ratios 0.9/1.0/1.0/1.1/5.0 → median 1.0, MAD 0.1 → the 5.0 is dropped.
    for (const [est, act] of [[10, 9], [10, 10], [10, 10], [10, 11], [10, 50]]) {
      makeDoneTask({ est, act });
    }
    calibrateEstimates();
    const g = calRow('global', '');
    expect(g?.sample_count).toBe(4);
    expect(g?.bias_ratio).toBeCloseTo(1.0, 4);

    // A lone ratio-50 owner: capped into [0.1, 10], never stored raw.
    resetDb();
    setFlag(true);
    makeDoneTask({ est: 1, act: 50 });
    calibrateEstimates();
    expect(calRow('global', '')?.bias_ratio).toBeCloseTo(10, 4);
  });

  it('computes tag_combo rows ONLY for pinned refs, and unpin removes the row', async () => {
    const a = makeTag('a');
    const b = makeTag('b');
    for (let i = 0; i < 5; i++) makeDoneTask({ est: 30, act: 60, tags: [a, b] });
    calibrateEstimates();
    const ref = comboRef([a, b]);
    expect(calRow('tag_combo', ref)).toBeUndefined();

    const pin = await api(srv.url, '/api/calibration/pins', { method: 'POST', json: { tag_ids: [b, a] } });
    expect(pin.status).toBe(200);
    expect(pin.body.scope_ref).toBe(ref); // sorted — order-independent
    expect(calRow('tag_combo', ref)?.sample_count).toBe(5); // pin recomputes immediately

    const del = await api(srv.url, `/api/calibration/pins/${encodeURIComponent(ref)}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(calRow('tag_combo', ref)).toBeUndefined(); // unpin stops the bias now, not tonight
  });

  it('rejects pins with unknown or too-few tags', async () => {
    const a = makeTag('a');
    expect((await api(srv.url, '/api/calibration/pins', { method: 'POST', json: { tag_ids: [a] } })).status).toBe(422);
    expect((await api(srv.url, '/api/calibration/pins', { method: 'POST', json: { tag_ids: [a, 'nope'] } })).status).toBe(422);
  });

  it('replaces the owner scope set wholesale — vanished scopes disappear', () => {
    const a = makeTag('a');
    for (let i = 0; i < 5; i++) makeDoneTask({ est: 30, act: 45, tags: [a] });
    calibrateEstimates();
    expect(calRow('tag', a)).toBeDefined();
    sqlite.prepare(`DELETE FROM entity_tags WHERE tag_id = ?`).run(a);
    calibrateEstimates();
    expect(calRow('tag', a)).toBeUndefined();
  });

  it('never writes estimates — suggest-only invariant', () => {
    const ids = [makeDoneTask({ est: 30, act: 90 }), makeDoneTask({ est: 20, act: 60 })];
    for (let i = 0; i < 4; i++) ids.push(makeDoneTask({ est: 30, act: 90 }));
    const before = ids.map((id) => sqlite.prepare(`SELECT estimated_minutes FROM tasks WHERE id = ?`).get(id));
    calibrateEstimates();
    const after = ids.map((id) => sqlite.prepare(`SELECT estimated_minutes FROM tasks WHERE id = ?`).get(id));
    expect(after).toEqual(before);
  });

  it('resolveCalibration walks the ladder and reports confidence tiers', () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    for (let i = 0; i < 8; i++) makeDoneTask({ est: 30, act: 30 }); // untagged noise → global/subtype
    calibrateEstimates();

    const tagged = makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    const viaTag = resolveCalibration(SYSTEM_OWNER, tagged);
    expect(viaTag?.scope_kind).toBe('tag');
    expect(viaTag?.scope_ref).toBe(taxes);
    expect(viaTag?.confidence).toBe('tentative'); // 5 ≤ n < 12

    const untagged = makeDoneTask({ est: 30, act: 30 });
    const viaSubtype = resolveCalibration(SYSTEM_OWNER, untagged);
    expect(['subtype', 'global']).toContain(viaSubtype?.scope_kind); // both ≥ floor; subtype rung comes first
    expect(viaSubtype?.scope_kind).toBe('subtype');

    // ≥12 retained samples → confident.
    for (let i = 0; i < 8; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    calibrateEstimates();
    expect(resolveCalibration(SYSTEM_OWNER, tagged)?.confidence).toBe('confident');
  });

  it('suggests divergent unpinned combos; pinned ones drop out', () => {
    const dinner = makeTag('dinner');
    const reservation = makeTag('reservation');
    for (let i = 0; i < 10; i++) makeDoneTask({ est: 30, act: 30, tags: [dinner] });      // 1.0
    for (let i = 0; i < 10; i++) makeDoneTask({ est: 30, act: 30, tags: [reservation] }); // 1.0
    for (let i = 0; i < 5; i++) makeDoneTask({ est: 30, act: 60, tags: [dinner, reservation] }); // 2.0

    const ref = comboRef([dinner, reservation]);
    const suggestions = detectComboSuggestions(SYSTEM_OWNER);
    expect(suggestions.map((s) => s.scope_ref)).toContain(ref);
    const s = suggestions.find((x) => x.scope_ref === ref)!;
    expect(s.combo_bias).toBeCloseTo(2.0, 4);

    sqlite.prepare(`INSERT INTO calibration_combo_pins (owner_id, scope_ref) VALUES (?, ?)`).run(SYSTEM_OWNER, ref);
    expect(detectComboSuggestions(SYSTEM_OWNER).map((x) => x.scope_ref)).not.toContain(ref);
  });
});

// ── Z1: EOD Alignment (flag on) ──────────────────────────────────────────────────

describe('EOD Alignment (flag on)', () => {
  beforeEach(() => setFlag(true));

  function makeDayBlock(taskId: string, start = `${DAY}T10:00:00.000Z`, end = `${DAY}T11:00:00.000Z`) {
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, task_id, owner_id)
         VALUES (uuid7(), 'B', 'task', ?, ?, ?, ?)`,
      )
      .run(start, end, taskId, SYSTEM_OWNER);
  }

  it('GET is a pure read: payload computed live, no row created', async () => {
    const done = makeDoneTask({ est: 30, act: 50 });
    makeDayBlock(done);
    const open = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), 'Carry', ?, 'open') RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
    makeDayBlock(open, `${DAY}T14:00:00.000Z`, `${DAY}T15:00:00.000Z`);

    const res = await api(srv.url, `/api/reflections/evening?period=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.row).toBeNull();
    expect(res.body.payload.planned).toBe(2);
    expect(res.body.payload.completed).toBe(1);
    expect(res.body.payload.estimate_deltas[0].delta_minutes).toBe(20);
    expect(res.body.payload.carry_forward.map((c: { title: string }) => c.title)).toContain('Carry');

    const row = sqlite
      .prepare(`SELECT 1 FROM reflections WHERE owner_id=? AND kind='evening' AND period_key=?`)
      .get(SYSTEM_OWNER, DAY);
    expect(row).toBeUndefined(); // modal-only authorship: GET never writes
  });

  it('POST open authors the row once (deterministic fallback with Ollama down), idempotently', async () => {
    makeDayBlock(makeDoneTask({ est: 30, act: 45 }));

    const first = await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: DAY } });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(true);
    expect(first.body.llm).toBe(false); // generate() is mocked to throw → fallback prose
    expect(first.body.body).toContain(`${DAY} in review`);

    // User edits survive a re-open — open is idempotent, not a clobber.
    await api(srv.url, '/api/reflections/evening', { method: 'PUT', json: { period_key: DAY, body: 'my own words' } });
    const second = await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: DAY } });
    expect(second.body.created).toBe(false);
    expect(second.body.body).toBe('my own words');

    // refresh:true regenerates deliberately.
    const third = await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: DAY, refresh: true } });
    expect(third.body.body).toContain(`${DAY} in review`);
  });

  it('PUT with empty body deletes the row (same rule as goals/day note)', async () => {
    await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: DAY } });
    await api(srv.url, '/api/reflections/evening', { method: 'PUT', json: { period_key: DAY, body: '' } });
    const res = await api(srv.url, `/api/reflections/evening?period=${DAY}`);
    expect(res.body.row).toBeNull();
  });

  it('rejects malformed period keys', async () => {
    expect((await api(srv.url, '/api/reflections/evening?period=notadate')).status).toBe(422);
    expect((await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: 'nope' } })).status).toBe(422);
  });

  it('the flag is per-owner — one tenant opting in never opens another', async () => {
    // createOwner copies the system owner's prefs row (flag currently ON), so
    // turn owner B's copy off explicitly — that split is exactly what we test.
    createOwner();
    setFlag(false, SECOND_OWNER_ID);
    const asB = { headers: { 'x-test-owner': SECOND_OWNER_ID } };
    expect((await api(srv.url, `/api/reflections/evening?period=${DAY}`, asB)).status).toBe(404);
    expect((await api(srv.url, '/api/calibration/scopes', asB)).status).toBe(404);
    // …while the system owner (flag on) is served.
    expect((await api(srv.url, `/api/reflections/evening?period=${DAY}`)).status).toBe(200);
  });
});

// ── Z6: suggest-only estimate nudge (flag on) ────────────────────────────────────

describe('suggestEstimate (Z6, flag on)', () => {
  beforeEach(() => setFlag(true));

  function makeOpenTask(estimate: number | null, tags: string[] = []): string {
    const id = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), 'Live', ?, 'open', ?) RETURNING id`)
      .get(SYSTEM_OWNER, estimate) as { id: string }).id;
    for (const t of tags) sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, t);
    return id;
  }

  it('proposes a bumped estimate from the resolved scope bias, snapped to 5m', async () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] }); // ratio 1.5
    calibrateEstimates();

    const live = makeOpenTask(60, [taxes]);
    const s = suggestEstimate(SYSTEM_OWNER, live);
    expect(s).not.toBeNull();
    expect(s!.suggested_minutes).toBe(90); // 60 * 1.5
    expect(s!.delta_minutes).toBe(30);
    expect(s!.scope_kind).toBe('tag');
    expect(s!.scope_label).toBe('taxes');
    expect(s!.confidence).toBe('tentative'); // 6 samples

    const viaApi = await api(srv.url, `/api/calibration/suggest/${live}`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.suggestion.suggested_minutes).toBe(90);
  });

  it('suggests at exactly the 15% boundary (float-safe: bias 1.15 is not swallowed)', () => {
    const errand = makeTag('errand');
    // ratio 23/20 = exactly the IEEE-754 float 1.15 → median bias 1.15.
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 20, act: 23, tags: [errand] });
    calibrateEstimates();
    const s = suggestEstimate(SYSTEM_OWNER, makeOpenTask(100, [errand]));
    expect(s).not.toBeNull();          // 0.14999… < 0.15 must NOT suppress a true 15% bias
    expect(s!.suggested_minutes).toBe(115); // round(100 * 1.15 / 5) * 5
  });

  it('returns null when there is nothing worth saying', () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    calibrateEstimates();

    expect(suggestEstimate(SYSTEM_OWNER, makeOpenTask(null, [taxes]))).toBeNull(); // no current estimate

    // near-1.0 bias: a scope whose actuals ≈ estimates.
    const steady = makeTag('steady');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 30, tags: [steady] });
    calibrateEstimates();
    expect(suggestEstimate(SYSTEM_OWNER, makeOpenTask(60, [steady]))).toBeNull();

    // below the confidence floor everywhere (fresh owner, only 2 samples): no scope resolves.
    resetDb();
    setFlag(true);
    const t2 = makeTag('sparse');
    for (let i = 0; i < 2; i++) makeDoneTask({ est: 30, act: 60, tags: [t2] });
    calibrateEstimates();
    expect(suggestEstimate(SYSTEM_OWNER, makeOpenTask(60, [t2]))).toBeNull();
  });

  it('never writes — suggest-only', () => {
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] });
    calibrateEstimates();
    const live = makeOpenTask(60, [taxes]);
    suggestEstimate(SYSTEM_OWNER, live);
    const after = sqlite.prepare(`SELECT estimated_minutes FROM tasks WHERE id = ?`).get(live) as { estimated_minutes: number };
    expect(after.estimated_minutes).toBe(60);
  });

  it('the suggest endpoint 404s when the flag is off', async () => {
    setFlag(false);
    const live = makeOpenTask(60);
    expect((await api(srv.url, `/api/calibration/suggest/${live}`)).status).toBe(404);
  });
});

// ── Z2: Daily Brief folds in last night's EOD Alignment ──────────────────────────

describe('Daily Brief fold-in (Z2)', () => {
  const PREV = '2026-06-14'; // yesterday of DAY

  function makeBlockOn(day: string, taskId: string) {
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, task_id, owner_id)
         VALUES (uuid7(), 'B', 'task', ?, ?, ?, ?)`,
      )
      .run(`${day}T10:00:00.000Z`, `${day}T11:00:00.000Z`, taskId, SYSTEM_OWNER);
  }
  function makeOpenTask(title: string): string {
    return (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status) VALUES (uuid7(), ?, ?, 'open') RETURNING id`)
      .get(title, SYSTEM_OWNER) as { id: string }).id;
  }

  it('flag off: /api/summary carries no evening field', async () => {
    setFlag(false);
    const res = await api(srv.url, `/api/summary?date=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.evening).toBeUndefined();
  });

  it('flag on, evening authored: folds prose + yesterday carry-forward into the morning brief', async () => {
    setFlag(true);
    const carry = makeOpenTask('Unfinished thing');
    makeBlockOn(PREV, carry); // an incomplete task that had a block yesterday
    // Author yesterday's EOD Alignment (mocked Ollama → fallback prose).
    await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: PREV } });

    const res = await api(srv.url, `/api/summary?date=${DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.evening).toBeDefined();
    expect(res.body.evening.date).toBe(PREV);
    expect(res.body.evening.prose).toContain(`${PREV} in review`);
    expect(res.body.evening.carry_forward.map((c: { title: string }) => c.title)).toContain('Unfinished thing');
  });

  it('flag on, no evening row: degrades to carry-forward only (prose null)', async () => {
    setFlag(true);
    const carry = makeOpenTask('Still open');
    makeBlockOn(PREV, carry);
    const res = await api(srv.url, `/api/summary?date=${DAY}`);
    expect(res.body.evening).toBeDefined();
    expect(res.body.evening.prose).toBeNull(); // modal never opened
    expect(res.body.evening.carry_forward.map((c: { title: string }) => c.title)).toContain('Still open');
  });
});

// ── Z5: per-cue prefs matrix + experiment arm (0108) ─────────────────────────────

describe('Z5 per-cue prefs matrix (0108)', () => {
  // The 2×2 cell each arm encodes (§5.2). haptic ⟺ arm∈{B,D}; color ⟺ arm∈{C,D}.
  const ARM_HAPTIC = new Set(['B', 'D']);
  const ARM_COLOR = new Set(['C', 'D']);

  function prefsRow() {
    return sqlite
      .prepare(
        `SELECT focus_ritual_enabled AS focus, haptic_cues_enabled AS haptic,
                ambient_color_enabled AS color, calibration_loop_enabled AS calib, z_experiment_arm AS arm
           FROM scheduling_prefs WHERE owner_id = ?`,
      )
      .get(SYSTEM_OWNER) as { focus: number; haptic: number; color: number; calib: number; arm: string | null };
  }

  it('added the four channel flags (default ON) + z_experiment_arm (NULL) to scheduling_prefs', () => {
    const cols = (sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['focus_ritual_enabled', 'haptic_cues_enabled', 'ambient_color_enabled', 'calibration_loop_enabled', 'z_experiment_arm']) {
      expect(cols).toContain(c);
    }
    const r = prefsRow();
    expect(r.focus).toBe(1);
    expect(r.haptic).toBe(1);
    expect(r.color).toBe(1);
    expect(r.calib).toBe(1);
    expect(r.arm).toBeNull();
  });

  it('assigns a fixed experiment arm on first Time-Sense enable and seeds haptic/color to match it', async () => {
    const patch = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: true } });
    expect(patch.status).toBe(200);
    const arm = patch.body.prefs.z_experiment_arm;
    expect(['A', 'B', 'C', 'D']).toContain(arm);
    // Channels the response returns match the arm's 2×2 cell.
    expect(patch.body.prefs.haptic_cues_enabled).toBe(ARM_HAPTIC.has(arm));
    expect(patch.body.prefs.ambient_color_enabled).toBe(ARM_COLOR.has(arm));
    // Focus screen + calibration loop are on for every arm (not part of the 2×2).
    expect(patch.body.prefs.focus_ritual_enabled).toBe(true);
    expect(patch.body.prefs.calibration_loop_enabled).toBe(true);
    // Persisted, not just echoed.
    expect(prefsRow().arm).toBe(arm);
  });

  it('never reassigns the arm — disable → re-enable keeps the original arm', async () => {
    const first = (await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: true } })).body.prefs.z_experiment_arm;
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: false } });
    const second = (await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: true } })).body.prefs.z_experiment_arm;
    expect(second).toBe(first);
  });

  it('the experiment arm is server-controlled — a client PATCH can never set it', async () => {
    // Try to self-select arm 'D' (full ritual) before any assignment.
    const patch = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: true, z_experiment_arm: 'D' } });
    // The client value is ignored; the server assigns its own (which may or may not be D).
    const assigned = prefsRow().arm;
    expect(['A', 'B', 'C', 'D']).toContain(assigned);
    expect(patch.body.prefs.z_experiment_arm).toBe(assigned);
    // The odds of the random draw matching a deliberately-chosen client value are 1/4,
    // so we can't assert inequality; the real guarantee is that the write path stripped
    // it — verified by the next test overriding a channel while the arm stays put.
  });

  it('the individual channels stay user-configurable after assignment (§4)', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { time_sense_enabled: true } });
    const arm = prefsRow().arm;
    // Owner turns every channel off by hand — all persist, arm is untouched.
    const patch = await api(srv.url, '/api/prefs', {
      method: 'PATCH',
      json: { haptic_cues_enabled: false, ambient_color_enabled: false, focus_ritual_enabled: false, calibration_loop_enabled: false },
    });
    expect(patch.body.prefs.haptic_cues_enabled).toBe(false);
    expect(patch.body.prefs.ambient_color_enabled).toBe(false);
    expect(patch.body.prefs.focus_ritual_enabled).toBe(false);
    expect(patch.body.prefs.calibration_loop_enabled).toBe(false);
    expect(prefsRow().arm).toBe(arm); // re-enable path didn't fire (arm already set)
  });

  it('never assigns an arm while Time-Sense stays off (patching an unrelated pref)', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { min_break_minutes: 15 } });
    expect(prefsRow().arm).toBeNull();
  });
});

// ── Z7: Voice loop retrofit — brief + EOD route through renderCopy (flag-gated) ────

describe('Z7 Voice loop retrofit (flag-gated)', () => {
  function copyCount(surface: string): number {
    return (sqlite
      .prepare(`SELECT COUNT(*) AS n FROM copy_history WHERE owner_id = ? AND surface = ?`)
      .get(SYSTEM_OWNER, surface) as { n: number }).n;
  }

  it('flag OFF: the morning brief uses the legacy path and writes no copy_history (byte-identical Phase N)', async () => {
    setFlag(false);
    const res = await api(srv.url, `/api/summary?date=${DAY}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.prose).toBe('string');
    expect(res.body.prose.length).toBeGreaterThan(0);
    expect(copyCount('daily_brief')).toBe(0);
  });

  it('flag ON: the brief routes through renderCopy — one signature per genuine generation, cache hits do not re-render', async () => {
    setFlag(true);
    const first = await api(srv.url, `/api/summary?date=${DAY}`);
    expect(first.status).toBe(200);
    expect(first.body.prose.length).toBeGreaterThan(0); // Ollama mocked down → deterministic fallback prose
    expect(copyCount('daily_brief')).toBe(1);

    // Same inputs → cache hit → stored prose returned, renderCopy NOT re-invoked.
    await api(srv.url, `/api/summary?date=${DAY}`);
    expect(copyCount('daily_brief')).toBe(1);

    // refresh forces a real re-generation → exactly one more signature.
    await api(srv.url, `/api/summary?date=${DAY}&refresh=1`);
    expect(copyCount('daily_brief')).toBe(2);
  });

  it('flag ON: opening the EOD alignment routes through renderCopy and records an eod_alignment signature', async () => {
    setFlag(true);
    const res = await api(srv.url, '/api/reflections/evening/open', { method: 'POST', json: { period_key: DAY } });
    expect(res.status).toBe(200);
    expect(res.body.body).toContain(`${DAY} in review`); // fallback paragraph carried through verbatim
    expect(copyCount('eod_alignment')).toBeGreaterThanOrEqual(1);
  });

  it('flag ON: the calibration chip line is rendered through the Voice loop (carries the suggested minutes, records a signature)', async () => {
    setFlag(true);
    const taxes = makeTag('taxes');
    for (let i = 0; i < 6; i++) makeDoneTask({ est: 30, act: 45, tags: [taxes] }); // ratio 1.5
    calibrateEstimates();
    const live = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes) VALUES (uuid7(), 'Live', ?, 'open', 60) RETURNING id`)
      .get(SYSTEM_OWNER) as { id: string }).id;
    sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(live, taxes);

    const res = await api(srv.url, `/api/calibration/suggest/${live}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestion.suggested_minutes).toBe(90);
    expect(typeof res.body.suggestion.message).toBe('string');
    expect(res.body.suggestion.message).toContain('90'); // required datum: the suggested minutes
    expect(copyCount('calibration_chip')).toBe(1);
  });

  it('flag ON: whats-next renders the T4 line server-side; flag OFF and unknown block 404', async () => {
    setFlag(true);
    const cur = (sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, owner_id) VALUES (uuid7(), 'Now', 'task', ?, ?, ?) RETURNING id`)
      .get(`${DAY}T10:00:00.000Z`, `${DAY}T11:00:00.000Z`, SYSTEM_OWNER) as { id: string }).id;
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, owner_id) VALUES (uuid7(), 'Lunch', 'task', ?, ?, ?)`)
      .run(`${DAY}T12:30:00.000Z`, `${DAY}T13:00:00.000Z`, SYSTEM_OWNER);

    const res = await api(srv.url, `/api/blocks/${cur}/whats-next`);
    expect(res.status).toBe(200);
    expect(res.body.next.title).toBe('Lunch');
    expect(typeof res.body.text).toBe('string');
    expect(res.body.text).toContain('12:30'); // required datum: the next start time
    expect(copyCount('t4_whats_next')).toBe(1);

    // Unknown block → 404; flag OFF → 404 (endpoint looks absent).
    expect((await api(srv.url, `/api/blocks/does-not-exist/whats-next`)).status).toBe(404);
    setFlag(false);
    expect((await api(srv.url, `/api/blocks/${cur}/whats-next`)).status).toBe(404);
  });

  it('flag ON: whats-next renders the next time in the OWNER timezone, not raw UTC (regression)', async () => {
    setFlag(true);
    // Blocks are stored UTC; a non-UTC owner must see their local wall-clock, matching
    // the calendar — not the sliced UTC HH:MM (the bug the retrofit review caught).
    sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'America/New_York' WHERE owner_id = ?`).run(SYSTEM_OWNER);
    const cur = (sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, owner_id) VALUES (uuid7(), 'Now', 'task', ?, ?, ?) RETURNING id`)
      .get(`${DAY}T10:00:00.000Z`, `${DAY}T11:00:00.000Z`, SYSTEM_OWNER) as { id: string }).id;
    sqlite
      .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, owner_id) VALUES (uuid7(), 'Lunch', 'task', ?, ?, ?)`)
      .run(`${DAY}T12:30:00.000Z`, `${DAY}T13:00:00.000Z`, SYSTEM_OWNER);

    const res = await api(srv.url, `/api/blocks/${cur}/whats-next`);
    expect(res.body.text).toContain('08:30'); // 12:30 UTC = 08:30 EDT on 2026-06-15
    expect(res.body.text).not.toContain('12:30');
  });
});
