import { sqliteTable, text, integer, real, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { newId } from '../lib/ids.js';

// CON-1: entity ids are TEXT UUIDv7 (see lib/ids.ts). Drizzle inserts mint via
// $defaultFn(newId); raw-SQL inserts use the uuid7() function (db/index.ts).

export const owners = sqliteTable('owners', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  email: text('email'),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey().$defaultFn(newId),
  title: text('title').notNull(),
  description: text('description'),        // short summary / legacy
  notes: text('notes'),                    // rich freeform notes
  dueAt: text('due_at'),                   // ISO datetime — hard deadline
  scheduledFor: text('scheduled_for'),     // local YYYY-MM-DD — intent to work it, not a deadline
  deferUntil: text('defer_until'),         // UTC ISO — hidden from the today-set until then
  taskTime: text('task_time'),             // HH:MM time-of-day if the task has a fixed start time
  estimatedMinutes: integer('estimated_minutes'),
  actualMinutes: integer('actual_minutes').notNull().default(0), // aggregate of finished time_entries
  priority: integer('priority').default(3), // 1 highest, 5 lowest
  status: text('status').default('open'),   // open | scheduled | in_progress | done | cancelled | deferred | recurring | skipped | missed
  parentId: text('parent_id'),             // null = top-level task; set = subtask
  // --- Recurrence (Phase E). Template: recurrenceRule set, recurrenceParentId null.
  //     Instance: recurrenceParentId -> template, occurrenceDate set. ---
  recurrenceRule: text('recurrence_rule'),                 // RFC-5545 RRULE string; null = one-off
  recurrenceParentId: text('recurrence_parent_id'),        // -> tasks.id of the template (instances only)
  recurrenceDtstart: text('recurrence_dtstart'),           // UTC ISO anchor of the series
  recurrenceExdates: text('recurrence_exdates', { mode: 'json' }).$type<string[]>(), // skipped local YYYY-MM-DD
  occurrenceDate: text('occurrence_date'),                 // local YYYY-MM-DD of this instance
  isHabit: integer('is_habit', { mode: 'boolean' }).default(false),
  isFastTask: integer('is_fast_task', { mode: 'boolean' }).default(false), // ritual-local, hidden from the task list (0020)
  subtype: text('subtype').default('standard'), // CON-2c canonical Task subtype: standard | habit | quick (is_habit/is_fast_task kept as in-sync runtime aliases)
  deferCount: integer('defer_count').notNull().default(0), // times rescheduled by the nightly review (0029)
  ownerId: text('owner_id').references(() => owners.id),
  sourceKind: text('source_kind').default('manual'), // manual | agent | gmail | gcal
  sourceRef: text('source_ref'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  completedAt: text('completed_at'),
});

// Dependency edges: task_id is blocked until depends_on_id is done.
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    dependsOnId: text('depends_on_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.taskId, t.dependsOnId] }) })
);

export const possibleTasks = sqliteTable('possible_tasks', {
  id: text('id').primaryKey().$defaultFn(newId),
  rawTitle: text('raw_title').notNull(),
  rawSummary: text('raw_summary'),
  proposedDueAt: text('proposed_due_at'),
  proposedPriority: integer('proposed_priority'),
  proposedOwnerId: text('proposed_owner_id').references(() => owners.id),
  sourceKind: text('source_kind'),
  sourceRef: text('source_ref'),
  sourcePayload: text('source_payload', { mode: 'json' }),
  confidence: real('confidence'),
  status: text('status').default('pending'),         // pending | promoted | dismissed | duplicate
  promotedTaskId: text('promoted_task_id').references(() => tasks.id),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const timeBlocks = sqliteTable('time_blocks', {
  id: text('id').primaryKey().$defaultFn(newId),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  blockKind: text('block_kind').default('task'),     // task | meeting | habit | focus | break | buffer | timeblock (container)
  tag: text('tag'),                                  // grouping tag for 'timeblock' containers (Phase G)
  blockType: text('block_type'),                     // Time-Block state: 'scheduled' | 'someday' (0019; renamed CON-2/0031)
  goalStartDate: text('goal_start_date'),            // YYYY-MM-DD goal day for concepts (nullable = someday)
  durationMinutes: integer('duration_minutes'),      // concept duration (no start/end semantics)
  note: text('note'),                                // optional saved note on a Plan/Concept container (0021)
  startAt: text('start_at').notNull(),
  endAt: text('end_at').notNull(),
  isLocked: integer('is_locked', { mode: 'boolean' }).default(false),
  isAuto: integer('is_auto', { mode: 'boolean' }).default(true),
  allDay: integer('all_day', { mode: 'boolean' }).default(false), // all-day events: header lane, off the minute axis (0010)
  sourceKind: text('source_kind').default('manual'),
  sourceRef: text('source_ref'),
  status: text('status').default('planned'),         // planned | completed | skipped | overrun
  // Plan-as-container (PR-C / 0023): a task block's containing Plan. Self-ref FK,
  // ON DELETE SET NULL — deleting a Plan detaches members (they stay as loose blocks).
  parentBlockId: text('parent_block_id').references((): AnySQLiteColumn => timeBlocks.id, { onDelete: 'set null' }),
  // CON-4 recurrence (0034): bare recurring Time Blocks via the SHARED rrule.js
  // engine (recurrence.ts), mirroring tasks. A *template* has recurrenceRule set +
  // recurrenceParentId null (never rendered directly); GET materializes one
  // *instance* per occurrence (recurrenceParentId = template, occurrenceDate set),
  // idempotent via ux_block_occurrence. patterns.recurrence_rule (0025) is kept.
  recurrenceRule: text('recurrence_rule'),           // RRULE string; null = one-off
  recurrenceDtstart: text('recurrence_dtstart'),     // UTC ISO anchor of the series
  recurrenceParentId: text('recurrence_parent_id'),  // template id on an instance (no FK: cleared by hand)
  occurrenceDate: text('occurrence_date'),           // YYYY-MM-DD local day of an instance
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// Reusable Time-Block templates (Phase G): a saved named/tagged container with a
// default duration, re-instantiated onto a day as a 'timeblock' time_blocks row.
export const blockTemplates = sqliteTable('block_templates', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id),
  name: text('name').notNull(),
  tag: text('tag'),
  defaultMinutes: integer('default_minutes').default(60),
  // Tasks saved with the Plan (PR-B): recreated at start + offset on instantiate.
  tasks: text('tasks', { mode: 'json' }).$type<{ title: string; tag: string | null; estimated_minutes: number | null; offset_minutes: number }[]>(),
});

// Persisted real work per task. The single ended_at IS NULL row per owner is
// the running-timer state (guarded by a partial unique index). UTC ISO text.
export const timeEntries = sqliteTable('time_entries', {
  id: text('id').primaryKey().$defaultFn(newId),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  blockId: text('block_id').references(() => timeBlocks.id, { onDelete: 'set null' }), // if started from a block
  startedAt: text('started_at').notNull(),           // UTC ISO
  endedAt: text('ended_at'),                          // UTC ISO; NULL = running
  source: text('source').default('timer'),           // timer | manual | block
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const schedulingPrefs = sqliteTable('scheduling_prefs', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id),
  workdayStart: text('workday_start').default('09:00'),
  workdayEnd: text('workday_end').default('18:00'),
  deepWorkWindows: text('deep_work_windows', { mode: 'json' }).$type<{ start: string; end: string }[]>(),
  maxFocusBlockMinutes: integer('max_focus_block_minutes').default(90),
  minBreakMinutes: integer('min_break_minutes').default(10),
  dayTheme: text('day_theme', { mode: 'json' }).$type<Record<string, string>>(),
  planningMode: text('planning_mode').default('ritual'), // retired (Phase G); column kept, UI removed
  timezone: text('timezone'), // IANA zone (e.g. America/Los_Angeles); workday hours are wall-clock here
  planningHorizonDays: integer('planning_horizon_days').default(7), // "today set" lookahead for auto-scheduling
  // Time-Block container duration bounds (0017). Distinct from the Auto engine's
  // focus-session/break knobs above.
  maxTimeBlockMinutes: integer('max_time_block_minutes').default(240),
  minTimeBlockMinutes: integer('min_time_block_minutes').default(15),
  // Plan/Concept Time-Block config (0018). Plan horizon reuses planningHorizonDays.
  planAlldayAlways: integer('plan_allday_always', { mode: 'boolean' }).default(false),
  planDaylongForPromoted: integer('plan_daylong_for_promoted', { mode: 'boolean' }).default(false),
  planAutofillGaps: integer('plan_autofill_gaps', { mode: 'boolean' }).default(true),
  // Auto's secondary workday-window fallback (0028). Plans are filled first;
  // this gates whether leftover tasks also fill open 9–6 time. Default ON.
  autoFillWorkday: integer('auto_fill_workday', { mode: 'boolean' }).default(true),
  conceptDefaultMinutes: integer('concept_default_minutes').default(60),
  conceptAutosurface: integer('concept_autosurface', { mode: 'boolean' }).default(true),
  conceptHorizonDays: integer('concept_horizon_days').default(30),
  // Canonical, user-editable concept-tag list for the Block Wizard (0021).
  conceptTags: text('concept_tags', { mode: 'json' }).$type<{ name: string; minutes: number }[]>(),
  // Per-owner feature flags (0024). Default OFF — V1 mental model is Routine /
  // Habit / Plan-Block; Rituals are hidden until the user opts back in.
  enableRituals: integer('enable_rituals', { mode: 'boolean' }).default(false),
  // cockpit-v2 Phase 6: recall=clone of a Past task copies Routine membership only when ON (default OFF).
  recallKeepsPattern: integer('recall_keeps_pattern', { mode: 'boolean' }).default(false),
  // Per-owner Ollama model overrides (null = use the env default). 0012.
  fastModel: text('fast_model'),       // extraction / triage
  qualityModel: text('quality_model'), // briefings
  embedModel: text('embed_model'),     // dedupe embeddings
  // Companion Memory sync (one-way push; off by default). 0012.
  memorySyncEnabled: integer('memory_sync_enabled', { mode: 'boolean' }).default(false),
  memorySyncCompleted: integer('memory_sync_completed', { mode: 'boolean' }).default(true),
  memorySyncHabits: integer('memory_sync_habits', { mode: 'boolean' }).default(true),
  memorySyncReflections: integer('memory_sync_reflections', { mode: 'boolean' }).default(true),
  memoryAccount: text('memory_account'),            // connected account (null = not connected)
  memoryLastSyncedAt: text('memory_last_synced_at'), // UTC ISO of the last successful push
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull().unique(),
  // Tag taxonomy (0036) — a SECOND axis, orthogonal to entity_tags.level (Phase-5
  // per-entity dilution). `kind` is the taxonomy LEVEL: a 'direction' is a top-level
  // category (brand-set Home/Work/Community + user-added), an 'intention' is grouped
  // under one or more directions via tag_directions.
  kind: text('kind').notNull().default('intention'),       // 'direction' | 'intention'
  muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  isBase: integer('is_base', { mode: 'boolean' }).notNull().default(false), // undeletable base direction
});

// 0036: intention→direction membership (many-to-many). An intention tag with no row
// here is "Unsorted". Both sides FK tags(id) cascade.
export const tagDirections = sqliteTable(
  'tag_directions',
  {
    intentionTagId: text('intention_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
    directionTagId: text('direction_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.intentionTagId, t.directionTagId] }) })
);

// --- Patterns (Phase G). Typed, reusable task collections (Routine ▢ / Habit ◯ /
//     Ritual △ + user-defined). No own recurrence; tasks-only (no nesting) in V1. ---
export const patternTypes = sqliteTable('pattern_types', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id),
  name: text('name').notNull(),
  iconShape: text('icon_shape').notNull(),                       // square | circle | triangle | <custom>
  reminderConfig: text('reminder_config', { mode: 'json' }),     // opaque until Phase H
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).default(false),
  // Per-type display/config defaults (0017). Colour is a CI-Hub token key (e.g.
  // 'chart-1'), never a hex — patterns stay on the shared design system.
  colorToken: text('color_token'),                              // token key; null = default
  texture: text('texture'),                                     // motif override; null = derive from tag
  defaultEstMinutes: integer('default_est_minutes'),            // default est for this category
  notify: integer('notify', { mode: 'boolean' }).default(false), // per-type reminder toggle (Phase H fires)
});

export const patterns = sqliteTable('patterns', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id),
  typeId: text('type_id').references(() => patternTypes.id),
  name: text('name').notNull(),
  tag: text('tag'),
  notes: text('notes'),
  // Pattern-level recurrence (0025): RRULE + its UTC anchor. Only Habits +
  // Routines respect it; Rituals are flagged off in V1. The 06:00 cron
  // `place_patterns` expands these and runs `placePatternOnDay` idempotently.
  recurrenceRule: text('recurrence_rule'),
  recurrenceDtstart: text('recurrence_dtstart'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const patternTasks = sqliteTable(
  'pattern_tasks',
  {
    patternId: text('pattern_id').references(() => patterns.id, { onDelete: 'cascade' }).notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    position: integer('position').default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.patternId, t.taskId] }) })
);

