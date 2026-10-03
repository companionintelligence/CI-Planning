import { Cron } from 'croner';
import { sqlite } from '../db/index.js';
import { runScheduler } from '../engine/scheduler.js';
import { ingestEmails, ingestEvents } from '../agents/ingest.js';
import { promotePossibles, dedupePossibles, surfaceOverdue } from '../agents/groom.js';
import { generateRecurrences } from '../engine/recurrence.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { localISODate } from '../lib/dates.js';
import { runWithOwner, currentOwnerId, SYSTEM_OWNER } from '../lib/context.js';

export interface JobOutcome {
  itemsCreated: number;
  itemsUpdated: number;
  log: string;
}

/** Execute a single job kind. Returns counts + a human-readable log line. */
async function execute(kind: string): Promise<JobOutcome> {
  switch (kind) {
    case 'ingest_gmail': {
      const r = await ingestEmails();
      return {
        itemsCreated: r.possiblesCreated,
        itemsUpdated: r.possiblesUpdated,
        log: `Processed ${r.itemsProcessed} emails → ${r.possiblesCreated} new, ${r.possiblesUpdated} updated possibles`,
      };
    }
    case 'ingest_gcal': {
      const r = await ingestEvents();
      return {
        itemsCreated: r.possiblesCreated + r.blocksCreated,
        itemsUpdated: r.possiblesUpdated,
        log: `Processed ${r.itemsProcessed} events → ${r.blocksCreated} meeting blocks, ${r.possiblesCreated} new possibles`,
      };
    }
    case 'promote_possibles': {
      const r = promotePossibles();
      return { itemsCreated: r.promoted, itemsUpdated: 0, log: `Promoted ${r.promoted}, kept ${r.keptPending} pending` };
    }
    case 'nightly_grooming': {
      const dedupe = await dedupePossibles();
      const overdue = surfaceOverdue();
      const promote = promotePossibles();
      return {
        itemsCreated: promote.promoted,
        itemsUpdated: dedupe.duplicates + overdue,
        log: `Dedupe: ${dedupe.duplicates} dup (embeddings ${dedupe.available ? 'on' : 'off'}); bumped ${overdue} overdue; promoted ${promote.promoted}`,
      };
    }
    case 'auto_schedule': {
      const date = localISODate();
      const r = await runScheduler(date);
      return {
        itemsCreated: r.blocksCreated,
        itemsUpdated: r.blocksRemoved,
        log: `Scheduled ${r.blocksCreated} blocks, removed ${r.blocksRemoved}, ${r.unscheduled} unscheduled`,
      };
    }
    case 'generate_recurrences': {
      const r = generateRecurrences();
      return {
        itemsCreated: r.created,
        itemsUpdated: r.skippedMissed,
        log: `Materialized ${r.created} instances; flagged ${r.skippedMissed} missed habits`,
      };
    }
    default:
      return { itemsCreated: 0, itemsUpdated: 0, log: `Unknown job kind '${kind}'` };
  }
}

/** Run a job by kind, recording a job_runs row and broadcasting start/finish over SSE. */
export async function runJob(kind: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const run = sqlite
    .prepare(
      `INSERT INTO job_runs (job_id, started_at, status)
       SELECT id, ?, 'running' FROM scheduled_jobs WHERE kind = ? RETURNING id`
    )
    .get(startedAt, kind) as { id: number } | undefined;

  broadcast(currentOwnerId(), 'job:started', { kind, startedAt });

  let status = 'done';
  let outcome: JobOutcome = { itemsCreated: 0, itemsUpdated: 0, log: '' };

  try {
    outcome = await execute(kind);
  } catch (err) {
    status = 'error';
    outcome.log = (err as Error).message;
    logger.error(`Job ${kind} failed`, { err: outcome.log });
  }

  const finishedAt = new Date().toISOString();
  if (run) {
    sqlite
      .prepare(
        `UPDATE job_runs SET finished_at = ?, status = ?, items_created = ?, items_updated = ?, log = ? WHERE id = ?`
      )
      .run(finishedAt, status, outcome.itemsCreated, outcome.itemsUpdated, outcome.log, run.id);
  }
  sqlite.prepare('UPDATE scheduled_jobs SET last_run_at = ? WHERE kind = ?').run(finishedAt, kind);

  broadcast(currentOwnerId(), 'job:run', { kind, status, ...outcome, finishedAt });
  logger.info(`Job ${kind} ${status}`, { ...outcome });
}

export function startCronJobs() {
  const jobs = sqlite
    .prepare('SELECT id, kind, cron FROM scheduled_jobs WHERE enabled = 1')
    .all() as { id: number; kind: string; cron: string }[];

  for (const job of jobs) {
    // Cron has no request context — bind the system owner for the job body.
    new Cron(job.cron, () => runWithOwner(SYSTEM_OWNER, () => runJob(job.kind)));
    logger.info(`Cron registered: ${job.kind} [${job.cron}]`);
  }
}
