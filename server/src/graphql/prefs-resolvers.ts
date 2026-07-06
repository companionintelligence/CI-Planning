import { join } from 'node:path';
import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { addDays } from '../lib/dates.js';
import { localDateInTZ, serverTimezone } from '../lib/tz.js';
import { clearPlannerRange } from '../engine/clear-range.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { assignExperimentArmIfNeeded } from '../lib/experiment.js';
import { broadcast } from '../routes/sse.js';
import { getPrefs, updatePrefs, type SchedulingPrefsRow } from '../services/prefs.js';

/**
 * SchedulingPrefsType resolvers (Phase W · W11). Reuses services/prefs.ts
 * (Decision 3) — the SAME validated read/write path routes/prefs.ts calls. The
 * mutation resolver reproduces the REST PATCH's full side-effect envelope
 * (snapshot + clearPlannerRange + broadcast on a horizon shorten; re-read after an
 * experiment-arm assignment) itself, per the brief: the service only validates +
 * writes, so REST and GraphQL each independently own their transport-level effects.
 *
 * Field groups (workday/limits/planning/models/memory) are a GraphQL-only VIEW over
 * the one flat `scheduling_prefs` row — see graphql/prefs.graphql's header comment
 * for the grouping rationale. The `UpdateSchedulingPrefsInput` mirrors those groups;
 * flattening happens in `toPatchBody` below, which maps directly to the same
 * snake_case shape the REST PATCH body uses, so `updatePrefs` needs no GraphQL-aware
 * branching at all.
 */

type Row = SchedulingPrefsRow;

function toNode(row: Row): Row & { id: string } {
  // The Node id is the OWNER id (natural key) — not the row's own surrogate PK.
  return { ...row, id: row.ownerId as string };
}

// ---- output field mapping (camelCase groups <- flat Drizzle row) --------------

const workday = (p: Row) => ({ start: p.workdayStart ?? '09:00', end: p.workdayEnd ?? '18:00' });

const limits = (p: Row) => ({
  maxFocusBlockMinutes: p.maxFocusBlockMinutes ?? 90,
  minBreakMinutes: p.minBreakMinutes ?? 10,
  maxTimeBlockMinutes: p.maxTimeBlockMinutes ?? 240,
  minTimeBlockMinutes: p.minTimeBlockMinutes ?? 15,
  defaultTimeBlockMinutes: p.defaultTimeBlockMinutes ?? 60,
  conceptDefaultMinutes: p.conceptDefaultMinutes ?? 60,
});

const planning = (p: Row) => ({
  horizonDays: p.planningHorizonDays ?? 7,
  recurrenceHorizonDays: p.recurrenceHorizonDays ?? 7,
});

const models = (p: Row) => ({ fast: p.fastModel ?? null, quality: p.qualityModel ?? null, embed: p.embedModel ?? null });

const memory = (p: Row) => ({
  syncEnabled: !!p.memorySyncEnabled,
  syncCompleted: !!p.memorySyncCompleted,
  syncHabits: !!p.memorySyncHabits,
  syncReflections: !!p.memorySyncReflections,
  account: p.memoryAccount ?? null,
  lastSyncedAt: p.memoryLastSyncedAt ?? null,
});

// ---- input mapping (GraphQL grouped input -> flat snake_case PATCH body) ------

type Grouped = Record<string, unknown> & {
  workday?: { start?: string | null; end?: string | null } | null;
  limits?: Record<string, number | null | undefined> | null;
  planning?: { horizonDays?: number | null; recurrenceHorizonDays?: number | null } | null;
  models?: { fast?: string | null; quality?: string | null; embed?: string | null } | null;
  memory?: {
    syncEnabled?: boolean | null; syncCompleted?: boolean | null; syncHabits?: boolean | null;
    syncReflections?: boolean | null; account?: string | null; lastSyncedAt?: string | null;
  } | null;
};

