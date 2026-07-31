import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { schedulingPrefs } from '../db/schema.js';
import { toApi, fromApi } from '../lib/serialize.js';
import { writeAudit } from '../lib/audit.js';

/**
 * scheduling_prefs service (Phase W · W11). Extracted from routes/prefs.ts
 * (behavior-preserving) so REST and GraphQL share ONE validated read/write path.
 *
 * Design split (per the W11 brief): this module owns validation + the Drizzle
 * write and returns enough context (`oldHorizon`/`newHorizon`/`timezone`) for a
 * CALLER to decide whether to snapshot + prune + broadcast. The snapshot/
 * clearPlannerRange/broadcast side effects stay in the transport layer (routes/
 * prefs.ts AND graphql/prefs-resolvers.ts each fire them independently) — this
 * service never touches the filesystem, the SSE bus, or the recurrence engine.
 */

// The Settings "Recurrence duration" select offers exactly these; reject anything
// else rather than silently storing an out-of-range value the UI can't represent.
export const ALLOWED_RECURRENCE_HORIZON = new Set([7, 15, 30, 60, 90, 180]);

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
export function serializePrefs(prefs: Record<string, unknown>): Record<string, unknown> {
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

export type SchedulingPrefsRow = typeof schedulingPrefs.$inferSelect;

/** Owner-scoped read of the raw Drizzle row (camelCase), or undefined if unseeded. */
export async function getPrefs(ownerId: string): Promise<SchedulingPrefsRow | undefined> {
  const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, ownerId));
  return prefs;
}

export type UpdatePrefsResult =
  | {
      ok: true;
      prefs: SchedulingPrefsRow;
      /** Set only when `recurrence_horizon_days` (snake_case key) was present in the patch. */
      oldHorizon: number | null;
      newHorizon: number | null;
      /** Owner's timezone AS OF BEFORE the update (used to compute "today" for a prune). */
      timezone: string;
      /** True once time-sense flipped on in this call and the arm was assigned — caller
       *  need not re-derive this, but re-reading the row is still the caller's job if it
       *  wants the arm-derived channels (kept out of this service to avoid a second read
       *  inside the same call; see `assignExperimentArmIfNeeded` note below). */
      timeSenseNewlyEnabledUnassigned: boolean;
    }
  | { ok: false; error: 'bad_recurrence_horizon' | 'view_prefs_not_object' | 'view_prefs_not_serializable' | 'not_found' };

/**
 * Validate + write a PATCH body (snake_case in, matching the REST wire format) to
 * `scheduling_prefs`. Mirrors routes/prefs.ts's PATCH handler exactly, minus the
 * snapshot/prune/broadcast side effects (left to the caller — see module doc).
 *
 * `z_experiment_arm` is unconditionally stripped from the incoming body: it is
 * server-assigned only (lib/experiment.ts), never client-writable.
 */
export async function updatePrefs(ownerId: string, rawBody: Record<string, unknown>): Promise<UpdatePrefsResult> {
  const body = { ...rawBody };

  // Validate the recurrence horizon against the allowed set before touching the DB.
  const horizonPatched = body.recurrence_horizon_days !== undefined;
  const newHorizon = horizonPatched ? Number(body.recurrence_horizon_days) : null;
  if (horizonPatched && (newHorizon === null || !ALLOWED_RECURRENCE_HORIZON.has(newHorizon))) {
    return { ok: false, error: 'bad_recurrence_horizon' };
  }

  // Snapshot the old horizon + tz BEFORE the update so the caller can detect a
  // shorten and compute "today" in the owner's timezone (matching the engines' clamp).
  // Only queried when the horizon is actually being patched — `timezone`/`oldHorizon`
  // are only ever consumed inside the shorten branch, which is unreachable otherwise
  // (mirrors the pre-extraction route, which made this same read conditional).
  const beforeRow = horizonPatched
    ? (sqlite
        .prepare(`SELECT recurrence_horizon_days, timezone FROM scheduling_prefs WHERE owner_id = ?`)
        .get(ownerId) as { recurrence_horizon_days: number | null; timezone: string | null } | undefined)
    : undefined;
  const oldHorizon = horizonPatched ? beforeRow?.recurrence_horizon_days ?? 7 : null;
  const timezone = beforeRow?.timezone || '';

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
      // treat that as a validation failure rather than letting it throw uncaught.
      try {
        body.view_prefs = JSON.stringify(body.view_prefs);
      } catch {
        return { ok: false, error: 'view_prefs_not_serializable' };
      }
    } else {
      return { ok: false, error: 'view_prefs_not_object' };
    }
  }

  // Convert incoming snake_case keys to camelCase for Drizzle.
  //
  // `fromApi` is a blind key rename with no allowlist, and Drizzle emits a SET clause for
  // every real column present — so before this strip, the request body could write ANY
  // scheduling_prefs column, including the two that are not preferences at all:
  //
  //   owner_id — a tenant-isolation hole. The column has no UNIQUE constraint, so
  //              reassigning it silently succeeds and leaves the victim with TWO prefs
  //              rows; the many `… WHERE owner_id = ?` single-row `.get()` reads (owner
  //              timezone, block services, autoplan) then return whichever SQLite yields
  //              first, applying attacker-chosen scheduling config to another owner. The
  //              sentinel id is a hardcoded public constant AND the row provisionOwner()
  //              clones for every new owner, so it is a standing target.
  //   id       — re-points the row itself.
  //
  // Deny-listing the two rather than allow-listing the rest is deliberate: a new
  // preference column then stays writable by default (which is what every caller expects),
  // while the two columns that must never be client-set are named explicitly.
  const { id: _ignoredId, owner_id: _ignoredOwnerId, ownerId: _ignoredOwnerIdCamel, ...writable } = body;
  const update = fromApi<Partial<typeof schedulingPrefs.$inferInsert>>(writable);
  const [prefs] = await db
    .update(schedulingPrefs)
    .set(update)
    .where(eq(schedulingPrefs.ownerId, ownerId))
    .returning();
  // The UPDATE affects zero rows when the owner has no seeded scheduling_prefs row
  // (shouldn't happen in practice — every owner gets one at creation — but a real
  // discriminated `not_found` beats returning `ok:true` with an undefined `prefs`,
  // which would otherwise crash a GraphQL resolver's `toNode(prefs)` on the happy path).
  if (!prefs) return { ok: false, error: 'not_found' };
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: 'prefs:owner' });

  const timeSenseNewlyEnabledUnassigned = !!(prefs.timeSenseEnabled && !prefs.zExperimentArm);

  return {
    ok: true,
    prefs,
    oldHorizon,
    newHorizon,
    timezone,
    timeSenseNewlyEnabledUnassigned,
  };
}
