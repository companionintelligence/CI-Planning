import { sqliteTable, text, integer, real, primaryKey, unique, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { newId } from '../lib/ids.js';

// CON-1: entity ids are TEXT UUIDv7 (see lib/ids.ts). Drizzle inserts mint via
// $defaultFn(newId); raw-SQL inserts use the uuid7() function (db/index.ts).

// owner ≡ user (Phase T decision #1, 1:1 tenant = user). The auth-identity columns
// (0101, U0) are all nullable — an owner's auth mode is inferred from which are set:
// external_subject ⇒ OIDC/CI-Portal (U1); username+password_hash ⇒ local login (U2);
// all NULL ⇒ the SYSTEM_OWNER sentinel. Uniqueness is enforced by partial unique
// indexes in the migration (SQLite can't ADD COLUMN with UNIQUE), so it isn't
// modelled here — .unique() would emit an inline constraint the migration doesn't use.
export const owners = sqliteTable('owners', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  email: text('email'),
  lastAutoRunId: text('last_auto_run_id'), // most recent Auto placement run, for Undo (0052)
  externalSubject: text('external_subject'), // OIDC token `sub` → owner (U1); UNIQUE via ux_owners_external_subject
  username: text('username'),                // local-login handle (U2); UNIQUE via ux_owners_username
  passwordHash: text('password_hash'),       // argon2id hash (U2)
  backupEmail: text('backup_email'),         // fallback password-reset destination (V; 0103). email tried first
  // Auth epoch (V; 0103): the session cookie carries `${id}.${epoch}`; a password reset
  // bumps this to invalidate every existing cookie (the stateless session's revocation).
  sessionEpoch: integer('session_epoch').notNull().default(0),
  // Phase AG (0125): operator/member/viewer — verifySession derives the session's
  // scopes from this via roleToScopes. Existing owners were backfilled to 'operator'.
  role: text('role').notNull().default('member'),
});

// Phase I (0049): standalone API keys. SHA-256 at rest; the raw key is shown once
// and never stored. Queried via lib/auth/apiKey.ts (raw SQL, for the constant-time
// hash compare); this table documents the shape + keeps Drizzle's schema complete.
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').notNull().default('[]'),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text('revoked_at'),
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
  subtype: text('subtype').default('standard'), // CON-2c canonical Task subtype: standard | habit | quick (0032; booleans dropped 0048)
  deferCount: integer('defer_count').notNull().default(0), // times rescheduled by the nightly review (0029)
  ownerId: text('owner_id').references(() => owners.id),
  sourceKind: text('source_kind').default('manual'), // manual | agent | gmail | gcal
  sourceRef: text('source_ref'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  completedAt: text('completed_at'),
  // ── Close ritual (0137, rescored 0161) — all optional; the plain checkbox never sets them. ──
  // 1-5 from the three-face picker (frown=1 · frown+flat=2 · flat=3 · flat+smile=4 · smile=5).
  // 0 is the DECLINED sentinel (prompted, skipped) — not a rating, and excluded from every
  // score aggregate. NULL = never prompted.
  completionScore: integer('completion_score'),
  completionNote: text('completion_note'),   // the closing reflection — NOT `notes` (the description)
  // WHEN the reflection was recorded. Distinct from completed_at (the assumed task end):
  // reacting later is normal, and `reaction_at − completed_at` is the freshness of the read.
  reactionAt: text('reaction_at'),
  // ── Motivation axis (0141, design §3b) — who the work is for. ──
  // 'me' | 'us' | 'them' | NULL(unlabeled). NULL ≠ 'us': "shared" is a positive
  // claim, "never asked" is the absence of one; only SCORING collapses both to 0.
  motivation: text('motivation'),
  // 'user' (wins permanently, never re-tagged) | 'llm' (model or keyword fallback).
  // NULL exactly when motivation is NULL.
  motivationSource: text('motivation_source'),
  // Phase L: monotonic per-record version (advances on every applied op or PATCH);
  // field_ts is a JSON { field: utcIso } map for per-field LWW; updated_at is the
  // server clock of the last write (informational, not a lock cursor).
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at'),
  fieldTs: text('field_ts'),
  // 0135 (Categories Phase B): per-element striped-texture override. enabled=1 shows the
  // category-derived texture; color_token (null ⇒ derive from the element's categories).
  textureEnabled: integer('texture_enabled', { mode: 'boolean' }).notNull().default(true),
  textureColorToken: text('texture_color_token'),
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
  // Intentionally named `proposed_owner_id` (not `owner_id`): a *proposed*, not
  // yet confirmed, owner assignment for an inbox item. Documented, NOT renamed (T4).
  proposedOwnerId: text('proposed_owner_id').references(() => owners.id),
  sourceKind: text('source_kind'),
  sourceRef: text('source_ref'),
  sourcePayload: text('source_payload', { mode: 'json' }),
  confidence: real('confidence'),
  status: text('status').default('pending'),         // pending | promoted | dismissed | duplicate
  promotedTaskId: text('promoted_task_id').references(() => tasks.id),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  // Extractor/template duration estimate, carried to tasks.estimated_minutes on promote
  // (0114) — the hands-off auto-schedule path requires an estimate to place a block.
  // NOTE: 0114 also rescoped the table's dedup key to UNIQUE(proposed_owner_id,
  // source_kind, source_ref) (was global since 0001).
  proposedEstimatedMinutes: integer('proposed_estimated_minutes'),
  // AB2 (0115): the suggestion's START intent — event day (owner-tz YYYY-MM-DD) +
  // wall-clock HH:MM. Promote copies them to tasks.scheduled_for / task_time, then
  // AB1's placeStartAnchoredTask lands the block at the event's time on its day.
  proposedScheduledFor: text('proposed_scheduled_for'),
  proposedTaskTime: text('proposed_task_time'),
});

