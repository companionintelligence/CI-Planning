import { Cron } from 'croner';
import { sqlite } from '../db/index.js';
import { generateRecurrences } from '../engine/recurrence-generate.js';
import { fillFlightPlanCandidates, autoScheduleOnIngest } from '../engine/autoplan.js';
import { sweepMissedBlocks, requestReplan } from '../engine/auto-defense.js';
import { reviewAndReschedule } from '../engine/review.js';
import { fireDueReminders } from '../engine/reminders.js';
import { ingestEmails, ingestEvents } from '../agents/ingest.js';
import { promotePossibles, dedupePossibles, surfaceOverdue } from '../agents/groom.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { runWithOwner, currentOwnerId, SYSTEM_OWNER } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { snapshot, pruneOldSnapshots, backupDir } from '../lib/backup.js';
import { tagUntaggedTasks } from '../services/auto-tag.js';
import { syncAll } from '../agents/sync.js';
import { config } from '../lib/config.js';
import { gmailLiveAllowed } from '../mcp/gmail-flag.js';
import { join } from 'node:path';

export interface JobOutcome {
  itemsCreated: number;
  itemsUpdated: number;
  log: string;
}

/**
 * TM-5 — best-effort auto-block after a promote. In the Hands-off trust mode this stages
 * the newly-promoted, estimate-bearing tasks and places them (zero-click); a no-op in
 * Cautious/Balanced. Wrapped so a placement hiccup never turns a successful promotion into
 * a failed job — the tasks are already promoted; we just couldn't block them this pass.
 */
function autoBlockAfterPromote(): number {
  try {
    return autoScheduleOnIngest(currentOwnerId(), { requireEstimate: true })?.blocksCreated ?? 0;
  } catch (err) {
    logger.error('auto-block after promote failed', { err: (err as Error).message });
    return 0;
  }
}

