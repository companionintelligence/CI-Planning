import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';

/**
 * Phase W · W12 — ScheduledJobType + JobRunType end-to-end over HTTP. These tables are
 * SYSTEM-GLOBAL (owner-less), so there is NO owner-scoping test — the security test is the
 * ADMIN GATE instead: a non-admin caller (simulated via the test-only `x-test-scopes`
 * header) gets FORBIDDEN on the GraphQL queries/mutation AND 403 on REST GET /api/jobs,
 * while the default (admin) path works. Also covers the lastRun/runs field resolvers, the
 * non-null JobRunType.job back-reference, and runScheduledJob's async trigger.
 */
let srv: TestServer;

// A read+write-but-not-admin credential — reaches the resolvers (write scope satisfies the
// POST→planning:write gate in requireAuth) but fails the resolver's admin check.
const NON_ADMIN = { 'x-test-scopes': 'planning:read,planning:write' };

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  return { status: res.status, body };
}

/** Seed a scheduled_jobs row directly (system-global; not owned). Returns its id. */
function seedJob(name: string, kind: string, cron = '0 0 * * *', opts: { enabled?: number; lastRunAt?: string | null } = {}): string {
  const id = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;
  sqlite
    .prepare(`INSERT INTO scheduled_jobs (id, name, kind, cron, enabled, last_run_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, name, kind, cron, opts.enabled ?? 1, opts.lastRunAt ?? null);
  return id;
}

/**
 * Seed a job_runs row for a job. Returns its id. Uses an explicit, strictly-increasing
 * `started_at` per call so the newest-first ordering is deterministic — UUIDv7 ids are
 * only ms-ordered (random within a ms), so seeding several rows in one tick would leave
 * both the id and started_at orders ambiguous. In production runs are minutes/hours apart.
 */
let runSeq = 0;
function seedRun(jobId: string, status = 'done', opts: { itemsCreated?: number; itemsUpdated?: number; log?: string } = {}): string {
  const id = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;
  // Distinct, increasing timestamps (2026-01-01T00:00:00Z + N seconds).
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, runSeq++)).toISOString();
  sqlite
    .prepare(
      `INSERT INTO job_runs (id, job_id, started_at, finished_at, status, items_created, items_updated, log)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, jobId, startedAt, startedAt, status, opts.itemsCreated ?? 0, opts.itemsUpdated ?? 0, opts.log ?? null);
  return id;
}

// The scheduled_jobs table is migration-seeded and SHARED across the whole (pid-keyed,
// sequential) test DB — later files (jobs.test.ts, jobs-multiowner.test.ts, connections.test.ts)
// rely on those seeded rows. This file needs an EMPTY table to assert exact job sets, so it
// snapshots the seeded rows in beforeAll and restores them in afterAll — never leaving the
// shared table clobbered for a subsequent file.
let seededJobs: Record<string, unknown>[] = [];