export const timeBlocks = sqliteTable('time_blocks', {
  id: text('id').primaryKey().$defaultFn(newId),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  // T1 (multi-tenant): every block belongs to an owner. Task-backed blocks inherit
  // their task's owner; container/meeting blocks (task_id NULL) carry it directly.
  ownerId: text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
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
  // 0069: Time Block Category — a tags.kind='category' row. Direction is IMPLIED by the
  // category (the wizard sets category_id, NOT tag). ON DELETE SET NULL so deleting a
  // category never deletes blocks. color_token is the FROZEN stamp from the category's tag_prefs
  // at create-time → editing/deleting a category never re-colors existing blocks.
  categoryId: text('category_id').references((): AnySQLiteColumn => tags.id, { onDelete: 'set null' }),
  colorToken: text('color_token'),                   // frozen category color (forward-only)
  // CON-4 recurrence (0034): bare recurring Time Blocks via the SHARED rrule.js
  // engine (recurrence.ts), mirroring tasks. A *template* has recurrenceRule set +
  // recurrenceParentId null (never rendered directly); GET materializes one
  // *instance* per occurrence (recurrenceParentId = template, occurrenceDate set),
  // idempotent via ux_block_occurrence. patterns.recurrence_rule (0025) is kept.
  recurrenceRule: text('recurrence_rule'),           // RRULE string; null = one-off
  recurrenceDtstart: text('recurrence_dtstart'),     // UTC ISO anchor of the series
  recurrenceParentId: text('recurrence_parent_id'),  // template id on an instance (no FK: cleared by hand)
  recurrenceExdates: text('recurrence_exdates', { mode: 'json' }).$type<string[]>(), // 0075: skipped local YYYY-MM-DD (per-instance delete)
  occurrenceDate: text('occurrence_date'),           // YYYY-MM-DD local day of an instance
  autoRunId: text('auto_run_id'),                    // the Auto placement run that created this block (0052; for Undo)
  lastMovedAt: text('last_moved_at'),               // B1: UTC ISO when reflow last moved this block (anti-thrash stability window)
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  // Phase L: same versioning columns as tasks (see tasks table comment).
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at'),
  fieldTs: text('field_ts'),
  // 0135 (Categories Phase B): per-element striped-texture override, same as tasks.
  textureEnabled: integer('texture_enabled', { mode: 'boolean' }).notNull().default(true),
  textureColorToken: text('texture_color_token'),
  // 0153/0154: PER-ROLE. false ⇒ a task-backed block with no rows of its own in that
  // role INHERITS its task's; true ⇒ this block's own set is authoritative even when
  // EMPTY, which is what lets "nobody" be expressible. Per-role because the two sets
  // are independent — a meeting can carry its own attendees while still inheriting who
  // the underlying task is for.
  responsiblePinned: integer('responsible_pinned', { mode: 'boolean' }).notNull().default(false),
  beneficiariesPinned: integer('beneficiaries_pinned', { mode: 'boolean' }).notNull().default(false),
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
  deepWorkWindows: text('deep_work_windows', { mode: 'json' }).$type<{ start: string; end: string }[]>(),
  maxFocusBlockMinutes: integer('max_focus_block_minutes').default(90),
  minBreakMinutes: integer('min_break_minutes').default(10),
  dayTheme: text('day_theme', { mode: 'json' }).$type<Record<string, string>>(),
  planningMode: text('planning_mode').default('basic'), // 'basic' (deterministic deadline→priority sort) | 'smart' (§A0 LLM loop). Also activated implicitly when trustMode='hands_off'.
  timezone: text('timezone'), // IANA zone (e.g. America/Los_Angeles); workday hours are wall-clock here
  planningHorizonDays: integer('planning_horizon_days').default(7), // "today set" lookahead for auto-scheduling
  // Phase P (0091): how many days ahead (from today, inclusive) the lazy recurrence
  // engines materialize repeats. Bounds far-future auto-fill. DISTINCT from
  // planningHorizonDays (the auto-scheduler window). Settings offers {7,15,30,60,90,180}.
  recurrenceHorizonDays: integer('recurrence_horizon_days').default(7),
  // Time-Block container duration bounds (0017). Distinct from the Auto engine's
  // focus-session/break knobs above.
  maxTimeBlockMinutes: integer('max_time_block_minutes').default(240),
  minTimeBlockMinutes: integer('min_time_block_minutes').default(15),
  defaultTimeBlockMinutes: integer('default_time_block_minutes').default(60),
  // Plan/Concept Time-Block config (0018). Plan horizon reuses planningHorizonDays.
  planAlldayAlways: integer('plan_allday_always', { mode: 'boolean' }).default(false),
  planDaylongForPromoted: integer('plan_daylong_for_promoted', { mode: 'boolean' }).default(false),
  planAutofillGaps: integer('plan_autofill_gaps', { mode: 'boolean' }).default(true),
  // Auto's secondary workday-window fallback (0028). Plans are filled first;
  // this gates whether leftover tasks also fill open 9–6 time. Default ON.
  autoFillWorkday: integer('auto_fill_workday', { mode: 'boolean' }).default(true),
  // Trust dial (0070) — the 3-state automation Setting that replaced the 0052
  // auto_mode toggle (column dropped in 0123; the top-bar Suggest/Schedule toggle
  // now writes this dial: Schedule ⇔ 'hands_off', Suggest ⇔ 'balanced').
  // AF-3 retired its auto-PROMOTE facet (all possibles now promote unconditionally at
  // ingestion); the dial governs ONLY auto-blocking/planning:
  // 'cautious' | 'balanced' (no auto-block; the default) | 'hands_off' (auto-block
  // estimate-bearing promoted tasks; agents/plan.ts maps hands_off → smart).
  // Read via resolveTrustPolicy() in engine/autoplan.ts, never raw.
  trustMode: text('trust_mode').notNull().default('balanced'),
  // Leftover-fill ordering (0055): 'priority' (P1 first) | 'overdue' (due_at ASC first).
  fillOrder: text('fill_order').notNull().default('priority'),
  // B2 (0066): gates reactive reflow (requestReplan) on a big disruption. Default ON.
  // Read via raw SQL today; mirrored here so ORM queries see it (schema-parity).
  autoDefenseEnabled: integer('auto_defense_enabled', { mode: 'boolean' }).notNull().default(true),
  conceptDefaultMinutes: integer('concept_default_minutes').default(60),
  conceptAutosurface: integer('concept_autosurface', { mode: 'boolean' }).default(true),
  conceptHorizonDays: integer('concept_horizon_days').default(30),
  // Canonical, user-editable concept-tag list for the Block Wizard (0021).
  conceptTags: text('concept_tags', { mode: 'json' }).$type<{ name: string; minutes: number }[]>(),
  // Per-owner feature flags (0024). Default OFF — V1 mental model is Routine /
  // Habit / Plan-Block; Rituals are hidden until the user opts back in.
  enableRituals: integer('enable_rituals', { mode: 'boolean' }).default(false),
  // Routines feature flag (0073). Default OFF — hides the Routine tile in the Add
  // wizard AND stops recurring Routine patterns from auto-placing on the board.
  enableRoutines: integer('enable_routines', { mode: 'boolean' }).default(false),
  // cockpit-v2 Phase 6: recall=clone of a Past task copies Routine membership only when ON (default OFF).
  recallKeepsPattern: integer('recall_keeps_pattern', { mode: 'boolean' }).default(false),
  // Phase Z Time-Sense master flag (0106). Default OFF — gates the Focus Ritual,
  // Calibration Loop scoping, and EOD Alignment while the phase lands dark.
  timeSenseEnabled: integer('time_sense_enabled', { mode: 'boolean' }).default(false),
  // Phase Z · Z5 per-cue prefs matrix (0108). All default ON — read only while
  // timeSenseEnabled is on, so they're behaviour-neutral for pre-Z owners. Haptic +
  // ambient color are overridden per experiment arm on first enable (§5.2); all four
  // stay user-configurable afterward (§4: every cue disableable). z_experiment_arm is
  // the fixed A/B/C/D bucket, server-assigned only (NULL until first Time-Sense enable).
  focusRitualEnabled: integer('focus_ritual_enabled', { mode: 'boolean' }).default(true),
  hapticCuesEnabled: integer('haptic_cues_enabled', { mode: 'boolean' }).default(true),
  ambientColorEnabled: integer('ambient_color_enabled', { mode: 'boolean' }).default(true),
  calibrationLoopEnabled: integer('calibration_loop_enabled', { mode: 'boolean' }).default(true),
  zExperimentArm: text('z_experiment_arm'), // 'A' | 'B' | 'C' | 'D' | null

  // Cross-device calendar UI view-state (0111). One extensible JSON blob; NULL = no
  // saved view state → the client uses its built-in defaults (filter all-shown,
  // night hours both-collapsed). Stored/read as a raw string here — the /api/prefs
  // route JSON-parses on GET and JSON-stringifies (after plain-object validation) on
  // PATCH, so callers see a nested object, not a string. Shape:
  //   { calendar?: { deselected?: { direction/intention/category?: string[] },
  //                  prio?: number[], topExpanded?: boolean, bottomExpanded?: boolean } }
  // Future surfaces (deferred Planner collapse) add a sibling key, not a migration.
  viewPrefs: text('view_prefs'),

  // Per-owner Ollama model overrides (null = use the env default). 0012.
  fastModel: text('fast_model'),       // extraction / triage
  qualityModel: text('quality_model'), // briefings
  embedModel: text('embed_model'),     // dedupe embeddings
  // Opt-in "thinking" pass on generation calls (0155) — off by default, since it needs a
  // wider timeout and some thinking models return an empty response under format:json
  // regardless. See mcp/ollama.ts generate() and lib/models.ts's auto-select exclusion.
  llmThinkingEnabled: integer('llm_thinking_enabled', { mode: 'boolean' }).default(false),
  // Companion Memory sync (one-way push; off by default). 0012.
  memorySyncEnabled: integer('memory_sync_enabled', { mode: 'boolean' }).default(false),
  memorySyncCompleted: integer('memory_sync_completed', { mode: 'boolean' }).default(true),
  memorySyncHabits: integer('memory_sync_habits', { mode: 'boolean' }).default(true),
  memorySyncReflections: integer('memory_sync_reflections', { mode: 'boolean' }).default(true),
  memoryAccount: text('memory_account'),            // connected account (null = not connected)
  memoryLastSyncedAt: text('memory_last_synced_at'), // UTC ISO of the last successful push
  // Phase AA (0113): master flag for PULLING the CI-Server memory graph into the
  // agentic surfaces (inbox suggestions). Default OFF — flag-off is byte-identical.
  // Distinct from memorySyncEnabled (the one-way PUSH toggle above, AA4).
  memoryPullEnabled: integer('memory_pull_enabled', { mode: 'boolean' }).default(false),
  // Ingestion windows (0147) — how much of each upstream source a pull reads. The two
  // point in OPPOSITE directions on purpose: memory suggestions mirror UPCOMING events
  // into tasks, so its window looks forward; an inbox is only ever read backwards.
  // Default 2 = the 48h that memory-suggest/summarize used to hardcode (no-op upgrade).
  memoryWindowDays: integer('memory_window_days').notNull().default(2),
  // Floor on how far back a Gmail ingest may reach. Applied even when the sync_state
  // watermark is older, so reconnecting after a long outage pulls a week — not a year.
  emailLookbackDays: integer('email_lookback_days').notNull().default(7),
  // Triality master flag (0139). Default OFF — gates the Focus suggestion banner,
  // the Balance→Metrics Triality tiles, and every /api/triality/* route while the
  // feature lands dark (docs/triality-design.md §7). Flag-off = byte-identical.
  trialityEnabled: integer('triality_enabled', { mode: 'boolean' }).default(false),
  // Onboarding Priorities Wizard (0128): weekly hours reserved for SLEEP — unschedulable,
  // attributed to Health. Default 63 = 9h/night × 7; the wizard's schedulable pool = 168 − this.
  sleepHoursPerWeek: integer('sleep_hours_per_week').notNull().default(63),
  // FTUE · T11 (0132): NULL = the owner hasn't completed/skipped the first-run
  // onboarding wizard yet; non-NULL ISO-8601 is both the "done" flag and its timestamp.
  onboardedAt: text('onboarded_at'),
  // 0156: replaces the removed workday_start/workday_end as the source for the
  // AI-authoring "capacity today" hint. Default 56 = 8h/day × 7.
  capacityHoursPerWeek: integer('capacity_hours_per_week').notNull().default(56),
  // 0164 (balance-targets wave, bal-2): master gate for the auto-planning bias
  // tickets 3/4 add — nudges candidate ordering/placement toward life dimensions
  // running behind their weekly target. Default ON (owner ruling 2026-08-29). Not a
  // Time-Sense channel; the suggest surface and weekly snapshot are deliberately NOT
  // gated by this flag.
  balanceBiasEnabled: integer('balance_bias_enabled', { mode: 'boolean' }).notNull().default(true),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey().$defaultFn(newId),
  // T2 (multi-tenant): every tag belongs to an owner; `name` is unique PER-OWNER
  // (see the table-level unique below), not globally.
  ownerId: text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  // Tag taxonomy (0036/0043; 'category' added 0069) — a SECOND axis, orthogonal to
  // entity_tags.level (Phase-5 per-entity dilution). `kind` is the taxonomy LEVEL: a
  // 'direction' is a top-level GROUPING (brand-set Work/Life/Home + user-added); an
  // 'intention' is grouped under one or more directions via tag_directions; a 'category'
  // (0069) is a SECOND, orthogonal grouping over intentions via tag_categories —
  // surfaced to the user as "Time Block Category". ('direction' was briefly renamed to
  // 'pattern' in 0038/0043; reverted in 0105 — "pattern" now means only the day-arrangement.)
  kind: text('kind').notNull().default('intention'),       // 'direction' | 'intention' | 'category'
  muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  isBase: integer('is_base', { mode: 'boolean' }).notNull().default(false), // undeletable base direction
}, (t) => ({ ownerName: unique().on(t.ownerId, t.name) }));

