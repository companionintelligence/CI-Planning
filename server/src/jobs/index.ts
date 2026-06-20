import { Cron } from 'croner';
import { sqlite } from '../db/index.js';
import { generateRecurrences } from '../engine/recurrence-generate.js';
import { fillFlightPlanCandidates } from '../engine/autoplan.js';
import { placeAllPatternsForToday } from '../engine/patterns-place.js';
import { ingestEmails, ingestEvents } from '../agents/ingest.js';
import { promotePossibles, dedupePossibles, surfaceOverdue } from '../agents/groom.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
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
      // Retired (Phase G): Auto no longer packs the backlog into the day. Repurposed
      // to *propose* open-task candidates into the flight-plan; placement is
      // user-triggered via POST /api/auto/run. See engine/autoplan.ts.
      const added = fillFlightPlanCandidates();
      return { itemsCreated: added, itemsUpdated: 0, log: `Proposed ${added} candidates into the flight-plan (auto-pack retired)` };
    }
    case 'generate_recurrences': {
      const r = generateRecurrences();
      return {
        itemsCreated: r.created,
        itemsUpdated: r.missed,
        log: `Materialized ${r.created} instances across ${r.templates} templates; flagged ${r.missed} missed habits`,
      };
    }
    case 'place_patterns': {
      // 06:00 — after generate_recurrences (02:45) and auto_schedule (03:00).
      // Expands every owner's Habit/Routine patterns recurring today and runs
      // placePatternOnDay idempotently. Rituals are excluded (V1 flag).
      const r = placeAllPatternsForToday();
      return {
        itemsCreated: r.blocksCreated,
        itemsUpdated: r.patternsSkipped,
        log: `Considered ${r.patternsConsidered} patterns → placed ${r.patternsPlaced}, skipped ${r.patternsSkipped}, ${r.blocksCreated} blocks`,
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
