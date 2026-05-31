import { Cron } from 'croner';
import { db, sqlite } from '../db/index.js';
import { scheduledJobs } from '../db/schema.js';
import { runScheduler } from '../engine/scheduler.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';

export async function runJob(kind: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const run = sqlite
    .prepare<{ id: number }, [string, string]>(
      `INSERT INTO job_runs (job_id, started_at) SELECT id, ? FROM scheduled_jobs WHERE kind = ? RETURNING id`
    )
    .get(startedAt, kind);

  let status = 'done';
  let itemsCreated = 0;
  let log = '';

  try {
    if (kind === 'auto_schedule') {
      const date = new Date().toISOString().slice(0, 10);
      const result = await runScheduler(date);
      itemsCreated = result.blocksCreated;
      log = JSON.stringify(result);
    } else {
      log = `Job kind '${kind}' not yet implemented`;
      logger.info(`Job ${kind}: stub`);
    }
  } catch (err) {
    status = 'error';
    log = String(err);
    logger.error(`Job ${kind} failed`, err);
  }

  const finishedAt = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE job_runs SET finished_at = ?, status = ?, items_created = ?, log = ? WHERE id = ?`
    )
    .run(finishedAt, status, itemsCreated, log, run?.id);

  sqlite
    .prepare(`UPDATE scheduled_jobs SET last_run_at = ? WHERE kind = ?`)
    .run(finishedAt, kind);

  broadcast('job:run', { kind, status, itemsCreated, finishedAt });
}

export function startCronJobs() {
  const jobs = sqlite.prepare<{ id: number; kind: string; cron: string }, []>(
    'SELECT id, kind, cron FROM scheduled_jobs WHERE enabled = 1'
  ).all();

  for (const job of jobs) {
    new Cron(job.cron, () => runJob(job.kind));
    logger.info(`Cron registered: ${job.kind} [${job.cron}]`);
  }
}