// 0036: intention→direction membership (many-to-many). An intention tag with no row
// here is "Unsorted". Both sides FK tags(id) cascade. (0043 renamed this to
// tag_patterns/pattern_tag_id; 0105 reverted it back to tag_directions/direction_tag_id.)
export const tagDirections = sqliteTable(
  'tag_directions',
  {
    intentionTagId: text('intention_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
    directionTagId: text('direction_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.intentionTagId, t.directionTagId] }) })
);

// 0069: intention→category-tag membership (many-to-many). A verbatim mirror of
// tag_directions on the second grouping axis: an intention with no row here is
// "Unsorted" in the Time Block Category view. Both sides FK tags(id) cascade.
export const tagCategories = sqliteTable(
  'tag_categories',
  {
    intentionTagId: text('intention_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
    categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.intentionTagId, t.categoryTagId] }) })
);

// 0069: per-category direction SCOPE, opt-out polarity. A row = this direction tag is
// turned OFF for this category; an empty set = all directions on. Opt-out polarity makes
// "default all-on for every existing & new category — and any future direction" fall out
// for free (no backfill). Precedent: tags.muted. (Column pattern_tag_id → direction_tag_id in 0105.)
export const categoryDirectionOptouts = sqliteTable(
  'category_direction_optouts',
  {
    categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
    directionTagId: text('direction_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.categoryTagId, t.directionTagId] }) })
);

// 0037: direction-scoped scheduling windows (Pattern-block, noun 8 — the day-arrangement;
//       KEEPS the "pattern" table name). Multiple rows per (owner, direction_tag_id, day_type).
export const patternBlocks = sqliteTable('pattern_blocks', {
  id:            text('id').primaryKey().$defaultFn(newId),
  ownerId:       text('owner_id').references(() => owners.id).notNull(),
  directionTagId: text('direction_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  dayType:       text('day_type').notNull(), // a day_types.key (builtin 'workday'/'weekend' or custom)
  startTime:     text('start_time').notNull(), // 'HH:MM' wall-clock in owner's timezone
  endTime:       text('end_time').notNull(),
});

// 0068: custom day types + per-date assignment (T-SCHED-3). resolveDayType() maps a
// date → day-type key (per-date assignment > weekly map > UTC weekend heuristic),
// which selects the pattern_blocks windows Auto places into. Builtins workday/weekend
// are rename-only (is_builtin=1).
export const dayTypes = sqliteTable('day_types', {
  id:        text('id').primaryKey().$defaultFn(newId),
  ownerId:   text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  key:       text('key').notNull(),
  name:      text('name').notNull(),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({ ownerKey: unique().on(t.ownerId, t.key) }));

// The recurring weekly default: dow (0=Sun … 6=Sat, UTC noon) → day-type key.
export const dayOfWeekMap = sqliteTable('day_of_week_map', {
  ownerId:    text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  dow:        integer('dow').notNull(),
  dayTypeKey: text('day_type_key').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.dow] }) }));