beforeAll(async () => {
  srv = await startTestServer();
  seededJobs = sqlite.prepare(`SELECT * FROM scheduled_jobs`).all() as Record<string, unknown>[];
});
afterAll(async () => {
  // Restore the seeded jobs exactly as they were, so downstream files see the seed intact.
  sqlite.exec(`DELETE FROM job_runs; DELETE FROM scheduled_jobs;`);
  if (seededJobs.length) {
    const cols = Object.keys(seededJobs[0]);
    const ins = sqlite.prepare(
      `INSERT INTO scheduled_jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    for (const row of seededJobs) ins.run(...cols.map((c) => row[c]));
  }
  await srv.close();
});
beforeEach(() => {
  resetDb();
  // resetDb clears job_runs but KEEPS the migration-seeded scheduled_jobs; clear those too
  // so each test controls exactly which jobs exist (restored for downstream files in afterAll).
  sqlite.exec(`DELETE FROM job_runs; DELETE FROM scheduled_jobs;`);
});

describe('W12 — ScheduledJobType queries', () => {
  it('scheduledJobs lists all jobs; scheduledJob(id) fetches one', async () => {
    const a = seedJob('Alpha job', 'freeze_stars', '0 1 * * *', { lastRunAt: '2026-07-01T00:00:00.000Z' });
    seedJob('Beta job', 'snapshot_db');

    const r = await gql('{ scheduledJobs { id name kind cron enabled lastRunAt nextRunAt } }');
    expect(r.body.errors).toBeUndefined();
    const jobs = r.body.data.scheduledJobs;
    expect(jobs.map((j: any) => j.name).sort()).toEqual(['Alpha job', 'Beta job']);
    const alpha = jobs.find((j: any) => j.name === 'Alpha job');
    expect(alpha).toMatchObject({ id: a, kind: 'freeze_stars', cron: '0 1 * * *', enabled: true, lastRunAt: '2026-07-01T00:00:00.000Z', nextRunAt: null });

    const one = await gql(`{ scheduledJob(id: "${a}") { name kind } }`);
    expect(one.body.data.scheduledJob).toEqual({ name: 'Alpha job', kind: 'freeze_stars' });

    const missing = await gql('{ scheduledJob(id: "00000000-0000-7000-8000-000000000000") { name } }');
    expect(missing.body.data.scheduledJob).toBeNull();
  });

  it('lastRun + runs field resolvers surface job_runs (newest first); lastRun null when never run', async () => {
    const jobId = seedJob('Runner', 'tag_tasks');
    // Three runs; ids are UUIDv7 (time-ordered) so seed order = chronological order.
    seedRun(jobId, 'error', { itemsUpdated: 1, log: 'first' });
    seedRun(jobId, 'done', { itemsCreated: 2 });
    const latest = seedRun(jobId, 'done', { itemsCreated: 5, itemsUpdated: 3, log: 'latest' });

    const r = await gql(`{
      scheduledJob(id: "${jobId}") {
        lastRun { id status itemsCreated itemsUpdated log }
        runs(first: 2) { totalCount pageInfo { hasNextPage } edges { node { status } } }
      }
    }`);
    expect(r.body.errors).toBeUndefined();
    const j = r.body.data.scheduledJob;
    expect(j.lastRun).toMatchObject({ id: latest, status: 'done', itemsCreated: 5, itemsUpdated: 3, log: 'latest' });
    expect(j.runs.totalCount).toBe(3);
    expect(j.runs.pageInfo.hasNextPage).toBe(true);
    expect(j.runs.edges.length).toBe(2); // newest first
    expect(j.runs.edges[0].node.status).toBe('done'); // the latest run

    const neverRun = seedJob('Idle', 'prune_sync_events');
    const nr = await gql(`{ scheduledJob(id: "${neverRun}") { lastRun { id } runs { totalCount } } }`);
    expect(nr.body.data.scheduledJob.lastRun).toBeNull();
    expect(nr.body.data.scheduledJob.runs.totalCount).toBe(0);
  });

  it('runs pagination: the after-cursor fetches the next (older) page', async () => {
    const jobId = seedJob('Paged', 'tag_tasks');
    seedRun(jobId, 'done', { log: 'r1' }); // oldest
    seedRun(jobId, 'done', { log: 'r2' });
    seedRun(jobId, 'done', { log: 'r3' }); // newest

    const p1 = await gql(`{ scheduledJob(id: "${jobId}") { runs(first: 2) { pageInfo { hasNextPage endCursor } edges { node { log } } } } }`);
    expect(p1.body.errors).toBeUndefined();
    const page1 = p1.body.data.scheduledJob.runs;
    expect(page1.edges.map((e: any) => e.node.log)).toEqual(['r3', 'r2']); // newest first
    expect(page1.pageInfo.hasNextPage).toBe(true);

    const p2 = await gql(`{ scheduledJob(id: "${jobId}") { runs(first: 2, after: "${page1.pageInfo.endCursor}") { pageInfo { hasNextPage } edges { node { log } } } } }`);
    expect(p2.body.data.scheduledJob.runs.edges.map((e: any) => e.node.log)).toEqual(['r1']);
    expect(p2.body.data.scheduledJob.runs.pageInfo.hasNextPage).toBe(false);
  });

  it('JobRunType.job back-reference resolves to the owning job', async () => {
    const jobId = seedJob('WithBackref', 'review_day');
    seedRun(jobId, 'done');
    const r = await gql(`{ scheduledJob(id: "${jobId}") { runs { edges { node { job { name kind } } } } } }`);
    expect(r.body.errors).toBeUndefined();
    expect(r.body.data.scheduledJob.runs.edges[0].node.job).toEqual({ name: 'WithBackref', kind: 'review_day' });
  });
});

describe('W12 — runScheduledJob mutation', () => {
  it('triggers a job (async fire), reports success + message; unknown id → NOT_FOUND', async () => {
    // An unknown kind: runJob no-ops (no run row) but the trigger + audit + response still fire,
    // so we assert the trigger envelope without depending on a real job's side effects.
    const jobId = seedJob('Manual', 'does_not_exist');
    const m = await gql(`mutation { runScheduledJob(input: { id: "${jobId}" }) { success message job { id name } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.runScheduledJob).toEqual({ success: true, message: 'Job Manual triggered', job: { id: jobId, name: 'Manual' } });

    const missing = await gql('mutation { runScheduledJob(input: { id: "00000000-0000-7000-8000-000000000000" }) { success } }');
    expect(missing.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  });
});

describe('W12 — admin gate (the security test; these tables are system-global)', () => {
  it('a non-admin credential is FORBIDDEN on the GraphQL queries + mutation, allowed by default', async () => {
    const jobId = seedJob('Guarded', 'does_not_exist');

    // Default (admin) path works.
    expect((await gql('{ scheduledJobs { id } }')).body.errors).toBeUndefined();

    // Non-admin (read+write only) → FORBIDDEN on every entry point.
    const q = await gql('{ scheduledJobs { id } }', NON_ADMIN);
    expect(q.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const one = await gql(`{ scheduledJob(id: "${jobId}") { id } }`, NON_ADMIN);
    expect(one.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const mut = await gql(`mutation { runScheduledJob(input: { id: "${jobId}" }) { success } }`, NON_ADMIN);
    expect(mut.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('REST GET /api/jobs is 403 for a non-admin credential, 200 by default', async () => {
    seedJob('RestGuarded', 'does_not_exist');

    const ok = await api(srv.url, '/api/jobs');
    expect(ok.status).toBe(200);
    expect((ok.body as { jobs: unknown[] }).jobs.length).toBe(1);

    const denied = await api(srv.url, '/api/jobs', { headers: NON_ADMIN });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: 'forbidden' });
  });
});