const FLAT_PASSTHROUGH: [gqlKey: string, snakeKey: string][] = [
  ['timezone', 'timezone'],
  ['timeSenseEnabled', 'time_sense_enabled'],
  ['viewPrefs', 'view_prefs'],
  ['planningMode', 'planning_mode'],
  ['trustMode', 'trust_mode'],
  ['fillOrder', 'fill_order'],
  ['enableRituals', 'enable_rituals'],
  ['enableRoutines', 'enable_routines'],
  ['recallKeepsPattern', 'recall_keeps_pattern'],
  ['planAlldayAlways', 'plan_allday_always'],
  ['planDaylongForPromoted', 'plan_daylong_for_promoted'],
  ['planAutofillGaps', 'plan_autofill_gaps'],
  ['autoFillWorkday', 'auto_fill_workday'],
  ['conceptAutosurface', 'concept_autosurface'],
  ['conceptHorizonDays', 'concept_horizon_days'],
  ['focusRitualEnabled', 'focus_ritual_enabled'],
  ['hapticCuesEnabled', 'haptic_cues_enabled'],
  ['ambientColorEnabled', 'ambient_color_enabled'],
  ['calibrationLoopEnabled', 'calibration_loop_enabled'],
  ['deepWorkWindows', 'deep_work_windows'],
  ['dayTheme', 'day_theme'],
  ['conceptTags', 'concept_tags'],
];

/** Flatten `UpdateSchedulingPrefsInput` to the snake_case PATCH body services/prefs.ts
 *  expects. An absent key/group is simply not copied (PATCH-preserve); an explicit
 *  key inside a present group updates just that column — a present group with all-
 *  undefined sub-keys is a no-op (no columns touched), matching "absent = unchanged". */
function toPatchBody(input: Grouped): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [gqlKey, snakeKey] of FLAT_PASSTHROUGH) {
    if (input[gqlKey] !== undefined) body[snakeKey] = input[gqlKey];
  }
  if (input.workday) {
    if (input.workday.start !== undefined) body.workday_start = input.workday.start;
    if (input.workday.end !== undefined) body.workday_end = input.workday.end;
  }
  if (input.limits) {
    const l = input.limits;
    if (l.maxFocusBlockMinutes !== undefined) body.max_focus_block_minutes = l.maxFocusBlockMinutes;
    if (l.minBreakMinutes !== undefined) body.min_break_minutes = l.minBreakMinutes;
    if (l.maxTimeBlockMinutes !== undefined) body.max_time_block_minutes = l.maxTimeBlockMinutes;
    if (l.minTimeBlockMinutes !== undefined) body.min_time_block_minutes = l.minTimeBlockMinutes;
    if (l.defaultTimeBlockMinutes !== undefined) body.default_time_block_minutes = l.defaultTimeBlockMinutes;
    if (l.conceptDefaultMinutes !== undefined) body.concept_default_minutes = l.conceptDefaultMinutes;
  }
  if (input.planning) {
    if (input.planning.horizonDays !== undefined) body.planning_horizon_days = input.planning.horizonDays;
    if (input.planning.recurrenceHorizonDays !== undefined) body.recurrence_horizon_days = input.planning.recurrenceHorizonDays;
  }
  if (input.models) {
    if (input.models.fast !== undefined) body.fast_model = input.models.fast;
    if (input.models.quality !== undefined) body.quality_model = input.models.quality;
    if (input.models.embed !== undefined) body.embed_model = input.models.embed;
  }
  if (input.memory) {
    const m = input.memory;
    if (m.syncEnabled !== undefined) body.memory_sync_enabled = m.syncEnabled;
    if (m.syncCompleted !== undefined) body.memory_sync_completed = m.syncCompleted;
    if (m.syncHabits !== undefined) body.memory_sync_habits = m.syncHabits;
    if (m.syncReflections !== undefined) body.memory_sync_reflections = m.syncReflections;
    if (m.account !== undefined) body.memory_account = m.account;
    if (m.lastSyncedAt !== undefined) body.memory_last_synced_at = m.lastSyncedAt;
  }
  return body;
}

