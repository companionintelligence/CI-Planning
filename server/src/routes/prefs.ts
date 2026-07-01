import { join } from 'node:path';
import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { schedulingPrefs } from '../db/schema.js';
import { toApi, fromApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { addDays } from '../lib/dates.js';
import { localDateInTZ, serverTimezone } from '../lib/tz.js';
import { clearPlannerRange } from '../engine/clear-range.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { broadcast } from './sse.js';

// The Settings "Recurrence duration" select offers exactly these; reject anything
// else rather than silently storing an out-of-range value the UI can't represent.
const ALLOWED_RECURRENCE_HORIZON = new Set([7, 15, 30, 60, 90, 180]);

export function prefsRouter() {
  const router = new Router();

  // GET /api/prefs
  router.get('/api/prefs', async (ctx) => {
    const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, currentOwnerId()));
    ctx.body = { prefs: prefs ? toApi(prefs) : null };
  });

  // PATCH /api/prefs  — accepts snake_case body, returns snake_case
  router.patch('/api/prefs', async (ctx) => {
    const body = ctx.request.body as Record<string, unknown>;
    const owner = currentOwnerId();

    // Validate the recurrence horizon against the allowed set before touching the DB.
    const horizonPatched = body.recurrence_horizon_days !== undefined;
    const newHorizon = horizonPatched ? Number(body.recurrence_horizon_days) : null;
    if (horizonPatched && (newHorizon === null || !ALLOWED_RECURRENCE_HORIZON.has(newHorizon))) {
      ctx.status = 422;
      ctx.body = { error: 'recurrence_horizon_days must be one of 7, 15, 30, 60, 90, 180' };
      return;
    }

    // Snapshot the old horizon + tz BEFORE the update so we can detect a shorten
    // and compute "today" in the owner's timezone (matching the engines' clamp).
    const beforeRow = horizonPatched
      ? (sqlite.prepare(`SELECT recurrence_horizon_days, timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as
          | { recurrence_horizon_days: number | null; timezone: string | null }
          | undefined)
      : undefined;
    const oldHorizon = horizonPatched ? beforeRow?.recurrence_horizon_days ?? 7 : null;

    // Convert incoming snake_case keys to camelCase for Drizzle
    const update = fromApi<Partial<typeof schedulingPrefs.$inferInsert>>(body);
    const [prefs] = await db
      .update(schedulingPrefs)
      .set(update)
      .where(eq(schedulingPrefs.ownerId, owner))
      .returning();
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: 'prefs:owner' });

    // Auto-prune on shorten (Phase P · P1). Lowering the recurrence horizon deletes
    // engine-generated instances beyond the new window — but NOT locked/manual blocks,
    // and it does NOT cap any rule (suppress:'none'), so raising the horizon later
    // re-materializes them. Snapshot first (a settings change becoming destructive
    // must be recoverable). Days [today, today+newHorizon-1] are kept; prune from
    // today+newHorizon onward (matches the engines' `d <= today+horizon-1` clamp).
    let pruned = 0;
    if (horizonPatched && newHorizon! < oldHorizon!) {
      const tz = beforeRow?.timezone || serverTimezone();
      const today = localDateInTZ(new Date().toISOString(), tz);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await snapshot(join(backupDir, `companion-prehorizon-${ts}.db`));
      // Prune only engine-generated instances beyond the new window. clearDailyPlan:false
      // — the recurrence ceiling must NOT discard authored Phase-M day plans (rationales/
      // outcomes), which raising the horizon could not restore.
      const res = clearPlannerRange({
        owner,
        start: addDays(today, newHorizon!),
        suppress: 'none',
        autoOnly: true,
        clearDailyPlan: false,
        dryRun: false,
      });
      pruned = res.blocksDeleted;
      if (pruned) broadcast(owner, 'block:deleted', { pruned, reason: 'recurrence_horizon' });
    }

    ctx.body = { prefs: prefs ? toApi(prefs) : null, ...(pruned ? { pruned } : {}) };
  });

  return router;
}
