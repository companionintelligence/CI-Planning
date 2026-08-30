import { Cron } from 'croner';
import { store } from '../db/store.js';
import { generateRecurrences } from '../engine/recurrence-generate.js';
import { fillFlightPlanCandidates, autoScheduleOnIngest } from '../engine/autoplan.js';
import { sweepMissedBlocks, requestReplan } from '../engine/auto-defense.js';
import { reviewAndReschedule } from '../engine/review.js';
import { fireDueReminders } from '../engine/reminders.js';
import { ingestEmails, ingestEvents, type IngestResult } from '../agents/ingest.js';
import { createGoogleClient } from '../mcp/google.js';
import { googleAccounts } from '../connectors/index.js';
import { suggestFromMemory } from '../agents/memory-suggest.js';
import { syncToMemory } from '../services/memory.js';
import { promotePossibles, dedupePossibles, surfaceOverdue } from '../agents/groom.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { runWithOwner, currentOwnerId, SYSTEM_OWNER } from '../lib/context.js';
import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN } from '../lib/auth/types.js';
import { writeAudit } from '../lib/audit.js';
import { snapshot, pruneOldSnapshots, backupDir } from '../lib/backup.js';
import { tagUntaggedTasks } from '../services/auto-tag.js';
import { enrichRecentTasks } from '../services/task-enrich.js';
import { syncAll } from '../agents/sync.js';
import { advanceObjectives } from './advance-objectives.js';
import { calibrateEstimates } from './calibrate-estimates.js';
import { calibrateTriality } from '../services/triality-learning.js';
import { calibrateClassification } from '../services/classification-learning.js';
import { ollamaScorer } from '../services/classification-score.js';
import { calibratePlanLoop } from '../services/plan-loop-learning.js';
import { freezeStars } from './freeze-stars.js';
import { resetRoutineTasks } from './reset-routines.js';
import { config } from '../lib/config.js';
import { gmailLiveAllowed } from '../mcp/gmail-flag.js';
import { join } from 'node:path';

export interface JobOutcome {
  itemsCreated: number;
  itemsUpdated: number;
  log: string;
}

/** FTUE · T12 (#348) — what `runJob` hands back to a caller that awaits it. */
export interface JobRunResult extends JobOutcome {
  kind: string;
  status: string;
}

/**
 * TM-5 — best-effort auto-block after a promote. In the Hands-off trust mode this stages
 * the newly-promoted, estimate-bearing tasks and places them (zero-click); a no-op in
 * Cautious/Balanced. Wrapped so a placement hiccup never turns a successful promotion into
 * a failed job — the tasks are already promoted; we just couldn't block them this pass.
 */
async function autoBlockAfterPromote(): Promise<number> {
  try {
    return (await autoScheduleOnIngest(currentOwnerId(), { requireEstimate: true }))?.blocksCreated ?? 0;
  } catch (err) {
    logger.error('auto-block after promote failed', { err: (err as Error).message });
    return 0;
  }
}

/** Zeroed ingest counters — the per-account loop below sums into this. */
function emptyIngestTotals(): IngestResult {
  return { itemsProcessed: 0, possiblesCreated: 0, possiblesUpdated: 0, blocksCreated: 0, promoted: 0, duplicates: 0, failed: 0 };
}

function addIngestTotals(a: IngestResult, b: IngestResult): IngestResult {
  return {
    itemsProcessed: a.itemsProcessed + b.itemsProcessed,
    possiblesCreated: a.possiblesCreated + b.possiblesCreated,
    possiblesUpdated: a.possiblesUpdated + b.possiblesUpdated,
    blocksCreated: a.blocksCreated + b.blocksCreated,
    promoted: a.promoted + b.promoted,
    duplicates: a.duplicates + b.duplicates,
    failed: a.failed + b.failed,
  };
}