// Per-date override: a specific 'YYYY-MM-DD' → day-type key (beats the weekly map).
export const dayAssignments = sqliteTable('day_assignments', {
  ownerId:    text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  date:       text('date').notNull(),
  dayTypeKey: text('day_type_key').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.date] }) }));

// 0097: per-owner, per-tag preferences — merges the former pattern_prefs (0039) and
// category_prefs (0069) into one table keyed by (owner, tag), distinguished by `kind`
// ('direction' | 'category'). Shared columns: color_token (CI-Hub token, never hex —
// on the category axis it's the SOURCE of the forward-only stamp onto
// time_blocks.color_token) + default_minutes. Direction-only columns
// (auto_fill scheduling gate, reminder_offsets, icon_shape display) are NULLABLE —
// category rows carry NULL for them. `kind` mirrors tags.kind (denormalized so each
// service filters without a join). The two GET/PUT contracts are unchanged.
export const tagPrefs = sqliteTable('tag_prefs', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  tagId: text('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),                                  // 'direction' | 'category'
  autoFill: integer('auto_fill', { mode: 'boolean' }),           // direction-only (nullable)
  reminderOffsets: text('reminder_offsets', { mode: 'json' }).$type<number[]>(), // direction-only
  iconShape: text('icon_shape'),                                 // direction-only: circle | square | triangle
  colorToken: text('color_token').notNull().default('primary'),  // CI-Hub token key (never hex)
  defaultMinutes: integer('default_minutes').notNull().default(60),
  // direction-only (0170): whether this direction's free windows appear on the
  // Today "Open Time" card. Default true for every direction, including home.
  showOpenTime: integer('show_open_time', { mode: 'boolean' }).notNull().default(true),
}, (t) => ({ uq: unique().on(t.ownerId, t.tagId) }));

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
  // 0054: a catch-all Plan (the built-in "Community") accepts every staged task regardless
  // of tag. Read via raw SQL today; mirrored here so ORM queries see it (schema-parity).
  catchAll: integer('catch_all', { mode: 'boolean' }).notNull().default(false),
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
  // #391 (0133) — per-ITEM colour token (CI-Hub key); NULL = inherit the type's.
  colorToken: text('color_token'),
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
    ownerId: text('owner_id').references(() => owners.id).notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    sourceKind: text('source_kind').default('manual').notNull(), // DB has NOT NULL since 0081; drift fixed here
    sourceRef: text('source_ref'),
    selected: integer('selected', { mode: 'boolean' }).default(true),
    position: integer('position').default(0),
    addedAt: text('added_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.taskId] }) })
);

