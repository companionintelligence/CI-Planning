import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runWithOwner } from '../src/lib/context.js';
import { runScheduledJob, runJob } from '../src/jobs/index.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * T3: the cron must run owner-scoped jobs once PER owner (not just owner #1), and
 * global jobs once. The manual `/run` path runs a job for the calling owner only.
 * DB-backed (verified on CI). We assert via job_runs row counts — the fan-out
 * records one run per owner. `freeze_stars` is the probe because it's deterministic
 * (no Ollama) and seeded (mig 0090); `prune_sync_events` (0078) is the global probe.
 */
function runCount(kind: string): number {
  return (
    sqlite
      .prepare(
        `SELECT count(*) AS n FROM job_runs jr JOIN scheduled_jobs sj ON sj.id = jr.job_id WHERE sj.kind = ?`
      )
      .get(kind) as { n: number }
  ).n;
}

describe('T3 cron per-owner fan-out', () => {
  beforeEach(() => resetDb());

  it('runs an owner-scoped kind once per owner', async () => {
    createOwner(); // system owner + owner B = 2 owners
    await runScheduledJob('freeze_stars');
    expect(runCount('freeze_stars')).toBe(2);
  });

  it('runs a global kind once regardless of owner count', async () => {
    createOwner();
    await runScheduledJob('prune_sync_events');
    expect(runCount('prune_sync_events')).toBe(1);
  });

  it('manual runJob runs once for the calling owner (no fan-out)', async () => {
    createOwner();
    await runWithOwner(SECOND_OWNER_ID, () => runJob('freeze_stars'));
    expect(runCount('freeze_stars')).toBe(1);
  });
});