// Flight-plan (Phase G): persisted, owner-scoped staging area for the two-step Auto.
export const flightPlan = sqliteTable(
  'flight_plan',
  {
    ownerId: text('owner_id').references(() => owners.id),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    sourcePatternId: text('source_pattern_id').references(() => patterns.id, { onDelete: 'set null' }),
    selected: integer('selected', { mode: 'boolean' }).default(true),
    position: integer('position').default(0),
    addedAt: text('added_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.taskId] }) })
);

export const taskTags = sqliteTable('task_tags', {
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  tagId: text('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
});

// CON-3: the canonical normalized tag store. ONE polymorphic association table
// for Task · Time Block · Routine, so Phase 5 (tag levels + dilution) has a
// single place to read level-weighted tags. `entity_id` spans three tables, so
// it has NO FK — integrity is **app-enforced** by the tag-repo (services/tags.ts),
// which owns every entity-delete path (the orphan-free tests are the gate).
// `time_blocks.tag` / `patterns.tag` stay as denormalized top-level mirrors;
// existing reads still use them. `level` defaults 1 (top-level); no dilution here.
export const entityTags = sqliteTable(
  'entity_tags',
  {
    entityKind: text('entity_kind').notNull(),                    // 'task' | 'time_block' | 'routine'
    entityId: text('entity_id').notNull(),                        // PK of the entity (no FK — spans tables)
    tagId: text('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
    level: integer('level').notNull().default(1),                 // 1 = top-level; >1 = secondary (Phase 5)
  },
  (t) => ({ pk: primaryKey({ columns: [t.entityKind, t.entityId, t.tagId] }) })
);

export const possibleTaskTags = sqliteTable('possible_task_tags', {
  possibleTaskId: text('possible_task_id').references(() => possibleTasks.id, { onDelete: 'cascade' }).notNull(),
  tagId: text('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
});

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  config: text('config', { mode: 'json' }),
});

export const jobRuns = sqliteTable('job_runs', {
  id: text('id').primaryKey().$defaultFn(newId),
  jobId: text('job_id').references(() => scheduledJobs.id),
  startedAt: text('started_at').default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text('finished_at'),
  status: text('status').default('running'),         // running | done | error
  itemsCreated: integer('items_created').default(0),
  itemsUpdated: integer('items_updated').default(0),
  log: text('log'),
});