// task_tags was dropped in migration 0041 (CON-3) — task tags live in entity_tags (level 1).

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
    // W4a (0110): when this tag was applied. `NOT NULL DEFAULT CURRENT_TIMESTAMP` at the DB
    // level — 0110 rebuilt the table to add it, since SQLite can't ADD COLUMN a non-constant
    // default. So ALL six insert paths (services/tags.ts, auto-tag, blocks-recur, possibles,
    // recall clone, groom) get a value automatically — GraphQL's `EntityTagType.taggedAt:
    // DateTime!` can never serialize a null. Do NOT add per-call-site stamping.
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.entityKind, t.entityId, t.tagId] }) })
);

// 0134: Categories ⇄ Balance unification. A task OR a time block carries 1–3
// CATEGORIES (a second multi-select axis, like intentions) — the single
// time_blocks.category_id column can't. category_tag_id FK→tags(id) cascade; no FK on
// entity_id (spans tasks + time_blocks, app-enforced like entity_tags). `position`
// (0–2) orders the categories, which drives the even-stripe texture order. Kept SEPARATE
// from entity_tags on purpose — the "categories never enter entity_tags" invariant holds.
export const entityCategories = sqliteTable(
  'entity_categories',
  {
    entityKind: text('entity_kind').notNull(),                    // 'task' | 'time_block'
    entityId: text('entity_id').notNull(),
    categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.entityKind, t.entityId, t.categoryTagId] }) })
);

