import { GraphQLError } from 'graphql';
import { currentScopes } from '../lib/context.js';
import { hasAdminScope } from '../lib/auth/scopes.js';
import { runJob } from '../jobs/index.js';
import {
  listJobs, getJob, getLatestRun, listJobRuns, countJobRuns, triggerJob,
  type ScheduledJobRow, type ScheduledJobWithLastRun, type JobRunRow,
} from '../services/jobs.js';
import { clampFirst, decodeStartedAtCursor, buildStartedAtConnection } from './pagination.js';

/**
 * ScheduledJobType + JobRunType resolvers (Phase W · W12). These reuse services/jobs.ts
 * (Decision 3) — the SAME functions the thin REST /api/jobs route calls.
 *
 * THE INVERSION: scheduled_jobs / job_runs are SYSTEM-GLOBAL, owner-less tables, so NOTHING
 * here is owner-scoped. Security is the ADMIN GATE instead: every entry point (both queries
 * + the mutation) calls assertAdmin() first, throwing FORBIDDEN unless the bound credential
 * carries planning:admin. currentScopes() reads the scopes requireAuth threaded through
 * AsyncLocalStorage (W12), exactly as the resolvers read currentOwnerId() for owner-scoped
 * types. Full-owner sessions carry admin; a narrower credential (or an x-test-scopes-narrowed
 * test caller) is denied — the mirror of the REST route's 403.
 */

/** Throw FORBIDDEN unless the current credential is admin. The single gate for this surface. */
function assertAdmin(): void {
  if (!hasAdminScope(currentScopes())) {
    throw new GraphQLError('admin scope required', { extensions: { code: 'FORBIDDEN' } });
  }
}

type ConnArgs = { first?: number | null; after?: string | null };

export const jobResolvers = {
  Query: {
    scheduledJobs: (): Promise<ScheduledJobWithLastRun[]> => {
      assertAdmin();
      return listJobs();
    },
    scheduledJob: async (_p: unknown, args: { id: string }): Promise<ScheduledJobRow | null> => {
      assertAdmin();
      return (await getJob(args.id)) ?? null;
    },
  },

  Mutation: {
    // Mirrors POST /api/jobs/:id/run: admin-gate, look up + audit via the service, then
    // fire runJob(kind) async (fire-and-forget .catch, exactly as the route) — success
    // means "triggered", not "finished". Reuses DeleteByIdInput { id }.
    runScheduledJob: async (_p: unknown, args: { input: { id: string } }) => {
      assertAdmin();
      const res = await triggerJob(args.input.id);
      if (!res.ok) throw new GraphQLError('job not found', { extensions: { code: 'NOT_FOUND' } });
      runJob(res.job.kind).catch(console.error);
      // Return the fresh job row so the caller can read back its (unchanged-yet) fields.
      return { job: (await getJob(res.job.id)) ?? null, success: true, message: `Job ${res.job.name} triggered` };
    },
  },

  ScheduledJobType: {
    // enabled is stored 0/1 (SQLite bool); coerce to a real Boolean for the non-null field.
    enabled: (j: ScheduledJobRow) => !!j.enabled,
    lastRunAt: (j: ScheduledJobRow) => j.last_run_at,
    nextRunAt: (j: ScheduledJobRow) => j.next_run_at,
    lastRun: async (j: ScheduledJobRow): Promise<JobRunRow | null> => (await getLatestRun(j.id)) ?? null,
    runs: async (j: ScheduledJobRow, args: ConnArgs) => {
      const limit = clampFirst(args.first);
      const after = decodeStartedAtCursor(args.after);
      const rows = await listJobRuns(j.id, { after: after ?? undefined, limit: limit + 1 });
      return buildStartedAtConnection(rows, limit, await countJobRuns(j.id));
    },
  },

  JobRunType: {
    startedAt: (r: JobRunRow) => r.started_at,
    finishedAt: (r: JobRunRow) => r.finished_at,
    itemsCreated: (r: JobRunRow) => r.items_created ?? 0,
    itemsUpdated: (r: JobRunRow) => r.items_updated ?? 0,
    // Non-null back-reference: the parent job. Throw (never null) if the FK is dangling —
    // a run with no owning job is a data-integrity fault the non-null type must surface.
    job: async (r: JobRunRow): Promise<ScheduledJobRow> => {
      const job = await getJob(r.job_id);
      if (!job) throw new GraphQLError('owning job not found', { extensions: { code: 'NOT_FOUND' } });
      return job;
    },
  },
};
