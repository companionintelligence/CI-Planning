import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runScheduledJob, runJob, runIngestNow, failInterruptedJobRuns } from '../src/jobs/index.js';
import { logger } from '../src/lib/logger.js';
import { runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';
import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN } from '../src/lib/auth/types.js';
import { resetDb } from './helpers.js';

/**
 * A cron tick must never start a job kind whose previous run is still going.
 *
 * `ingest_gcal` over a freshly-connected calendar runs far longer than its 30-minute
 * period — it embeds every pending possible through Ollama one at a time — so each tick
 * was piling a fresh fan-out onto the last: nine concurrent runs, each spawning its own
 * MCP child, all grinding the same rows.
 */

beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());

const runRows = (kind: string) =>
  sqlite
    .prepare(
      `SELECT r.status FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id WHERE j.kind = ?`,
    )
    .all(kind) as { status: string }[];

describe('overlapping scheduled runs', () => {
  it('skips a tick while the previous run of that kind is still going', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    // 'snapshot_db' is global (not owner-scoped) and self-contained. Hold it open by
    // making its work await a gate we control, then fire a second tick underneath.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.spyOn(await import('../src/lib/backup.js'), 'snapshot').mockImplementation(async () => {
      await gate;
      return '/tmp/none.db';
    });

    const first = runScheduledJob('snapshot_db');
    await new Promise((r) => setTimeout(r, 20)); // let the first run get inside
    await runScheduledJob('snapshot_db');        // second tick — must be refused
    release();
    await first;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('previous run is still going'));
    // Exactly ONE run row: the skipped tick must not even open a row.
    expect(runRows('snapshot_db')).toHaveLength(1);
    slow.mockRestore();
  });

  it('the lock is released, so a later tick runs normally', async () => {
    await runScheduledJob('snapshot_db');
    await runScheduledJob('snapshot_db');
    expect(runRows('snapshot_db')).toHaveLength(2);
  });
});

/**
 * The tick lock only ever covered the cron. Both MANUAL triggers went straight to
 * `runJob` and were unguarded — and `POST /api/jobs/run-now` is deliberately not
 * admin-gated, so any authenticated user could re-fire it at will and stack the very
 * concurrent fan-outs (each with its own MCP child) the tick lock exists to prevent.
 */
describe('manual runs are guarded too', () => {
  const asOwner = <T>(fn: () => Promise<T>) =>
    runWithOwner(SYSTEM_OWNER, [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN], fn);

  it('refuses a second concurrent runJob for the same (kind, owner)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.spyOn(await import('../src/lib/backup.js'), 'snapshot').mockImplementation(async () => {
      await gate;
      return '/tmp/none.db';
    });

    const first = asOwner(() => runJob('snapshot_db'));
    await new Promise((r) => setTimeout(r, 20));
    const second = await asOwner(() => runJob('snapshot_db'));
    release();
    await first;

    expect(second.status).toBe('skipped');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('already in progress'),
      expect.anything(),
    );
    // The refused run must not open a row — a run that did not happen must not show up
    // in the Jobs view as one that did.
    expect(runRows('snapshot_db')).toHaveLength(1);
    slow.mockRestore();
  });

  it('releases the lock, so the next manual run proceeds', async () => {
    await asOwner(() => runJob('snapshot_db'));
    const second = await asOwner(() => runJob('snapshot_db'));
    expect(second.status).not.toBe('skipped');
    expect(runRows('snapshot_db')).toHaveLength(2);
  });

  it('refuses an overlapping run-now sequence rather than redoing finished kinds', async () => {
    // The four RUN_NOW kinds run one after another. Hold the FIRST one open and fire a
    // second request underneath: a per-kind-only guard would refuse just that kind and
    // let the second request march on through the other three. All four must be refused.
    //
    // The two ingest kinds are stubbed out. Left real they perform genuine Ollama
    // extraction over the Google fixtures (run-now.test.ts measures 48-70s per call, far
    // longer when the box has another model resident), and none of that is what this
    // test is about. nightly_grooming stays real — on the empty DB `resetDb` leaves, its
    // sweeps are DB-only no-ops.
    const ingest = await import('../src/agents/ingest.js');
    const empty = {
      itemsProcessed: 0, possiblesCreated: 0, possiblesUpdated: 0,
      blocksCreated: 0, promoted: 0, duplicates: 0, failed: 0, deferred: 0,
    };
    const gcal = vi.spyOn(ingest, 'ingestEvents').mockResolvedValue(empty);
    const gmail = vi.spyOn(ingest, 'ingestEmails').mockResolvedValue(empty);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.spyOn(await import('../src/agents/sync.js'), 'syncAll')
      .mockImplementation(async () => { await gate; return []; });

    const first = asOwner(() => runIngestNow());
    await new Promise((r) => setTimeout(r, 20)); // let the first get inside sync_calendar
    const second = await asOwner(() => runIngestNow());
    release();
    await first;

    expect(second.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    gcal.mockRestore();
    gmail.mockRestore();
    slow.mockRestore();
  });
});

describe('failInterruptedJobRuns', () => {
  it("settles rows a dead process left `running`", async () => {
    const job = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'ingest_gcal'`).get() as { id: string };
    for (let i = 0; i < 3; i++) {
      sqlite
        .prepare(`INSERT INTO job_runs (id, job_id, started_at, status) VALUES (uuid7(), ?, ?, 'running')`)
        .run(job.id, new Date().toISOString());
    }

    expect(await failInterruptedJobRuns()).toBe(3);

    const rows = runRows('ingest_gcal');
    expect(rows.every((r) => r.status === 'error')).toBe(true);
    // A run row is only ever finished by the process that opened it, so a `running` row
    // at startup is by definition an orphan — none may survive the sweep.
    expect(rows.filter((r) => r.status === 'running')).toHaveLength(0);
  });

  it('leaves finished rows alone', async () => {
    const job = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'ingest_gcal'`).get() as { id: string };
    sqlite
      .prepare(`INSERT INTO job_runs (id, job_id, started_at, finished_at, status) VALUES (uuid7(), ?, ?, ?, 'done')`)
      .run(job.id, new Date().toISOString(), new Date().toISOString());

    expect(await failInterruptedJobRuns()).toBe(0);
    expect(runRows('ingest_gcal')[0].status).toBe('done');
  });
});
