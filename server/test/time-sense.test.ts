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
import { comboRef, resolveCalibration, detectComboSuggestions } from '../src/services/calibration.js';
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

describe('migrations 0105/0106', () => {
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
