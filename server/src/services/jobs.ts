import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { scheduledJobs } from '../db/schema.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Jobs service (Phase W · W12, Decision 3) — extracted from routes/jobs.ts so the REST
 * route AND the GraphQL resolvers share one path. Unlike every other W service these
 * tables (scheduled_jobs / job_runs) are SYSTEM-GLOBAL and owner-less: nothing here is
 * owner-scoped. The admin gate lives at the callers (route + resolver), not here — this
 * layer is pure data access + the audit write, mirroring day-types.ts's writeAudit-in-
 * service split. SSE stays at the caller (the route fires nothing; runJob broadcasts).
 */

export interface ScheduledJobRow {
  id: string;
  name: string;
  kind: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  config: unknown;
}

/** A scheduled_jobs row joined to its latest job_runs row (the shape GET /api/jobs returns).
 *  The `last_*` columns are null when the job has never run. */
export interface ScheduledJobWithLastRun extends ScheduledJobRow {
  last_started: string | null;
  last_status: string | null;
  items_created: number | null;
  items_updated: number | null;
  log: string | null;
}

/** All jobs + their latest run (verbatim from the old GET /api/jobs query). System-global. */
export function listJobs(): ScheduledJobWithLastRun[] {
  return sqlite
    .prepare(
      `SELECT j.*, r.started_at as last_started, r.status as last_status, r.items_created, r.items_updated, r.log
         FROM scheduled_jobs j
         LEFT JOIN job_runs r ON r.id = (
           SELECT id FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC, id DESC LIMIT 1
         )
         ORDER BY j.name`,
    )
    .all() as ScheduledJobWithLastRun[];
}

/** One job by id, or undefined (system-global — no owner predicate). */
export function getJob(id: string): ScheduledJobRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM scheduled_jobs WHERE id = ?`)
    .get(id) as ScheduledJobRow | undefined;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  items_created: number;
  items_updated: number;
  log: string | null;
}

/** The latest run for a job (mirrors GET /api/jobs's join), or undefined if never run.
 *  Ordered started_at DESC (REST parity) with an id DESC tie-break so runs sharing a
 *  second-granularity timestamp still resolve deterministically to the newest (UUIDv7 id). */
export function getLatestRun(jobId: string): JobRunRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get(jobId) as JobRunRow | undefined;
}

/**
 * A page of a job's runs, newest first. Keyset-ordered by (started_at DESC, id DESC) — the
 * same ordering as getLatestRun, and the honest "newest run first" a log wants: UUIDv7 ids
 * are only millisecond-ordered (random within a ms), so id alone can't break a same-second
 * tie, hence the compound key. `after` is `${started_at}|${id}` from the previous page's
 * last edge; pass `limit + 1` to detect a next page. job_runs accumulate unbounded, hence a
 * connection rather than a list.
 */
export function listJobRuns(jobId: string, opts: { after?: JobRunCursor; limit: number }): JobRunRow[] {
  if (opts.after) {
    // Strictly "older than" the cursor under (started_at DESC, id DESC): an earlier
    // started_at, or the same started_at with a smaller id.
    return sqlite
      .prepare(
        `SELECT * FROM job_runs
           WHERE job_id = ?
             AND (started_at < ? OR (started_at = ? AND id < ?))
           ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(jobId, opts.after.startedAt, opts.after.startedAt, opts.after.id, opts.limit) as JobRunRow[];
  }
  return sqlite
    .prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(jobId, opts.limit) as JobRunRow[];
}

export interface JobRunCursor { startedAt: string; id: string }

export function countJobRuns(jobId: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ?`).get(jobId) as { n: number }).n;
}

export type TriggerJobResult =
  | { ok: true; job: { id: string; name: string; kind: string } }
  | { ok: false; error: 'not_found' };

/**
 * Look up a job by id and record the manual-run audit, returning enough for the caller to
 * (a) fire `runJob(job.kind)` async and (b) build its response message. The actual
 * `runJob(...)` fire stays at the caller so both the REST route and the GraphQL resolver
 * keep the identical fire-and-forget `.catch(...)` behavior of the old route. Audit
 * strings (action 'run', entity `job:${job.kind}`, actor 'owner') are copied verbatim
 * from the old route.
 */
export async function triggerJob(id: string): Promise<TriggerJobResult> {
  const [job] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
  if (!job) return { ok: false, error: 'not_found' };
  writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'run', entity: `job:${job.kind}` });
  return { ok: true, job: { id: job.id, name: job.name, kind: job.kind } };
}
