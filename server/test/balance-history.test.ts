/**
 * GET /api/priorities/history — ticket 7 of the balance-targets wave
 * (docs/factory/balance-targets-wave/bal-7-history-readout.md): the frozen
 * `balance_week_log` readout (ticket 6) shaped into per-dimension met/counted counts.
 * Fixtures inserted with raw `sqlite` straight into `balance_week_log`, matching
 * balance-snapshot.test.ts's convention — writing that table is ticket 6's job, not
 * this one's.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, createOwner, SECOND_OWNER_ID, startTestServer, api, type TestServer } from './helpers.js';

interface HistoryDimension {
  category: string;
  met_weeks: number;
  counted_weeks: number;
  recent: { week_start: string; met: boolean }[];
}
interface HistoryResponse {
  weeks_recorded: number;
  dimensions: HistoryDimension[];
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => resetDb());

/** Monday `n` weeks before 2026-08-24 (n=0 is that Monday itself). */
function weekStart(n: number): string {
  const d = new Date('2026-08-24T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() - n * 7);
  return d.toISOString().slice(0, 10);
}

function insertWeek(
  week_start: string,
  category: string,
  targetHours: number,
  scheduledMinutes: number,
  owner: string = SYSTEM_OWNER,
): void {
  sqlite
    .prepare(
      `INSERT INTO balance_week_log
         (id, owner_id, week_start, category, target_hours, scheduled_minutes, timed_minutes, created_at)
       VALUES (uuid7(), ?, ?, ?, ?, ?, 0, '2026-08-24T04:40:00.000Z')`,
    )
    .run(owner, week_start, category, targetHours, scheduledMinutes);
}

const get = (headers?: Record<string, string>) =>
  api<HistoryResponse>(srv.url, '/api/priorities/history', headers ? { headers } : {});

function dimOf(body: HistoryResponse, category: string): HistoryDimension | undefined {
  return body.dimensions.find((d) => d.category === category);
}

describe('GET /api/priorities/history', () => {
  it('6 seeded weeks, 2 met => met_weeks: 2, counted_weeks: 6', async () => {
    for (let i = 0; i < 6; i++) {
      // Met in the two newest weeks (300 >= 5h*60); missed in the other four.
      insertWeek(weekStart(i), 'health', 5, i < 2 ? 300 : 100);
    }
    const r = await get();
    expect(r.status).toBe(200);
    expect(dimOf(r.body, 'health')).toMatchObject({ met_weeks: 2, counted_weeks: 6 });
  });

  it('a zero-target week is excluded from both counts', async () => {
    insertWeek(weekStart(0), 'health', 5, 300); // met
    insertWeek(weekStart(1), 'health', 0, 999); // target 0 — excluded from both counts
    insertWeek(weekStart(2), 'health', 5, 100); // missed
    const r = await get();
    const health = dimOf(r.body, 'health');
    expect(health).toMatchObject({ met_weeks: 1, counted_weeks: 2 });
    // The zero-target week never reads as "met" in `recent` either.
    expect(health?.recent.find((w) => w.week_start === weekStart(1))?.met).toBe(false);
  });

  it('14 seeded weeks => only the newest 12 are counted', async () => {
    for (let i = 0; i < 14; i++) insertWeek(weekStart(i), 'health', 5, 300); // all "met" by amount
    const r = await get();
    expect(dimOf(r.body, 'health')).toMatchObject({ met_weeks: 12, counted_weeks: 12 });
  });

  it('exactly-met boundary (scheduled_minutes == target_hours * 60) counts as met', async () => {
    insertWeek(weekStart(0), 'health', 5, 300); // 5 * 60 == 300, exactly
    const r = await get();
    expect(dimOf(r.body, 'health')).toMatchObject({ met_weeks: 1, counted_weeks: 1 });
  });

  it('owner isolation; empty log => weeks_recorded: 0, no throw', async () => {
    const empty = await get();
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ weeks_recorded: 0, dimensions: [] });

    createOwner(SECOND_OWNER_ID);
    insertWeek(weekStart(0), 'health', 5, 300, SYSTEM_OWNER); // met
    insertWeek(weekStart(0), 'health', 5, 100, SECOND_OWNER_ID); // missed

    const a = await get();
    const b = await get({ 'x-test-owner': SECOND_OWNER_ID });
    expect(a.body.weeks_recorded).toBe(1);
    expect(dimOf(a.body, 'health')).toMatchObject({ met_weeks: 1, counted_weeks: 1 });
    expect(dimOf(b.body, 'health')).toMatchObject({ met_weeks: 0, counted_weeks: 1 });
  });
});
