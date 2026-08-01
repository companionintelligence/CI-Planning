import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runScheduledJob, failInterruptedJobRuns } from '../src/jobs/index.js';
import { logger } from '../src/lib/logger.js';
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

describe('failInterruptedJobRuns', () => {
  it("settles rows a dead process left `running`", () => {
    const job = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'ingest_gcal'`).get() as { id: string };
    for (let i = 0; i < 3; i++) {
      sqlite
        .prepare(`INSERT INTO job_runs (id, job_id, started_at, status) VALUES (uuid7(), ?, ?, 'running')`)
        .run(job.id, new Date().toISOString());
    }

    expect(failInterruptedJobRuns()).toBe(3);

    const rows = runRows('ingest_gcal');
    expect(rows.every((r) => r.status === 'error')).toBe(true);
    // A run row is only ever finished by the process that opened it, so a `running` row
    // at startup is by definition an orphan — none may survive the sweep.
    expect(rows.filter((r) => r.status === 'running')).toHaveLength(0);
  });

  it('leaves finished rows alone', () => {
    const job = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'ingest_gcal'`).get() as { id: string };
    sqlite
      .prepare(`INSERT INTO job_runs (id, job_id, started_at, finished_at, status) VALUES (uuid7(), ?, ?, ?, 'done')`)
      .run(job.id, new Date().toISOString(), new Date().toISOString());

    expect(failInterruptedJobRuns()).toBe(0);
    expect(runRows('ingest_gcal')[0].status).toBe('done');
  });
});
