import Router from '@koa/router';
import type Koa from 'koa';
import { runJob, runIngestNow } from '../jobs/index.js';
import { currentScopes } from '../lib/context.js';
import { hasAdminScope } from '../lib/auth/scopes.js';
import { listJobs, triggerJob } from '../services/jobs.js';

/**
 * System-job admin surface (Phase W · W12). `scheduled_jobs`/`job_runs` are system-global,
 * owner-less tables, so — unlike every other route — this is NOT owner-scoped. Instead it
 * is gated on the admin scope (`planning:admin`): a full-owner session carries admin, so a
 * logged-in operator is unaffected, but a narrower credential (e.g. a read/write-only API
 * key) now gets 403. This is the ONE deliberate, owner-approved behavior change to a REST
 * route in the phase (byte-equivalence exception, W12).
 */

/** 403 unless the current credential carries admin. Returns true when the request may
 *  proceed; on denial it sets the response (matching requireAuth's 403 body) and returns false. */
function requireAdmin(ctx: Koa.Context): boolean {
  if (hasAdminScope(currentScopes())) return true;
  ctx.status = 403;
  ctx.body = { error: 'forbidden' };
  return false;
}

export function jobsRouter() {
  const router = new Router();

  // GET /api/jobs — admin-only.
  router.get('/api/jobs', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    ctx.body = { jobs: listJobs() };
  });

  /**
   * POST /api/jobs/run-now — FTUE · T12 (#348). Registered BEFORE /:id/run so the
   * literal path is never shadowed. Deliberately NOT admin-gated: this runs the
   * CALLING owner's own ingest (ordinary `requireAuth` write scope, same as every
   * other mutation), unlike the admin-only single-job trigger below. Awaits the run
   * (unlike /:id/run's fire-and-forget) so the wizard can show a real result.
   */
  router.post('/api/jobs/run-now', async (ctx) => {
    const ran = await runIngestNow();
    ctx.body = { ok: true, ran };
  });

  // POST /api/jobs/:id/run — admin-only. Fires async; client listens on SSE for completion.
  router.post('/api/jobs/:id/run', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const res = await triggerJob(ctx.params.id);
    if (!res.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    runJob(res.job.kind).catch(console.error);
    ctx.body = { ok: true, message: `Job ${res.job.name} triggered` };
  });

  return router;
}
