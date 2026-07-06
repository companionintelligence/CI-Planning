import { join } from 'node:path';
import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { writeAudit } from '../lib/audit.js';
import { localISODate } from '../lib/dates.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { InstructError, authorPlanOrder, type PlanPin, type PlanHint } from '../agents/plan.js';
import { reflow, outstandingSuggestion, clearSuggestion } from '../engine/auto-defense.js';
import { fillFlightPlanCandidates, fillByPriority, undoLastAuto } from '../engine/autoplan.js';
import { clearPlannerRange } from '../engine/clear-range.js';
import { listFlightPlan } from '../services/flight-plan.js';
import { instructPlan, autoRun, validateClearRange } from '../services/engine-ops.js';

/**
 * Phase W · W13 — mutation-only engine ops. Thin resolvers over the SAME engine functions
 * the REST routes drive (Decision 3): the scheduling engines (reflow/placeFlightPlan/…) are
 * the shared core; the three pieces of non-trivial INLINE handler logic (instruct apply,
 * autoRun horizon loop, clear-range validation) live in services/engine-ops.ts. No new
 * CRUD/Node type — these are operations. The one returned flight-plan list reuses W5's
 * FlightPlanEntryType via listFlightPlan.
 *
 * Owner comes from currentOwnerId() (requireAuth), never the client. Each resolver
 * reproduces the REST route's side-effect envelope EXACTLY: the same SSE broadcast events
 * with the same payloads, and (for the ops whose audit was NOT moved into a service) the
 * same writeAudit rows. instructPlan/autoRun already writeAudit INSIDE the service (so REST
 * + GraphQL emit identical rows); the schedule/reauthor/dismiss/fill/priority/undo/clear
 * audits stay transport-side and are reproduced here to match their routes.
 */

/** Map the PlanPin[] the service returns to the camelCase GraphQL PlanPin shape. */
function toPlanPins(pins: PlanPin[]) {
  return pins.map((p) => ({ title: p.title, startAt: p.start_at, endAt: p.end_at }));
}
/** PlanHint maps by name (kind/tag/time) via the default resolver — passed through as-is. */
function toPlanHints(hints: PlanHint[]) {
  return hints;
}

