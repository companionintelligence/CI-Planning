import { join } from 'node:path';
import Router from '@koa/router';
import { db } from '../db/index.js';
import { schedulingPrefs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { currentOwnerId } from '../lib/context.js';
import { addDays } from '../lib/dates.js';
import { localDateInTZ, serverTimezone } from '../lib/tz.js';
import { clearPlannerRange } from '../engine/clear-range.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { assignExperimentArmIfNeeded } from '../lib/experiment.js';
import { broadcast } from './sse.js';
import { getPrefs, updatePrefs, serializePrefs } from '../services/prefs.js';

export function prefsRouter() {
  const router = new Router();

  // GET /api/prefs
  router.get('/api/prefs', async (ctx) => {
    const prefs = await getPrefs(currentOwnerId());
    ctx.body = { prefs: prefs ? serializePrefs(prefs) : null };
  });

  // PATCH /api/prefs  — accepts snake_case body, returns snake_case
  router.patch('/api/prefs', async (ctx) => {
    const body = ctx.request.body as Record<string, unknown>;
    const owner = currentOwnerId();

    const res = await updatePrefs(owner, body);
    if (!res.ok) {
      // Zero rows affected (no seeded scheduling_prefs row for this owner) isn't a
      // client input error — mirrors the pre-extraction route's `prefs ? ... : null`
      // guard, which tolerated this same case gracefully rather than 422ing it.
      if (res.error === 'not_found') { ctx.body = { prefs: null }; return; }
      ctx.status = 422;
      ctx.body = {
        error:
          res.error === 'bad_recurrence_horizon'
            ? 'recurrence_horizon_days must be one of 7, 15, 30, 60, 90, 180'
            : res.error === 'view_prefs_not_serializable'
              ? 'view_prefs is not serializable'
              : 'view_prefs must be a plain object',
      };
      return;
    }

    let prefs = res.prefs;

    // Phase Z · Z5 — first time an owner turns Time-Sense on, assign a fixed
    // experiment arm and seed the haptic/color channels to match it. Re-read so the
    // response reflects the arm-derived channels (the update above didn't touch them).
    if (res.timeSenseNewlyEnabledUnassigned) {
      assignExperimentArmIfNeeded(owner);
      [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, owner));
    }

    // Auto-prune on shorten (Phase P · P1). Lowering the recurrence horizon deletes
    // engine-generated instances beyond the new window — but NOT locked/manual blocks,
    // and it does NOT cap any rule (suppress:'none'), so raising the horizon later
    // re-materializes them. Snapshot first (a settings change becoming destructive
    // must be recoverable). Days [today, today+newHorizon-1] are kept; prune from
    // today+newHorizon onward (matches the engines' `d <= today+horizon-1` clamp).
    let pruned = 0;
    if (res.newHorizon !== null && res.oldHorizon !== null && res.newHorizon < res.oldHorizon) {
      const tz = res.timezone || serverTimezone();
      const today = localDateInTZ(new Date().toISOString(), tz);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await snapshot(join(backupDir, `companion-prehorizon-${ts}.db`));
      // Prune only engine-generated instances beyond the new window. clearDailyPlan:false
      // — the recurrence ceiling must NOT discard authored Phase-M day plans (rationales/
      // outcomes), which raising the horizon could not restore.
      const r = clearPlannerRange({
        owner,
        start: addDays(today, res.newHorizon),
        suppress: 'none',
        autoOnly: true,
        clearDailyPlan: false,
        dryRun: false,
      });
      pruned = r.blocksDeleted;
      if (pruned) broadcast(owner, 'block:deleted', { pruned, reason: 'recurrence_horizon' });
    }

    ctx.body = { prefs: prefs ? serializePrefs(prefs) : null, ...(pruned ? { pruned } : {}) };
  });

  return router;
}