/** Execute a single job kind. Returns counts + a human-readable log line. */
async function execute(kind: string): Promise<JobOutcome> {
  switch (kind) {
    case 'ingest_gmail': {
      if (!gmailLiveAllowed()) {
        return { itemsCreated: 0, itemsUpdated: 0, log: 'Gmail ingest skipped — set CP_GOOGLE_ENABLE_GMAIL=true to enable in live mode' };
      }
      const r = await ingestEmails();
      const placed = autoScheduleOnIngest(); // D1: schedule mode places tag-matched in the background; no-op in suggest
      return {
        itemsCreated: r.possiblesCreated,
        itemsUpdated: r.possiblesUpdated,
        log: `Processed ${r.itemsProcessed} emails → ${r.possiblesCreated} new, ${r.possiblesUpdated} updated possibles${placed ? `; auto-placed ${placed.blocksCreated ?? 0}` : ''}`,
      };
    }
    case 'ingest_gcal': {
      // WP5: ingest no longer creates meeting blocks or auto-places. It only produces
      // possibles; the locked meeting mirror + placement live in sync_calendar now (so
      // placement packs around freshly-synced meeting obstacles, not stale ones).
      const r = await ingestEvents();
      return {
        itemsCreated: r.possiblesCreated,
        itemsUpdated: r.possiblesUpdated,
        log: `Processed ${r.itemsProcessed} events → ${r.possiblesCreated} new possibles`,
      };
    }
    case 'promote_possibles': {
      const r = promotePossibles();
      const blocked = autoBlockAfterPromote();
      return { itemsCreated: r.promoted, itemsUpdated: 0, log: `Promoted ${r.promoted}, kept ${r.keptPending} pending${blocked ? `; auto-blocked ${blocked}` : ''}` };
    }
    case 'nightly_grooming': {
      const dedupe = await dedupePossibles();
      const overdue = surfaceOverdue();
      const promote = promotePossibles();
      const blocked = autoBlockAfterPromote();
      return {
        itemsCreated: promote.promoted,
        itemsUpdated: dedupe.duplicates + overdue,
        log: `Dedupe: ${dedupe.duplicates} dup (embeddings ${dedupe.available ? 'on' : 'off'}); bumped ${overdue} overdue; promoted ${promote.promoted}${blocked ? `; auto-blocked ${blocked}` : ''}`,
      };
    }
    case 'auto_schedule': {
      // Retired (Phase G): Auto no longer packs the backlog into the day. Repurposed
      // to *propose* open-task candidates into the flight-plan; placement is
      // user-triggered via POST /api/auto/run. See engine/autoplan.ts.
      const added = fillFlightPlanCandidates();
      // B2 safety net: sweep blocks whose planned time passed without being started,
      // mark them missed, re-stage the work, and request a reactive reflow (debounced,
      // toggle-gated) so the missed task gets re-placed into the remaining day.
      const swept = sweepMissedBlocks();
      if (swept.skipped > 0) requestReplan('missed');
      return {
        itemsCreated: added,
        itemsUpdated: swept.skipped,
        log: `Proposed ${added} candidates into the flight-plan; swept ${swept.skipped} missed block(s) (re-queued ${swept.requeued})`,
      };
    }
    case 'generate_recurrences': {
      const r = generateRecurrences();
      return {
        itemsCreated: r.created,
        itemsUpdated: r.missed,
        log: `Materialized ${r.created} instances across ${r.templates} templates; flagged ${r.missed} missed habits`,
      };
    }
    case 'review_day': {
      // 01:00 — review the day that just closed. Low-priority misses auto-defer
      // (+1/3/7 backoff); high-priority misses are surfaced for the user.
      // Open tasks with no future blocks are re-staged into the flight plan.
      const r = reviewAndReschedule();
      return {
        itemsCreated: r.restaged,
        itemsUpdated: r.deferred + r.surfaced,
        log: `Reviewed ${r.missed} missed → ${r.deferred} auto-deferred, ${r.surfaced} surfaced; re-staged ${r.restaged}`,
      };
    }
    case 'fire_reminders': {
      // 1-minute tick (0044). Claim-by-UPDATE fires each due reminder exactly once;
      // delivery is in-app SSE (per row owner) + Web Push, push-failure → in-app.
      const fired = await fireDueReminders();
      return { itemsCreated: 0, itemsUpdated: fired, log: `Fired ${fired} reminder(s)` };
    }
    case 'tag_tasks': {
      // Hourly pass: tag every untagged top-level open task for the current owner.
      // Shared code path with the AllTasks Auto-tag button so both stay in sync.
      const r = await tagUntaggedTasks(currentOwnerId());
      return { itemsCreated: 0, itemsUpdated: r.tagged, log: r.log };
    }
    case 'sync_calendar': {
      const results = await syncAll();
      const totals = results.reduce(
        (acc, r) => ({
          created: acc.created + r.created,
          updated: acc.updated + r.updated,
          deleted: acc.deleted + r.deleted,
          conflicts: acc.conflicts + r.conflicts,
        }),
        { created: 0, updated: 0, deleted: 0, conflicts: 0 },
      );
      // WP5: place AFTER inbound so the Auto engine packs around the freshly-synced meeting
      // obstacles (the locked inbound blocks applyInbound just created). D1: no-op in suggest.
      const placed = autoScheduleOnIngest();
      // B2: a calendar change shifts the day's obstacles — request a reactive reflow so
      // existing task blocks re-pack around the new meetings (debounced, toggle-gated).
      if (totals.created + totals.updated + totals.deleted > 0) requestReplan('calendar');
      return {
        itemsCreated: totals.created,
        itemsUpdated: totals.updated + totals.deleted,
        log: `Synced ${results.length} connector(s): ${totals.created} created, ${totals.updated} updated, ${totals.deleted} deleted, ${totals.conflicts} conflicts${placed ? `; auto-placed ${placed.blocksCreated ?? 0}` : ''}`,
      };
    }
    case 'snapshot_db': {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = join(backupDir, `companion-${ts}.db`);
      await snapshot(dest);
      pruneOldSnapshots(backupDir, config.snapshotRetain);
      return { itemsCreated: 1, itemsUpdated: 0, log: `snapshot → ${dest}` };
    }
    case 'prune_sync_events': {
      // Phase L: delete sync_events rows older than 30 days. Devices offline longer
      // than that receive sync:resync and do a full refetch anyway, so older rows
      // serve no catch-up purpose. Runs owner-scoped so multi-owner isolation holds.
      const { changes } = sqlite
        .prepare(
          `DELETE FROM sync_events
            WHERE owner_id = ?
              AND at < datetime('now', '-30 days')`,
        )
        .run(currentOwnerId());
      return { itemsCreated: 0, itemsUpdated: changes, log: `Pruned ${changes} sync_event row(s) older than 30 days` };
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
      `INSERT INTO job_runs (id, job_id, started_at, status)
       SELECT uuid7(), id, ?, 'running' FROM scheduled_jobs WHERE kind = ? RETURNING id`
    )
    .get(startedAt, kind) as { id: string } | undefined;

  broadcast(currentOwnerId(), 'job:started', { kind, startedAt });

  let status = 'done';
  let outcome: JobOutcome = { itemsCreated: 0, itemsUpdated: 0, log: '' };

  try {
    outcome = await execute(kind);
    writeAudit({ ownerId: SYSTEM_OWNER, actor: 'system', action: 'job', entity: `job:${kind}` });
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
    .all() as { id: string; kind: string; cron: string }[];

  for (const job of jobs) {
    // Cron has no request context — bind the system owner for the job body.
    new Cron(job.cron, () => runWithOwner(SYSTEM_OWNER, () => runJob(job.kind)));
    logger.info(`Cron registered: ${job.kind} [${job.cron}]`);
  }
}