export const engineOpsResolvers = {
  Query: {
    // GET /api/plan/suggestion — nullable outstanding nudge.
    planSuggestion: () => outstandingSuggestion(currentOwnerId()) ?? null,
  },

  Mutation: {
    // POST /api/schedule/run — deterministic reflow; no SSE in the route; audit stays here.
    runSchedule: (_p: unknown, args: { date?: string | null }) => {
      const owner = currentOwnerId();
      const date = args.date ?? localISODate();
      const diff = reflow(owner, date, 'manual');
      writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: `schedule:${date}` });
      return { diff, success: true };
    },

    // POST /api/plan/instruct — parse + apply (service; audit inside). Empty text →
    // BAD_USER_INPUT; InstructError → BAD_USER_INPUT (invalid) / SERVICE_UNAVAILABLE (AI down).
    // The `block:created` broadcast stays transport-side (fires iff a pin was written).
    instructPlan: async (_p: unknown, args: { input: { text: string; date?: string | null } }) => {
      const owner = currentOwnerId();
      const text = (args.input.text ?? '').trim();
      if (!text) throw new GraphQLError('text is required', { extensions: { code: 'BAD_USER_INPUT' } });
      const date = args.input.date ?? localISODate();
      let outcome;
      try {
        outcome = await instructPlan(owner, date, text);
      } catch (err) {
        if (err instanceof InstructError) {
          throw new GraphQLError(err.message, {
            extensions: { code: err.code === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'BAD_USER_INPUT' },
          });
        }
        throw err;
      }
      if (outcome.created > 0) broadcast(owner, 'block:created', { added: outcome.created });
      return {
        ok: true,
        date,
        pins: toPlanPins(outcome.pins),
        hints: toPlanHints(outcome.hints),
        created: outcome.created,
      };
    },

    // POST /api/plan/reauthor — force AI re-author, clear the nudge, then reflow +
    // broadcast schedule:done{reason:'reauthor', ...diff}. audit stays here.
    reauthorPlan: async (_p: unknown, args: { date?: string | null }) => {
      const owner = currentOwnerId();
      const date = args.date ?? localISODate();
      await authorPlanOrder(owner, date, { force: true });
      clearSuggestion(owner);
      const diff = reflow(owner, date, 'reauthor');
      broadcast(owner, 'schedule:done', { reason: 'reauthor', ...diff });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'reauthor', entity: `plan:${date}` });
      return { diff, success: true };
    },

    // POST /api/plan/reauthor/dismiss — drop the outstanding suggestion.
    dismissReauthor: () => {
      const owner = currentOwnerId();
      clearSuggestion(owner);
      broadcast(owner, 'replan:dismissed', {});
      writeAudit({ ownerId: owner, actor: 'owner', action: 'dismiss', entity: 'plan:reauthor' });
      return { success: true };
    },

    // POST /api/auto/fill — propose candidates into staging. Never places.
    autoFill: () => {
      const owner = currentOwnerId();
      const added = fillFlightPlanCandidates(owner);
      broadcast(owner, 'flight_plan:filled', { added });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'fill', entity: 'flight-plan:fill' });
      return { result: { step: 'fill', candidatesAdded: added }, flightPlan: listFlightPlan(owner), success: true };
    },

    // POST /api/auto/run — horizon resolution + placement (service; audit inside). A
    // multi-day run (result.days > 1) fires one aggregated auto:placed; single-day fires none.
    autoRun: async (_p: unknown, args: { input?: { date?: string | null; blockId?: string | null; horizonDays?: number | null } | null }) => {
      const owner = currentOwnerId();
      const input = args.input ?? {};
      const date = input.date ?? localISODate();
      const result = await autoRun(owner, {
        date,
        blockId: input.blockId ?? undefined,
        horizonDays: input.horizonDays ?? undefined,
      });
      if (result.days != null && result.days > 1) {
        broadcast(owner, 'auto:placed', { blocksCreated: result.blocksCreated, placed: result.placed, unplaced: result.unplaced, days: result.days });
        broadcast(owner, 'flight_plan:updated', { removed: result.placed });
      }
      return { result, flightPlan: listFlightPlan(owner), success: true };
    },

    // POST /api/auto/priority — explicit priority top-up. No SSE in the route.
    autoPriority: (_p: unknown, args: { date?: string | null }) => {
      const owner = currentOwnerId();
      const result = fillByPriority(owner, { date: args.date ?? undefined });
      writeAudit({ ownerId: owner, actor: 'owner', action: 'run', entity: 'flight-plan:priority' });
      return { result, flightPlan: listFlightPlan(owner), success: true };
    },

    // POST /api/auto/undo — undo the last placement run. undoLastAuto broadcasts auto:undone
    // internally, so (like the route) NO extra broadcast here.
    autoUndo: () => {
      const owner = currentOwnerId();
      const result = undoLastAuto(owner);
      writeAudit({ ownerId: owner, actor: 'owner', action: 'undo', entity: 'flight-plan:undo' });
      return { result, flightPlan: listFlightPlan(owner), success: true };
    },

    // POST /api/planner/clear — validate (service) then snapshot (apply only) + clear +
    // audit + broadcast (all transport-side, mirroring the route + the W11 prefs prune split).
    clearPlanner: async (_p: unknown, args: { input: { start: string; end?: string | null; dryRun?: boolean | null } }) => {
      const owner = currentOwnerId();
      const v = validateClearRange({ start: args.input.start, end: args.input.end, dryRun: args.input.dryRun ?? undefined });
      if (!v.ok) throw new GraphQLError(v.error, { extensions: { code: 'BAD_USER_INPUT' } });
      const { start, end, dryRun } = v;

      // Snapshot BEFORE a real apply (bulk destructive). Return only the FILENAME (not the
      // absolute host path, which would leak the server's directory layout).
      let backup: string | undefined;
      if (!dryRun) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `companion-preclear-${ts}.db`;
        await snapshot(join(backupDir, filename));
        backup = filename;
      }

      const result = clearPlannerRange({ owner, start, end, suppress: 'auto', autoOnly: false, dryRun });

      if (!dryRun) {
        writeAudit({ ownerId: owner, actor: 'owner', action: 'clear-range', entity: `planner:${start}..${end ?? ''}` });
        broadcast(owner, 'block:deleted', { cleared: result.blocksDeleted, start, end });
      }

      return { ...result, backup: backup ?? null, success: true };
    },
  },
};