export const prefsResolvers = {
  Query: {
    schedulingPrefs: async () => {
      const owner = currentOwnerId();
      const prefs = await getPrefs(owner);
      if (!prefs) throw new GraphQLError('scheduling prefs not found for owner', { extensions: { code: 'NOT_FOUND' } });
      return toNode(prefs);
    },
  },

  Mutation: {
    updateSchedulingPrefs: async (_p: unknown, args: { input: Grouped }) => {
      const owner = currentOwnerId();
      const body = toPatchBody(args.input ?? {});

      const res = await updatePrefs(owner, body);
      if (!res.ok) {
        if (res.error === 'bad_recurrence_horizon') {
          throw new GraphQLError('planning.recurrenceHorizonDays must be one of 7, 15, 30, 60, 90, 180', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        if (res.error === 'view_prefs_not_serializable') {
          throw new GraphQLError('viewPrefs is not serializable', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        throw new GraphQLError('viewPrefs must be a plain object', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      let prefs = res.prefs;

      // Phase Z · Z5 — mirrors routes/prefs.ts: first time an owner turns Time-Sense
      // on, assign a fixed experiment arm and re-read so the payload reflects the
      // arm-derived channels (the write above didn't touch them).
      if (res.timeSenseNewlyEnabledUnassigned) {
        assignExperimentArmIfNeeded(owner);
        const reread = await getPrefs(owner);
        if (reread) prefs = reread;
      }

      // Auto-prune on shorten (Phase P · P1) — same transport-level side effect as
      // the REST route: snapshot, clear beyond the new horizon, broadcast if pruned.
      let pruned: number | undefined;
      if (res.newHorizon !== null && res.oldHorizon !== null && res.newHorizon < res.oldHorizon) {
        const tz = res.timezone || serverTimezone();
        const today = localDateInTZ(new Date().toISOString(), tz);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await snapshot(join(backupDir, `companion-prehorizon-${ts}.db`));
        const r = clearPlannerRange({
          owner,
          start: addDays(today, res.newHorizon),
          suppress: 'none',
          autoOnly: true,
          clearDailyPlan: false,
          dryRun: false,
        });
        if (r.blocksDeleted) {
          pruned = r.blocksDeleted;
          broadcast(owner, 'block:deleted', { pruned, reason: 'recurrence_horizon' });
        }
      }

      return { prefs: toNode(prefs), success: true, pruned: pruned ?? null };
    },
  },

  SchedulingPrefsType: {
    timezone: (p: Row) => p.timezone ?? null,
    timeSenseEnabled: (p: Row) => !!p.timeSenseEnabled,
    viewPrefs: (p: Row) => {
      if (typeof p.viewPrefs !== 'string') return null;
      try {
        const parsed = JSON.parse(p.viewPrefs);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    workday,
    limits,
    planning,
    models,
    memory,
    planningMode: (p: Row) => p.planningMode ?? 'basic',
    trustMode: (p: Row) => p.trustMode ?? 'balanced',
    fillOrder: (p: Row) => p.fillOrder ?? 'priority',
    enableRituals: (p: Row) => !!p.enableRituals,
    enableRoutines: (p: Row) => !!p.enableRoutines,
    recallKeepsPattern: (p: Row) => !!p.recallKeepsPattern,
    planAlldayAlways: (p: Row) => !!p.planAlldayAlways,
    planDaylongForPromoted: (p: Row) => !!p.planDaylongForPromoted,
    planAutofillGaps: (p: Row) => !!p.planAutofillGaps,
    autoFillWorkday: (p: Row) => !!p.autoFillWorkday,
    conceptAutosurface: (p: Row) => !!p.conceptAutosurface,
    conceptHorizonDays: (p: Row) => p.conceptHorizonDays ?? 30,
    focusRitualEnabled: (p: Row) => !!p.focusRitualEnabled,
    hapticCuesEnabled: (p: Row) => !!p.hapticCuesEnabled,
    ambientColorEnabled: (p: Row) => !!p.ambientColorEnabled,
    calibrationLoopEnabled: (p: Row) => !!p.calibrationLoopEnabled,
    deepWorkWindows: (p: Row) => p.deepWorkWindows ?? null,
    dayTheme: (p: Row) => p.dayTheme ?? null,
    conceptTags: (p: Row) => p.conceptTags ?? null,
  },
};
