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
import { assignExperimentArmIfNeeded } from '../lib/experiment.js';
import { broadcast } from './sse.js';

// The Settings "Recurrence duration" select offers exactly these; reject anything
// else rather than silently storing an out-of-range value the UI can't represent.
const ALLOWED_RECURRENCE_HORIZON = new Set([7, 15, 30, 60, 90, 180]);

/** A plain (non-null, non-array) object — what `view_prefs` must be. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `view_prefs` is stored as a raw JSON string in a TEXT column, but the API
 * contract exposes it as a nested object. Parse the stored string on the way out;
 * a NULL/malformed blob degrades to null so a bad row never breaks the response
 * (the client then falls back to its built-in defaults).
 */
function serializePrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  const api = toApi(prefs);
  const raw = api.view_prefs;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      api.view_prefs = isPlainObject(parsed) ? parsed : null;
    } catch {
      api.view_prefs = null;
    }
  } else {
    api.view_prefs = raw ?? null; // NULL column → null
  }
  return api;
}

export function prefsRouter() {
  const router = new Router();

  // GET /api/prefs
  router.get('/api/prefs', async (ctx) => {
    const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, currentOwnerId()));
    ctx.body = { prefs: prefs ? serializePrefs(prefs) : null };
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

    // The experiment arm (Z5, §5.2) is server-assigned only — never let a client
    // self-select its A/B condition, even by accident. Strip it before serializing.
    delete body.z_experiment_arm;

    // view_prefs (0111) is a JSON blob stored as TEXT. Accept a plain object (reject
    // arrays/scalars — a non-object would corrupt the stored view state) and JSON-
    // stringify it so Drizzle writes a string into the TEXT column. null clears it.
    if (body.view_prefs !== undefined) {
      if (body.view_prefs === null) {
        body.view_prefs = null;
      } else if (isPlainObject(body.view_prefs)) {
        // JSON.stringify can throw on non-serializable input (circular refs, BigInt);
        // treat that as a 422 rather than letting it 500 the handler.
        try {
          body.view_prefs = JSON.stringify(body.view_prefs);
        } catch {
          ctx.status = 422;
          ctx.body = { error: 'view_prefs is not serializable' };
          return;
        }
      } else {
        ctx.status = 422;
        ctx.body = { error: 'view_prefs must be a plain object' };
        return;
      }
    }

    // Convert incoming snake_case keys to camelCase for Drizzle
    const update = fromApi<Partial<typeof schedulingPrefs.$inferInsert>>(body);
    let [prefs] = await db
      .update(schedulingPrefs)
      .set(update)
      .where(eq(schedulingPrefs.ownerId, owner))
      .returning();
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: 'prefs:owner' });

    // Phase Z · Z5 — first time an owner turns Time-Sense on, assign a fixed
    // experiment arm and seed the haptic/color channels to match it. Re-read so the
    // response reflects the arm-derived channels (the update above didn't touch them).
    if (prefs?.timeSenseEnabled && !prefs.zExperimentArm) {
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

    ctx.body = { prefs: prefs ? serializePrefs(prefs) : null, ...(pruned ? { pruned } : {}) };
  });

  return router;
}
