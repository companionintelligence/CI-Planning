import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN } from '../src/lib/auth/types.js';
import { calibrateEstimates } from '../src/jobs/calibrate-estimates.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;
const asOwner = <T>(fn: () => T): T => runWithOwner(OWNER, [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN], fn);

function doneTask(estimated: number, actual: number): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, actual_minutes, priority, completed_at)
       VALUES (uuid7(), 'x', ?, 'done', ?, ?, 3, ?)`,
    )
    .run(OWNER, estimated, actual, new Date().toISOString());
}

const history = () =>
  sqlite.prepare(`SELECT * FROM calibration_history WHERE owner_id = ? ORDER BY computed_date`).all(OWNER) as Record<string, unknown>[];

/**
 * The owner ruling: "do not recompute the calibration history." The rollup table stays
 * regenerable (a vanished scope must still disappear from it), so these pin that the
 * DATED readings survive the job's wholesale delete.
 */
describe('calibration history (0138)', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  // Time-Sense is ON in the test baseline, so the job writes a row PER SCOPE (global +
  // subtype + any tag/category/objective scopes), not a single global one. These assert
  // on the global scope specifically rather than on row counts.
  const globalRows = () => history().filter((r) => r.scope_kind === 'global');

  it('records a reading even with no samples — a trend starts where the data does', async () => {
    await asOwner(() => calibrateEstimates());
    expect(globalRows()).toHaveLength(1);
    expect(globalRows()[0]).toMatchObject({ scope_kind: 'global', sample_count: 0, bias_ratio: null });
  });

  it('writes the bias for the day', async () => {
    doneTask(30, 60); doneTask(30, 60); doneTask(30, 60);
    await asOwner(() => calibrateEstimates());
    expect(globalRows()[0]).toMatchObject({ sample_count: 3, bias_ratio: 2 });
  });

  it('SURVIVES a recompute that wipes the rollup', async () => {
    doneTask(30, 60); doneTask(30, 60); doneTask(30, 60);
    await asOwner(() => calibrateEstimates());
    // Backdate the reading so the next run lands on a different day.
    sqlite.prepare(`UPDATE calibration_history SET computed_date = '2026-01-01' WHERE owner_id = ?`).run(OWNER);

    // Second run, different data — the rollup is replaced wholesale…
    sqlite.prepare(`DELETE FROM tasks WHERE owner_id = ?`).run(OWNER);
    doneTask(60, 60); doneTask(60, 60); doneTask(60, 60);
    await asOwner(() => calibrateEstimates());

    const g = globalRows();
    expect(g).toHaveLength(2);                    // …but BOTH readings remain
    expect(g[0]).toMatchObject({ computed_date: '2026-01-01', bias_ratio: 2 }); // the old one intact
    expect(g[1].bias_ratio).toBe(1);
    // The rollup itself still holds exactly one (current) global row.
    const rollup = sqlite.prepare(`SELECT COUNT(*) n FROM estimate_calibration WHERE owner_id = ? AND scope_kind='global'`).get(OWNER) as { n: number };
    expect(rollup.n).toBe(1);
  });

  it('is idempotent within a day — a re-run overwrites, never duplicates', async () => {
    doneTask(30, 60); doneTask(30, 60); doneTask(30, 60);
    await asOwner(() => calibrateEstimates());
    const afterFirst = history().length;
    await asOwner(() => calibrateEstimates());
    await asOwner(() => calibrateEstimates());
    expect(history()).toHaveLength(afterFirst); // count must not GROW on same-day re-runs
    expect(globalRows()).toHaveLength(1);
  });

  it('GET /api/metrics/calibration returns readings oldest→newest', async () => {
    doneTask(30, 60); doneTask(30, 60); doneTask(30, 60);
    await asOwner(() => calibrateEstimates());
    sqlite.prepare(`UPDATE calibration_history SET computed_date = '2026-01-01' WHERE owner_id = ?`).run(OWNER);
    await asOwner(() => calibrateEstimates());

    const { status, body } = await api(srv.url, '/api/metrics/calibration?limit=90');
    expect(status).toBe(200);
    expect(body.readings).toHaveLength(2);
    expect(body.readings[0].computed_date).toBe('2026-01-01'); // chronological, not newest-first
  });
});
