import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner, ALL_SCOPES } from '../src/lib/context.js';
import { runJob } from '../src/jobs/index.js';
import { localDateInTZ } from '../src/lib/tz.js';
import { ownerTimezone } from '../src/engine/recurrence-generate.js';
import {
  calibrateDismissals,
  DISMISSAL_FLOOR, LEARNING_WINDOW_DAYS, MAX_EXEMPLARS, PENDING_MS, RATE_PERIOD_DAYS,
} from '../src/services/dismissal-learning.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * Close-loop wave, ticket 3 — the batch stage over `possible_outcome_log` (ticket 1's
 * schema, ticket 2's capture). Shaped like `classification-learning.test.ts`: raw
 * sqlite fixtures, a frozen `NOW`, every timestamp derived from it, and an injected
 * `embedFn` throughout so no assertion depends on whether this box has an embedder
 * pulled.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-08-14T14:00:00.000Z');
const msAgo = (ms: number) => new Date(NOW.getTime() - ms);

/** Settled long enough ago to clear PENDING_MS and land well inside the window. */
const SETTLED = 3 * 86_400_000;

let seq = 0;

/** Append one raw `possible_outcome_log` row — the shape ticket 2's capture writes,
 *  built directly since capture itself is out of scope here. */
async function logRow(opts: {
  outcome?: 'dismissed' | 'promoted';
  ageMs?: number;
  owner?: string;
  possibleId?: string;
  text?: string;
  sourceKind?: string | null;
}): Promise<string> {
  const owner = opts.owner ?? OWNER;
  const idx = seq++;
  const id = `log-${idx}`;
  const decidedAt = msAgo(opts.ageMs ?? SETTLED - idx * 1000).toISOString();
  const localDate = localDateInTZ(decidedAt, await ownerTimezone(owner));
  sqlite
    .prepare(
      `INSERT INTO possible_outcome_log
         (id, owner_id, possible_task_id, source_kind, input_text, outcome, decided_at, local_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, owner, opts.possibleId ?? `possible-${idx}`, opts.sourceKind ?? null,
      opts.text ?? `noise ${idx}`, opts.outcome ?? 'dismissed', decidedAt, localDate,
    );
  return id;
}
const dismiss = (opts: Omit<Parameters<typeof logRow>[0], 'outcome'> = {}) => logRow({ ...opts, outcome: 'dismissed' });
const promote = (opts: Omit<Parameters<typeof logRow>[0], 'outcome'> = {}) => logRow({ ...opts, outcome: 'promoted' });

/** `possible_tasks.created_at` uses SQLite's `CURRENT_TIMESTAMP` shape — space
 *  separated, no zone suffix — a different format from `decided_at` above. */
const sqlTimestamp = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

function insertPossible(ageMs: number, owner = OWNER): void {
  sqlite
    .prepare(
      `INSERT INTO possible_tasks (id, raw_title, source_kind, status, proposed_owner_id, created_at)
       VALUES (uuid7(), 'Some suggestion', NULL, 'pending', ?, ?)`,
    )
    .run(owner, sqlTimestamp(msAgo(ageMs)));
}

const exemplarRows = (owner = OWNER) =>
  sqlite.prepare(`SELECT * FROM possible_dismissal_exemplars WHERE owner_id = ? ORDER BY log_id`).all(owner) as {
    log_id: string; input_text: string; source_kind: string | null; embedding: Buffer | null;
  }[];

const rateRows = (owner = OWNER) =>
  sqlite.prepare(`SELECT * FROM possible_dismissal_rate WHERE owner_id = ? ORDER BY computed_date`).all(owner) as {
    computed_date: string; period_days: number; created: number; decided: number;
    dismissed: number; rate: number | null; exemplars: number; hinted: number;
  }[];

function lastRun(kind: string) {
  return sqlite
    .prepare(
      `SELECT r.* FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
        WHERE j.kind = ? ORDER BY r.id DESC LIMIT 1`,
    )
    .get(kind) as { status: string; items_created: number; items_updated: number; log: string } | undefined;
}

beforeEach(() => {
  resetDb();
  seq = 0;
});

// ── What counts as settled evidence ────────────────────────────────────────────

describe('what counts as settled dismissal evidence', () => {
  it('ignores a dismissal younger than PENDING_MS — the mis-click fence', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR - 1; i++) await dismiss();
    await dismiss({ ageMs: PENDING_MS - 1000 }); // too young to have settled
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.settled).toBe(DISMISSAL_FLOOR - 1);
    expect(r.indexed).toBe(0); // still under the floor without the young one
  });

  it('counts a dismissal exactly at PENDING_MS as settled', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR - 1; i++) await dismiss();
    await dismiss({ ageMs: PENDING_MS });
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.settled).toBe(DISMISSAL_FLOOR);
  });

  it('excludes a dismissal later reversed by a promote on the same possible', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `keep ${i}` });
    const reversed = 'possible-reversed';
    await dismiss({ possibleId: reversed, text: 'reversed-dismiss', ageMs: SETTLED + 20_000 });
    await promote({ possibleId: reversed, text: 'reversed-promote', ageMs: SETTLED }); // later — decided_at closer to NOW
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.settled).toBe(DISMISSAL_FLOOR); // the reversed pair contributes nothing
    expect(exemplarRows().some((e) => e.input_text.startsWith('reversed'))).toBe(false);
  });

  it('excludes evidence outside LEARNING_WINDOW_DAYS', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR - 1; i++) await dismiss();
    await dismiss({ ageMs: (LEARNING_WINDOW_DAYS + 5) * 86_400_000 });
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.settled).toBe(DISMISSAL_FLOOR - 1);
  });
});

// ── The batch rebuild ────────────────────────────────────────────────────────

describe('the batch rebuild', () => {
  it('writes zero exemplar rows below DISMISSAL_FLOOR, and says so', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR - 1; i++) await dismiss();
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.indexed).toBe(0);
    expect(exemplarRows()).toHaveLength(0);
  });

  it('builds the index once the floor is cleared', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `noise ${i}` });
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.indexed).toBe(DISMISSAL_FLOOR);
    expect(exemplarRows()).toHaveLength(DISMISSAL_FLOOR);
  });

  it('empties a stale index when the evidence goes away', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `noise ${i}` });
    await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(exemplarRows().length).toBeGreaterThan(0);

    sqlite.exec(`DELETE FROM possible_outcome_log`);
    await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(exemplarRows()).toHaveLength(0);
  });

  it('caps the index at MAX_EXEMPLARS, keeping the most recent evidence', async () => {
    const total = MAX_EXEMPLARS + 20;
    // Ages descend with i, so `noise 0` is the oldest and must be the first dropped.
    for (let i = 0; i < total; i++) {
      await dismiss({ text: `noise ${i}`, ageMs: SETTLED + (total - i) * 60_000 });
    }
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.indexed).toBe(MAX_EXEMPLARS);
    const rows = exemplarRows();
    expect(rows).toHaveLength(MAX_EXEMPLARS);
    const texts = new Set(rows.map((e) => e.input_text));
    expect(texts.has('noise 0')).toBe(false);
    expect(texts.has(`noise ${total - 1}`)).toBe(true);
  });

  it('never pools a second owner’s dismissals into the first’s rollup', async () => {
    createOwner(SECOND_OWNER_ID);
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `mine ${i}` });
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `theirs ${i}`, owner: SECOND_OWNER_ID });

    await calibrateDismissals(OWNER, NOW, { embedFn: null });
    await calibrateDismissals(SECOND_OWNER_ID, NOW, { embedFn: null });

    expect(exemplarRows(OWNER).every((e) => e.input_text.startsWith('mine'))).toBe(true);
    expect(exemplarRows(SECOND_OWNER_ID).every((e) => e.input_text.startsWith('theirs'))).toBe(true);
  });

  it('is deterministic — same evidence, same clock, same rollup', async () => {
    for (let i = 0; i < 10; i++) await dismiss({ text: `noise ${i}` });
    await calibrateDismissals(OWNER, NOW, { embedFn: null });
    const first = exemplarRows().map((e) => `${e.log_id}|${e.input_text}`);
    await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(exemplarRows().map((e) => `${e.log_id}|${e.input_text}`)).toEqual(first);
  });

  it('indexes without an embedder, leaving embedding NULL', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `noise ${i}` });
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.indexed).toBeGreaterThan(0);
    expect(r.embedded).toBe(0);
    expect(exemplarRows().every((e) => e.embedding === null)).toBe(true);
  });

  it('stores a vector per exemplar when an embedder answers', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `noise ${i}` });
    const fakeEmbed = async (_: string) => [0.1, 0.2, 0.3];
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: fakeEmbed });
    expect(r.embedded).toBe(r.indexed);
    expect(exemplarRows().every((e) => e.embedding !== null)).toBe(true);
  });
});

// ── The noise-rate reading ────────────────────────────────────────────────────

describe('the noise-rate reading', () => {
  it('writes rate = NULL when nothing was decided in the trailing period', async () => {
    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.rate.decided).toBe(0);
    expect(r.rate.rate).toBeNull();
    expect(rateRows()[0].rate).toBeNull();
  });

  it('computes the rate correctly, scoped to RATE_PERIOD_DAYS', async () => {
    insertPossible(1 * 86_400_000);
    insertPossible(2 * 86_400_000);
    insertPossible((RATE_PERIOD_DAYS + 3) * 86_400_000); // outside the rate window

    await dismiss({ ageMs: 1 * 86_400_000 });
    await dismiss({ ageMs: 2 * 86_400_000 });
    await promote({ ageMs: 3 * 86_400_000 });
    await dismiss({ ageMs: (RATE_PERIOD_DAYS + 2) * 86_400_000 }); // outside the rate window

    const r = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(r.rate.periodDays).toBe(RATE_PERIOD_DAYS);
    expect(r.rate.created).toBe(2);
    expect(r.rate.decided).toBe(3);
    expect(r.rate.dismissed).toBe(2);
    expect(r.rate.rate).toBeCloseTo(2 / 3);

    const stored = rateRows()[0];
    expect(stored.decided).toBe(3);
    expect(stored.dismissed).toBe(2);
    expect(stored.exemplars).toBe(r.indexed);
  });

  it('samples `hinted` from the rollup as it stood BEFORE this run’s rebuild', async () => {
    for (let i = 0; i < DISMISSAL_FLOOR; i++) await dismiss({ text: `noise ${i}` });
    const first = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(first.rate.hinted).toBe(false); // nothing existed before the FIRST run

    const second = await calibrateDismissals(OWNER, NOW, { embedFn: null });
    expect(second.rate.hinted).toBe(true); // the first run's rollup existed going in
  });
});

// ── The scheduled job ─────────────────────────────────────────────────────────

describe('the calibrate_dismissals job', () => {
  it('finishes done with the under-the-floor message for an owner with zero dismissals', async () => {
    const r = await runJob('calibrate_dismissals');
    expect(r.status).toBe('done');
    expect(r.log.toLowerCase()).toContain('floor');
    expect(lastRun('calibrate_dismissals')?.status).toBe('done');
  });

  it('finishes done and does not throw when possible_outcome_log is missing', async () => {
    sqlite.exec(`ALTER TABLE possible_outcome_log RENAME TO possible_outcome_log_hidden`);
    try {
      const r = await runJob('calibrate_dismissals');
      expect(r.status).toBe('done');
    } finally {
      sqlite.exec(`ALTER TABLE possible_outcome_log_hidden RENAME TO possible_outcome_log`);
    }
  });

  it('fans out — one job_run per owner', async () => {
    createOwner(SECOND_OWNER_ID);
    await runJob('calibrate_dismissals');
    await runWithOwner(SECOND_OWNER_ID, ALL_SCOPES, () => runJob('calibrate_dismissals'));
    const runs = sqlite
      .prepare(
        `SELECT COUNT(*) n FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id WHERE j.kind = ?`,
      )
      .get('calibrate_dismissals') as { n: number };
    expect(runs.n).toBe(2);
  });
});
