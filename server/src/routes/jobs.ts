import Router from '@koa/router';
import { eq, desc } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { scheduledJobs, jobRuns } from '../db/schema.js';
import { runJob } from '../jobs/index.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';

export function jobsRouter() {
  const router = new Router();

  // GET /api/jobs
  router.get('/api/jobs', async (ctx) => {
    const jobs = sqlite
      .prepare(
        `SELECT j.*, r.started_at as last_started, r.status as last_status, r.items_created, r.items_updated
         FROM scheduled_jobs j
         LEFT JOIN job_runs r ON r.id = (
           SELECT id FROM job_runs WHERE job_id = j.id ORDER BY started_at DESC LIMIT 1
         )
         ORDER BY j.name`
      )
      .all();
    ctx.body = { jobs };
  });

  // POST /api/jobs/:id/run
  router.post('/api/jobs/:id/run', async (ctx) => {
    const id = ctx.params.id;
    const [job] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
    if (!job) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // Fire async; client listens on SSE for completion
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'run', entity: `job:${job.kind}` });
    runJob(job.kind).catch(console.error);
    ctx.body = { ok: true, message: `Job ${job.name} triggered` };
  });

  return router;
}