export const possibleTaskTags = sqliteTable('possible_task_tags', {
  possibleTaskId: text('possible_task_id').references(() => possibleTasks.id, { onDelete: 'cascade' }).notNull(),
  tagId: text('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
});

// 0151 (People on work): the per-tenant person directory.
//
// ⚠️ `ownerId` and `accountId` BOTH reference owners(id) and mean different things:
//   - ownerId   — TENANCY, exactly as on every other table. Whose directory this is.
//   - accountId — the permissioned ACCOUNT this person IS, when they have a login here.
//     NULL for most people (a spouse, a client). Accounts are a convenience that makes a
//     roster available to pre-fill from, never a condition on who can be named on an item.
// `accountId === ownerId` marks the user's own row, so "is self" is DERIVED, never
// stored — the two can't disagree. Uniqueness is per-owner on both name and account,
// enforced by indexes in the migration (the account one is PARTIAL, so it isn't
// modelled here — .unique() would emit an inline constraint the migration doesn't use).
export const people = sqliteTable('people', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  accountId: text('account_id').references(() => owners.id, { onDelete: 'set null' }),
  displayName: text('display_name').notNull(),
  // 0 = provisionally created by ingest at promote-time, never confirmed by the user.
  // Settings → People surfaces these for merge/rename/delete.
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(true),
  source: text('source'),                          // 'manual' | 'account' | 'gcal' | 'gmail' | 'llm'
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// 0151: the deterministic matching key — an inbound address becomes a person with no
// model in the loop. Owner-scoped uniqueness, NOT global: the same address may be two
// different people across two tenants.
export const personEmails = sqliteTable(
  'person_emails',
  {
    ownerId: text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
    personId: text('person_id').references(() => people.id, { onDelete: 'cascade' }).notNull(),
    email: text('email').notNull(),                // lowercased by services/people.ts
  },
  (t) => ({ pk: primaryKey({ columns: [t.ownerId, t.email] }) })
);

// 0151: both people-sets an item carries, distinguished only by `role`. A structural
// mirror of entity_categories — same entity-spanning idiom, same no-FK-on-entity_id
// rule, same position, same created_at default.
//
// `role` is IN THE PRIMARY KEY because the same person legitimately appears in both
// sets (you are usually both responsible for and a beneficiary of your own work) —
// which is exactly why the two fields share one table rather than two shapes.
// No cardinality constraint on either set: "the lead" is position 0 within
// 'responsible', a display convention rather than a schema rule.
export const entityPeople = sqliteTable(
  'entity_people',
  {
    entityKind: text('entity_kind').notNull(),     // 'task' | 'time_block'
    entityId: text('entity_id').notNull(),         // PK of the entity (no FK — spans tables)
    personId: text('person_id').references(() => people.id, { onDelete: 'cascade' }).notNull(),
    role: text('role').notNull(),                  // 'responsible' | 'beneficiary'
    source: text('source'),                        // 'user' | 'llm' | 'calendar' | 'email'
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.entityKind, t.entityId, t.personId, t.role] }) })
);