/** Execute a single job kind. Returns counts + a human-readable log line. */
async function execute(kind: string): Promise<JobOutcome> {
  switch (kind) {
    case 'ingest_gmail': {
      if (config.google.mode === 'off') {
        return { itemsCreated: 0, itemsUpdated: 0, log: 'Google integration off (GOOGLE_MODE unset) — skipped' };
      }
      if (!gmailLiveAllowed()) {
        return { itemsCreated: 0, itemsUpdated: 0, log: 'Gmail ingest skipped — set CP_GOOGLE_ENABLE_GMAIL=true to enable in live mode' };
      }
      // Live mode ingests ONLY the owner's connected accounts (same posture as
      // sync_calendar via getConnectors): no connection ⇒ clean no-op, and each
      // account gets its own client/watermark instead of the env-default 'primary'.
      // Fixture mode (explicit dev/demo opt-in) keeps the single canned client.
      let r = emptyIngestTotals();
      if (config.google.mode === 'live') {
        const accounts = await googleAccounts();
        if (accounts.length === 0) {
          return { itemsCreated: 0, itemsUpdated: 0, log: 'No Google account connected — skipped (connect one in Settings)' };
        }
        for (const account of accounts) {
          // finally-close: the live client owns an MCP child process holding a bearer
          // token; this job runs every 30 minutes per account, so skipping the close
          // leaks one child per run for the lifetime of the server.
          const client = createGoogleClient({ account });
          try {
            r = addIngestTotals(r, await ingestEmails(client, { account }));
          } finally {
            await client.close();
          }
        }
      } else {
        r = addIngestTotals(r, await ingestEmails());
      }
      const placed = await autoScheduleOnIngest(); // D1: schedule mode places tag-matched in the background; no-op in suggest
      return {
        itemsCreated: r.possiblesCreated,
        itemsUpdated: r.possiblesUpdated,
        // Email is review-gated: nothing is auto-promoted, so the log says "awaiting
        // review" rather than claiming a promotion count that is now always 0.
        log: `Processed ${r.itemsProcessed} emails → ${r.possiblesCreated} new suggestion(s) awaiting review, ${r.possiblesUpdated} updated (${r.duplicates} duplicate(s))${r.failed ? `, ${r.failed} failed` : ''}${placed ? `; auto-placed ${placed.blocksCreated ?? 0}` : ''}`,
      };
    }
    case 'ingest_gcal': {
      // WP5: ingest no longer creates meeting blocks or auto-places. It only produces
      // possibles; the locked meeting mirror + placement live in sync_calendar now (so
      // placement packs around freshly-synced meeting obstacles, not stale ones).
      if (config.google.mode === 'off') {
        return { itemsCreated: 0, itemsUpdated: 0, log: 'Google integration off (GOOGLE_MODE unset) — skipped' };
      }
      let r = emptyIngestTotals();
      if (config.google.mode === 'live') {
        const accounts = await googleAccounts();
        if (accounts.length === 0) {
          return { itemsCreated: 0, itemsUpdated: 0, log: 'No Google account connected — skipped (connect one in Settings)' };
        }
        for (const account of accounts) {
          const client = createGoogleClient({ account });
          try {
            r = addIngestTotals(r, await ingestEvents(client));
          } finally {
            await client.close();
          }
        }
      } else {
        r = addIngestTotals(r, await ingestEvents());
      }
      return {
        itemsCreated: r.possiblesCreated,
        itemsUpdated: r.possiblesUpdated,
        log: `Processed ${r.itemsProcessed} events → ${r.possiblesCreated} new possibles; auto-promoted ${r.promoted} (${r.duplicates} duplicate(s))${r.failed ? `, ${r.failed} failed` : ''}`,
      };
    }
    case 'memory_suggest': {
      // AA1: pull the next-48h CI-Server memory graph and stage inbox suggestions.
      // Gated inside the agent (memory_pull_enabled + connector availability), so a
      // flag-off / creds-less owner is a logged no-op, never an error.
      const r = await suggestFromMemory();
      if (r.status !== 'ran') {
        return {
          itemsCreated: 0,
          itemsUpdated: 0,
          log: r.status === 'flag_off' ? 'Memory pull disabled — skipped' : 'Companion Memory unavailable — skipped',
        };
      }
      return {
        itemsCreated: r.created,
        itemsUpdated: r.updated,
        log: `Pulled ${r.pulled} upcoming memory event(s) → ${r.created} new, ${r.updated} refreshed suggestion(s); auto-promoted ${r.promoted} (${r.duplicates} duplicate(s))${r.failed ? `, ${r.failed} failed` : ''}; skipped ${r.skippedDismissed} dismissed, ${r.skippedCap} over cap`,
      };
    }
    case 'push_memory': {
      // AA4: one-way push of the owner's completed tasks / habits / reflections to
      // CI-Server. Gated inside syncToMemory (memory_sync_enabled + connection +
      // creds), so a flag-off / not-connected / creds-less owner is a clean no-op
      // log, never an error. itemsUpdated = total events pushed this pass.
      const r = await syncToMemory(currentOwnerId());
      if (!r.ok) {
        const why =
          r.reason === 'disabled'
            ? 'Memory sync disabled'
            : r.reason === 'not_connected'
              ? 'Companion Memory not connected'
              : 'Companion Memory unavailable';
        return { itemsCreated: 0, itemsUpdated: 0, log: `${why} — skipped` };
      }
      const c = r.counts;
      const pushed = c.completed + c.habits + c.reflections;
      // Fixture mode does no network — its "ingested" tally is simulated. Say so,
      // rather than logging a push that never left the box. (transport comes from the
      // sync result itself, so the log can't diverge from what the service actually did.)
      const log =
        r.transport === 'fixture'
          ? `Fixture mode — simulated push of ${pushed} event(s) (${c.completed} completed, ${c.habits} habit(s), ${c.reflections} reflection(s)); nothing sent to CI-Server`
          : `Pushed ${pushed} event(s) (${c.completed} completed, ${c.habits} habit(s), ${c.reflections} reflection(s)) → ingested ${c.ingested}, duplicate ${c.duplicate}, rejected ${c.rejected}`;
      return { itemsCreated: 0, itemsUpdated: pushed, log };
    }
    case 'promote_possibles': {
      // AF-3: the standalone cron row was retired (0118; nightly_grooming subsumes it),
      // but the kind stays executable for manual runs. Promotion is unconditional now.
      // AF-CU1: owner-scoped — the fan-out (or manual run) sweeps only this owner's
      // rows. NULL-owner legacy rows are claimed deterministically by the DEFAULT
      // owner's run only (claimLegacy), never by whichever owner happens to run first.
      const owner = currentOwnerId();
      const r = await promotePossibles(owner, { claimLegacy: owner === SYSTEM_OWNER });
      const blocked = await autoBlockAfterPromote();
      return { itemsCreated: r.promoted, itemsUpdated: 0, log: `Promoted ${r.promoted}${r.failed ? `, ${r.failed} failed` : ''}${blocked ? `; auto-blocked ${blocked}` : ''}` };
    }
    case 'nightly_grooming': {
      // AF-3: producers auto-promote at ingestion, so dedupe is usually a no-op here
      // and promote is the straggler SWEEPER (unconditional — no trust gate/threshold).
      // AF-CU1: all three sweeps are owner-scoped — this kind fans out per owner, so an
      // unscoped pass would let the first owner's run process (and be credited for)
      // every owner's rows. NULL-owner legacy rows: default owner's run only (claimLegacy).
      const owner = currentOwnerId();
      // TWO dedupe passes, partitioned by review gate. Without the 'review' pass the
      // email queue never gets semantic dedupe at all; without the partition, a lingering
      // pending email row can mark a NEWER auto-pool row duplicate (rows sort id ASC and
      // uuid7 is time-ordered). See dedupePossibles' docstring.
      const dedupeAuto = await dedupePossibles({ owner, scope: 'auto' });
      const dedupeReview = await dedupePossibles({ owner, scope: 'review' });
      const dedupe = {
        duplicates: dedupeAuto.duplicates + dedupeReview.duplicates,
        available: dedupeAuto.available && dedupeReview.available,
      };
      const overdue = await surfaceOverdue(owner);
      const promote = await promotePossibles(owner, { claimLegacy: owner === SYSTEM_OWNER });
      const blocked = await autoBlockAfterPromote();
      return {
        itemsCreated: promote.promoted,
        itemsUpdated: dedupe.duplicates + overdue,
        log: `Dedupe: ${dedupe.duplicates} dup (embeddings ${dedupe.available ? 'on' : 'off'}); bumped ${overdue} overdue; promoted ${promote.promoted}${promote.failed ? `, ${promote.failed} failed` : ''}${blocked ? `; auto-blocked ${blocked}` : ''}`,
      };
    }
    case 'auto_schedule': {
      // Retired (Phase G): Auto no longer packs the backlog into the day. Repurposed
      // to *propose* open-task candidates into the flight-plan; placement is
      // user-triggered via POST /api/auto/run. See engine/autoplan.ts.
      const added = await fillFlightPlanCandidates();
      // B2 safety net: sweep blocks whose planned time passed without being started,
      // mark them missed, re-stage the work, and request a reactive reflow (debounced,
      // toggle-gated) so the missed task gets re-placed into the remaining day.
      const swept = await sweepMissedBlocks();
      if (swept.skipped > 0) requestReplan('missed');
      return {
        itemsCreated: added,
        itemsUpdated: swept.skipped,
        log: `Proposed ${added} candidates into the flight-plan; swept ${swept.skipped} missed block(s) (re-queued ${swept.requeued})`,
      };
    }
    case 'generate_recurrences': {
      const r = await generateRecurrences();
      return {
        itemsCreated: r.created,
        itemsUpdated: r.missed,
        log: `Materialized ${r.created} instances across ${r.templates} templates; flagged ${r.missed} missed habits`,
      };
    }
    case 'review_day': {
      // 01:00 — review the day that just closed. EVERY missed task auto-defers
      // (+1/3/7 backoff, unified 2026-07-20); stuck 'missed' one-offs are revived;
      // hands_off owners get reopened tasks placed into their new day right away.
      // Open tasks with no future blocks are re-staged into the flight plan.
      const r = await reviewAndReschedule();
      return {
        itemsCreated: r.restaged,
        itemsUpdated: r.deferred + r.revived,
        log: `Reviewed ${r.missed} missed → ${r.deferred} auto-deferred, ${r.revived} revived, ${r.placed} placed; re-staged ${r.restaged}`,
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
    case 'enrich_tasks': {
      // Nightly memory pass: fill description + direction for recent under-described
      // tasks. Shared code path with the per-task enrich button. Skips honestly (and
      // cheaply) when MEMORY_MODE is unset — the log says so rather than reporting 0.
      const r = await enrichRecentTasks(currentOwnerId());
      return { itemsCreated: 0, itemsUpdated: r.enriched, log: r.log };
    }
    case 'sync_calendar': {
      // Same honest skip the ingest jobs have — getConnectors() also gates itself on
      // mode 'off' (defense in depth), but a skip here logs WHY nothing synced.
      if (config.google.mode === 'off') {
        return { itemsCreated: 0, itemsUpdated: 0, log: 'Google integration off (GOOGLE_MODE unset) — skipped' };
      }
      const results = await syncAll();
      const totals = results.reduce(
        (acc, r) => ({
          created: acc.created + r.created,
          updated: acc.updated + r.updated,
          deleted: acc.deleted + r.deleted,
          conflicts: acc.conflicts + r.conflicts,
          errors: acc.errors + r.errors.length,
        }),
        { created: 0, updated: 0, deleted: 0, conflicts: 0, errors: 0 },
      );
      // Fail loudly when EVERY connector failed. Previously the reducer ignored
      // r.errors entirely, so a wholly dead integration returned status 'done' with
      // all-zero counts — indistinguishable from "nothing to sync", which is how a
      // broken calendar can look healthy in the Jobs UI indefinitely. A partial
      // failure still reports done (some work landed) but names the failures.
      const failed = results.filter((r) => r.errors.length > 0);
      if (results.length > 0 && failed.length === results.length) {
        throw new Error(
          `all ${results.length} calendar connector(s) failed: ` +
            failed.map((r) => `${r.provider}/${r.account}: ${r.errors[0]}`).join('; '),
        );
      }
      // WP5: place AFTER inbound so the Auto engine packs around the freshly-synced meeting
      // obstacles (the locked inbound blocks applyInbound just created). D1: no-op in suggest.
      const placed = await autoScheduleOnIngest();
      // B2: a calendar change shifts the day's obstacles — request a reactive reflow so
      // existing task blocks re-pack around the new meetings (debounced, toggle-gated).
      if (totals.created + totals.updated + totals.deleted > 0) requestReplan('calendar');
      return {
        itemsCreated: totals.created,
        itemsUpdated: totals.updated + totals.deleted,
        log: `Synced ${results.length} connector(s): ${totals.created} created, ${totals.updated} updated, ${totals.deleted} deleted, ${totals.conflicts} conflicts${totals.errors ? `, ${totals.errors} error(s) on ${failed.length} connector(s)` : ''}${placed ? `; auto-placed ${placed.blocksCreated ?? 0}` : ''}`,
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
      // serve no catch-up purpose. Retention is age-based + per-row, so prune ALL
      // owners in one pass (T3: this kind runs once globally, not per owner — the
      // old owner-scoped predicate would have left every non-first owner's rows to
      // grow unbounded under multi-tenant).
      const { changes } = await store()
        .prepare(`DELETE FROM sync_events WHERE at < datetime('now', '-30 days')`)
        .run();
      return { itemsCreated: 0, itemsUpdated: changes, log: `Pruned ${changes} sync_event row(s) older than 30 days` };
    }
    case 'purge_objectives': {
      // Reap objectives whose 48h "delete permanently" window has expired (0129/0130).
      // GLOBAL, not per-owner: purge_after is an absolute UTC deadline with no owner-tz
      // dependency, so this is the prune_sync_events shape — owner-scoping this kind of
      // age-based retention was a bug there, and would be here.
      //
      // The whole archived subtree shares a purge_after (requestPurge stamps across
      // archive_root_id), so it goes atomically. That matters: objectives.parent_id is
      // ON DELETE SET NULL, so purging a parent while a child survived would silently
      // re-root the child at top level, 48h later, with no user action.
      //
      // Zero rows is the normal case and must NOT throw — runJob would mark the run
      // red. Deletions are reported in itemsUpdated (prune_sync_events precedent).
      const { changes } = await store()
        .prepare(`DELETE FROM objectives WHERE purge_after IS NOT NULL AND purge_after < ?`)
        .run(new Date().toISOString());
      return { itemsCreated: 0, itemsUpdated: changes, log: `Purged ${changes} objective(s) past the reversal window` };
    }
    case 'advance_objectives': {
      const r = await advanceObjectives();
      return {
        itemsCreated: r.nominated,
        itemsUpdated: r.skipped,
        log: `Nominated ${r.nominated} objective next-action task(s); skipped ${r.skipped}`,
      };
    }
    case 'calibrate_triality': {
      // §6b — bounded batch learning. Owner-scoped (see OWNER_SCOPED_KINDS): the
      // cron fans this out per owner, and each pass reads only that owner's log.
      // A cron/agent write, so it deliberately does NOT stamp owner attribution
      // (WHO rule, owner ruling 2026-07-16).
      const r = await calibrateTriality(currentOwnerId(), new Date());
      const label = r.slotsWritten > 0
        ? `${r.slotsWritten} slot(s) tuned from ${r.outcomeRows} outcome(s)`
        : `no slot cleared the ${r.floor}-outcome floor (${r.outcomeRows} outcome(s)) — defaults stand`;
      return { itemsCreated: 0, itemsUpdated: r.slotsWritten, log: `Triality calibration: ${label}` };
    }
    case 'calibrate_classification': {
      // Phase 8 — bounded batch learning for the parse/classify LLM. Owner-scoped
      // (see OWNER_SCOPED_KINDS): every read filters on the owner, and evidence is
      // never pooled across owners. A cron/agent write, so it deliberately does NOT
      // stamp owner attribution (WHO rule, owner ruling 2026-07-16).
      const owner = currentOwnerId();
      // No Ollama ⇒ no scorer ⇒ the index is still rebuilt from durable evidence and
      // accuracy is recorded as "not measured". Learning does not require the model;
      // only MEASURING it does.
      const r = await calibrateClassification(owner, new Date(), { scoreFn: await ollamaScorer(owner) });
      const indexed = r.fields.reduce((n, f) => n + f.indexed, 0);
      const parts = r.fields.map((f) =>
        f.indexed === 0
          ? `${f.field}: ${f.corrections} correction(s), under the ${r.floor} floor — stock prompt stands`
          : `${f.field}: ${f.indexed} exemplar(s) from ${f.corrections} correction(s)` +
            (f.accuracy == null ? ', accuracy not measured' : `, ${Math.round(f.accuracy * 100)}% on ${f.heldOut} held out`),
      );
      return { itemsCreated: 0, itemsUpdated: indexed, log: `Classification calibration — ${parts.join('; ')}` };
    }
    case 'calibrate_estimates': {
      const r = await calibrateEstimates();
      const label = r.bias_ratio != null
        ? `bias_ratio=${r.bias_ratio.toFixed(2)} (n=${r.sample_count})`
        : 'no timed tasks yet';
      const scoped = r.scopes != null ? `, ${r.scopes} scope(s)` : '';
      return { itemsCreated: 0, itemsUpdated: r.sample_count, log: `Estimate calibration: ${label}${scoped}` };
    }
    case 'calibrate_plan_loop': {
      // Phase M §A0 — the weekly deterministic BATCH pass over `plan_loop_runs`.
      // Owner-scoped (see OWNER_SCOPED_KINDS): every read filters on the owner, and
      // evidence is never pooled across owners. Pure SQL aggregation — no Ollama, no
      // audit_log read. A cron/agent write, so it deliberately does NOT stamp owner
      // attribution (WHO rule, owner ruling 2026-07-16).
      const r = await calibratePlanLoop(currentOwnerId(), new Date());
      const parts = r.stages.map((s) =>
        `${s.stage}: ${s.runs} run(s), ${Math.round((s.passRate ?? 0) * 100)}% pass, ` +
          `${s.escaped} escape(s), avg ${(s.avgIterations ?? 0).toFixed(1)} iteration(s)`,
      );
      const label = parts.length > 0 ? parts.join('; ') : 'no runs in the last 7 days — nothing to measure';
      return { itemsCreated: 0, itemsUpdated: r.stages.length, log: `Plan-loop stats — ${label}` };
    }
    case 'freeze_stars': {
      // Freezing is an INSERT (first-freeze-wins): a create, or a no-op if the
      // day was already frozen — never an update. Report counters accordingly.
      const r = await freezeStars();
      return {
        itemsCreated: r.created ? 1 : 0,
        itemsUpdated: 0,
        log: r.created
          ? `Froze day stars for ${r.date}: ${r.total}/5`
          : `Day stars for ${r.date} already frozen (${r.total}/5) — no-op`,
      };
    }
    case 'reset_routines': {
      // Midnight: Routine tasks are a repeatable checklist — never archived. Flip any
      // completed routine member back to open so the routine is fresh for the new day.
      const r = await resetRoutineTasks();
      return { itemsCreated: 0, itemsUpdated: r.reset, log: `Reset ${r.reset} completed routine task(s) to open` };
    }
    default:
      return { itemsCreated: 0, itemsUpdated: 0, log: `Unknown job kind '${kind}'` };
  }
}

/** Run a job by kind, recording a job_runs row and broadcasting start/finish over SSE. */
export async function runJob(kind: string): Promise<JobRunResult> {
  const startedAt = new Date().toISOString();
  const run = await store()
    .prepare(
      `INSERT INTO job_runs (id, job_id, started_at, status)
       SELECT uuid7(), id, ?, 'running' FROM scheduled_jobs WHERE kind = ? RETURNING id`
    )
    .get<{ id: string }>(startedAt, kind);

  broadcast(currentOwnerId(), 'job:started', { kind, startedAt });

  let status = 'done';
  let outcome: JobOutcome = { itemsCreated: 0, itemsUpdated: 0, log: '' };

  try {
    outcome = await execute(kind);
    // Audit under the owner this run is bound to (the cron fans owner-scoped kinds
    // out per owner via runWithOwner), not a hardcoded SYSTEM_OWNER.
    writeAudit({ ownerId: currentOwnerId(), actor: 'system', action: 'job', entity: `job:${kind}` });
  } catch (err) {
    status = 'error';
    outcome.log = (err as Error).message;
    logger.error(`Job ${kind} failed`, { err: outcome.log });
  }

  const finishedAt = new Date().toISOString();
  if (run) {
    await store()
      .prepare(
        `UPDATE job_runs SET finished_at = ?, status = ?, items_created = ?, items_updated = ?, log = ? WHERE id = ?`
      )
      .run(finishedAt, status, outcome.itemsCreated, outcome.itemsUpdated, outcome.log, run.id);
  }
  await store().prepare('UPDATE scheduled_jobs SET last_run_at = ? WHERE kind = ?').run(finishedAt, kind);

  broadcast(currentOwnerId(), 'job:run', { kind, status, ...outcome, finishedAt });
  logger.info(`Job ${kind} ${status}`, { ...outcome });
  return { kind, status, ...outcome };
}

/**
 * Kinds whose work is per-owner: the cron must run them once PER owner, or under
 * multi-tenant they'd silently serve only owner #1. Everything else runs once —
 * review_day and fire_reminders iterate owners internally, snapshot_db is a single
 * DB-file copy, and prune_sync_events prunes globally by age.
 */
/** Jobs run as themselves — trusted system maintenance — so they carry every scope
 *  (incl. admin) inside their runWithOwner binding (W12). */
const JOB_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];

const OWNER_SCOPED_KINDS = new Set([
  'ingest_gmail',
  'ingest_gcal',
  'memory_suggest',
  'push_memory',
  'promote_possibles',
  'nightly_grooming',
  'auto_schedule',
  'generate_recurrences',
  'tag_tasks',
  'enrich_tasks',
  'sync_calendar',
  'advance_objectives',
  'calibrate_estimates',
  // Triality learning (§6b): weights are per-owner by construction — a shared
  // pass would pool one owner's feedback into another's ranking, which the design
  // rules out absolutely (no cross-owner learning, ever).
  'calibrate_triality',
  // Phase 8: the correction log is per-owner by construction — one owner's vocabulary
  // must never teach another's classifier.
  'calibrate_classification',
  // Phase M §A0: plan-loop evidence is per-owner by construction, never pooled.
  'calibrate_plan_loop',
  'freeze_stars',
  'reset_routines',
]);

async function allOwnerIds(): Promise<string[]> {
  return (await store().prepare('SELECT id FROM owners').all<{ id: string }>()).map((o) => o.id);
}

/**
 * Run a job the way the scheduler does: once per owner for owner-scoped kinds (each
 * inside its own runWithOwner, so currentOwnerId() — and thus every owner-scoped
 * read/write, SSE broadcast and audit row — is that owner), once under the system
 * owner for global kinds. Owners are enumerated at run time so a freshly-provisioned
 * owner is picked up on the next tick. runJob never throws (it catches internally),
 * so one owner's failure doesn't stop the rest.
 *
 * The manual POST /api/jobs/:id/run path calls runJob directly under the requesting
 * owner's context — it does NOT fan out (a user "run now" is for their own account).
 */
/**
 * Kinds whose previous scheduled run hasn't returned yet.
 *
 * A cron tick must never start a job kind that is still running. `ingest_gcal` over a
 * freshly-connected calendar takes far longer than its 30-minute period (it embeds every
 * pending possible through Ollama one at a time), so without this each tick piled a fresh
 * fan-out on top of the last — nine concurrent runs, each spawning its own MCP child, all
 * grinding the same rows.
 *
 * In-process rather than a DB flag ON PURPOSE: the thing being guarded is "this server is
 * already doing it", and a row can outlive the process that wrote it. A DB lock would
 * need its own liveness story (see the restart sweep in boot) and could wedge the
 * scheduler permanently after an unclean exit.
 */
const inFlight = new Set<string>();

/**
 * Mark job_runs left `running` by a previous process as errored.
 *
 * A run row is only ever finished by the process that created it, so any `running` row at
 * startup belongs to a process that is gone. Left alone they accumulate forever and make
 * the Jobs view claim work is in progress that nothing is doing. Called once at boot.
 */
export async function failInterruptedJobRuns(): Promise<number> {
  const { changes } = await store()
    .prepare(
      `UPDATE job_runs SET status = 'error', finished_at = ?, log = 'interrupted — server restarted'
        WHERE status = 'running'`,
    )
    .run(new Date().toISOString());
  if (changes > 0) logger.warn('Cleared interrupted job runs from a previous process', { count: changes });
  return changes;
}

export async function runScheduledJob(kind: string): Promise<void> {
  // Skip rather than queue: these are periodic refreshes, so the next tick is a better
  // answer than a backlog of identical runs racing each other.
  if (inFlight.has(kind)) {
    logger.warn(`Scheduled job ${kind} skipped — the previous run is still going`);
    return;
  }
  inFlight.add(kind);
  try {
    await runScheduledJobInner(kind);
  } finally {
    inFlight.delete(kind);
  }
}

async function runScheduledJobInner(kind: string): Promise<void> {
  if (OWNER_SCOPED_KINDS.has(kind)) {
    for (const ownerId of await allOwnerIds()) {
      try {
        await runWithOwner(ownerId, JOB_SCOPES, () => runJob(kind));
      } catch (err) {
        logger.error(`Scheduled job ${kind} failed for owner ${ownerId}`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }

  try {
    await runWithOwner(SYSTEM_OWNER, JOB_SCOPES, () => runJob(kind));
  } catch (err) {
    logger.error(`Scheduled job ${kind} failed`, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * FTUE · T12 (#348) — the kinds a "Run my first sync now" click triggers: mirror
 * calendar events as locked meeting blocks first (`sync_calendar`), then mine
 * calendar/email for possibles (`ingest_gcal`/`ingest_gmail` — WP5: these only
 * extract + auto-promote, they place nothing themselves), then let grooming
 * (`nightly_grooming`) sweep and auto-block anything staged earlier in this same
 * pass. The exact ingest_gcal/ingest_gmail ordering doesn't matter — neither places
 * blocks on its own, and nightly_grooming's sweep at the end catches whatever either
 * one staged regardless of which ran first. All four are owner-scoped
 * (`OWNER_SCOPED_KINDS`), so calling `runJob` directly under the CURRENT owner's
 * context (already bound by `requireAuth`) is correct — this deliberately does NOT
 * fan out across owners like `runScheduledJob` does; see its own doc comment above
 * ("a user 'run now' is for their own account").
 */
export const RUN_NOW_KINDS = ['sync_calendar', 'ingest_gcal', 'ingest_gmail', 'nightly_grooming'] as const;

/** Trigger the current owner's own ingest right now instead of waiting for the cron.
 *  Sequential — `runJob` never throws, so one kind failing doesn't stop the rest. */
export async function runIngestNow(): Promise<JobRunResult[]> {
  const results: JobRunResult[] = [];
  for (const kind of RUN_NOW_KINDS) {
    results.push(await runJob(kind));
  }
  return results;
}

export async function startCronJobs() {
  const jobs = await store()
    .prepare('SELECT id, kind, cron FROM scheduled_jobs WHERE enabled = 1')
    .all<{ id: string; kind: string; cron: string }>();

  for (const job of jobs) {
    new Cron(job.cron, () => runScheduledJob(job.kind));
    logger.info(
      `Cron registered: ${job.kind} [${job.cron}]${OWNER_SCOPED_KINDS.has(job.kind) ? ' (per-owner)' : ''}`
    );
  }
}