// 0152: people detected on a suggestion, carried onto the task at promote. The people
// counterpart to possible_task_tags. `confidence` is per-row because the roles are
// detected differently — responsible comes from attendees/headers (fact), beneficiary
// from the model (judgment).
export const possibleTaskPeople = sqliteTable(
  'possible_task_people',
  {
    possibleTaskId: text('possible_task_id').references(() => possibleTasks.id, { onDelete: 'cascade' }).notNull(),
    personId: text('person_id').references(() => people.id, { onDelete: 'cascade' }).notNull(),
    role: text('role').notNull(),                  // 'responsible' | 'beneficiary'
    source: text('source'),                        // 'llm' | 'calendar' | 'email'
    confidence: real('confidence'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.possibleTaskId, t.personId, t.role] }) })
);

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastRunAt: text('last_run_at'),
  // Dead column (see #392): defined + exposed over REST (SELECT j.*) and GraphQL but
  // NEVER written — startCronJobs discards the Cron instance (croner's .nextRun()
  // could supply it). Always null; job.graphql documents the same.
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

// --- Phase H (0044): Notifications + Web Push. Both owner-scoped. ---

// One row per browser push endpoint. `endpoint` is unique → subscribe is an upsert.
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// A single fire_at per row with exactly one target (task XOR block — enforced by a
// CHECK in migration 0044). The dispatcher fires `pending` rows whose fire_at <= now.
export const reminders = sqliteTable('reminders', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  blockId: text('block_id').references(() => timeBlocks.id, { onDelete: 'cascade' }),
  fireAt: text('fire_at').notNull(),                  // UTC ISO; tz-correct via lib/tz
  status: text('status').notNull().default('pending'), // pending | fired | snoozed | cancelled
  firedAt: text('fired_at'),
  source: text('source').notNull().default('manual'), // manual (explicit API) | auto (derived from Reminder Defaults)
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// --- Phase J (0050): Encrypted OAuth token store. One row per (owner, provider, account). ---
// Token JSON is AES-256-GCM sealed via lib/crypto (KEK from CP_KEK_B64).
export const connectionTokens = sqliteTable('connection_tokens', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  provider: text('provider').notNull(), // 'google' | 'outlook' | 'icloud'
  account: text('account').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  status: text('status').notNull().default('active'), // 'active' | 'revoked' | 'error' (0058)
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// --- Wave 0 (0058): OAuth authorization-code/PKCE state store. One short-lived row per
// in-flight authorize redirect; `state` is the CSRF nonce, `code_verifier` the PKCE secret. ---
export const oauthStates = sqliteTable('oauth_states', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  provider: text('provider').notNull().default('google'),
  state: text('state').notNull().unique(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce'),
  redirectUri: text('redirect_uri'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  expiresAt: text('expires_at'),
});

// U1 (0102): pre-login OAuth state for the CI-Portal login flow — oauth_states minus
// owner_id (no owner exists yet when the login starts; the Google table's NOT NULL
// owner binding is correct for account-linking and stays untouched).
export const authStates = sqliteTable('auth_states', {
  id: text('id').primaryKey().$defaultFn(newId),
  state: text('state').notNull().unique(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  redirectUri: text('redirect_uri'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  expiresAt: text('expires_at').notNull(),
});

// V (0104): single-use, expiring password-reset tokens for local sign-in. One row per
// outstanding reset, bound to an owner (ON DELETE CASCADE). `token_hash` = sha256 of the
// raw token — the raw value lives only in the emailed link, never at rest. `used_at`
// marks single-use consumption. See lib/auth/resetToken.ts.
export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// B2 (0172): single-use, expiring invite codes for local self-serve sign-up
// (AUTH_SIGNUP=invite). `code_hash` = sha256 of the raw code, which is shown to the
// operator once at mint time and never stored. `used_at`/`used_by` stamp consumption,
// `revoked_at` an operator withdrawal. Owner FKs SET NULL so neither the minting
// operator's nor the signed-up account's deletion is blocked. See lib/auth/signupCodes.ts.
export const signupCodes = sqliteTable('signup_codes', {
  id: text('id').primaryKey().$defaultFn(newId),
  codeHash: text('code_hash').notNull().unique(),
  note: text('note'),
  createdBy: text('created_by').references(() => owners.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  usedBy: text('used_by').references(() => owners.id, { onDelete: 'set null' }),
  revokedAt: text('revoked_at'),
});

// --- Wave 0 (0060): Per-(owner, provider, account, resource) sync cursor store. ---
// `resource` distinguishes 'calendar_synctoken' vs 'gmail_history'; `cursor` is opaque.
export const syncState = sqliteTable('sync_state', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  provider: text('provider').notNull(),
  account: text('account').notNull(),
  resource: text('resource').notNull(),
  cursor: text('cursor'),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// --- Phase J (0051): Sync identity map. Links provider events to local time_blocks. ---
// Conflict identity: (provider, account, external_id) + etag. No embeddings here.
export const externalEvents = sqliteTable('external_events', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  provider: text('provider').notNull(),
  account: text('account').notNull(),
  externalId: text('external_id').notNull(),
  blockId: text('block_id').references(() => timeBlocks.id, { onDelete: 'cascade' }),
  etag: text('etag'),
  direction: text('direction').notNull().default('inbound'), // 'inbound' | 'outbound'
  lastSyncedAt: text('last_synced_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// --- Phase J (0055): Outbound sync queue. One row per (block, provider, account) pending push. ---
// ON CONFLICT(block_id, provider, account) DO UPDATE refreshes created_at so the latest mutation wins.
export const outboundQueue = sqliteTable('outbound_queue', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  blockId: text('block_id').references(() => timeBlocks.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull(),
  account: text('account').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// --- Phase L (0077): Append-only SSE event log for Last-Event-ID catch-up. ---
export const syncEvents = sqliteTable('sync_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  // T4 (0098): enforced FK to owners(id) — no ON DELETE CASCADE (owners aren't
  // deleted yet; cascade normalization is deferred to Phase U).
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  entity: text('entity').notNull().default(''),
  entityId: text('entity_id').notNull().default(''),
  version: integer('version'),
  event: text('event').notNull(),
  payload: text('payload').notNull(),
  at: text('at').notNull(),
});

// --- Phase R (0046): Audit log. Append-only; every mutating route writes one row. ---
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  actor: text('actor').notNull(),    // 'owner' | 'system' | 'agent'
  action: text('action').notNull(),  // 'create' | 'update' | 'delete' | 'timer:start' | ...
  entity: text('entity').notNull(),  // 'task:<id>' | 'block:<id>' | 'import' | ...
  at: text('at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).notNull(),
});

// --- Life priorities (0127): a per-owner self-audit — satisfaction/importance/target
// hours per life category. Upserted by (owner_id, category) via the Priorities Wizard;
// the Balance view reads it. Category is a fixed client-side key, not a tags FK. ---
export const lifePriorities = sqliteTable('life_priorities', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id, { onDelete: 'cascade' }).notNull(),
  category: text('category').notNull(), // health | career | relationships | growth | leisure | finance
  satisfaction: integer('satisfaction').notNull().default(5),        // 1–10 (clamped in the service)
  importance: integer('importance').notNull().default(5),            // 1–10
  targetHoursPerWeek: integer('target_hours_per_week').notNull().default(0), // 0–168
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({ ownerCategory: unique().on(t.ownerId, t.category) }));

// --- FTUE · T1 (0131): the planning-session log. One row per "Plan my week" session;
// the whole conversation is the `transcript` JSON array on the row — no per-turn events
// table by design. `entry_branch`/`status` are code-enforced enums, not CHECK constraints.
// The ix_planning_sessions_owner index lives in the migration DDL, per repo convention. ---
export const planningSessions = sqliteTable('planning_sessions', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  startedAt: text('started_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  endedAt: text('ended_at'),
  entryBranch: text('entry_branch').notNull(),          // fill_week | schedule_tasks | review | onboarding
  status: text('status').notNull().default('open'),     // open | completed | abandoned
  llmUsed: integer('llm_used', { mode: 'boolean' }).notNull().default(false),
  transcript: text('transcript').notNull().default('[]'), // JSON array of { role, text, ts }
  summary: text('summary'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});
