import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const owners = sqliteTable('owners', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email'),
});

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),        // short summary / legacy
  notes: text('notes'),                    // rich freeform notes
  dueAt: text('due_at'),                   // ISO datetime — hard deadline
  scheduledFor: text('scheduled_for'),     // local YYYY-MM-DD — intent to work it, not a deadline
  deferUntil: text('defer_until'),         // UTC ISO — hidden from the today-set until then
  taskTime: text('task_time'),             // HH:MM time-of-day if the task has a fixed start time
  estimatedMinutes: integer('estimated_minutes'),
  priority: integer('priority').default(3), // 1 highest, 5 lowest
  status: text('status').default('open'),   // open | scheduled | in_progress | done | cancelled | deferred
  parentId: integer('parent_id'),          // null = top-level task; set = subtask
  ownerId: integer('owner_id').references(() => owners.id),
  sourceKind: text('source_kind').default('manual'), // manual | agent | gmail | gcal
  sourceRef: text('source_ref'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  completedAt: text('completed_at'),
});

// Dependency edges: task_id is blocked until depends_on_id is done.
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    dependsOnId: integer('depends_on_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.taskId, t.dependsOnId] }) })
);

export const possibleTasks = sqliteTable('possible_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rawTitle: text('raw_title').notNull(),
  rawSummary: text('raw_summary'),
  proposedDueAt: text('proposed_due_at'),
  proposedPriority: integer('proposed_priority'),
  proposedOwnerId: integer('proposed_owner_id').references(() => owners.id),
  sourceKind: text('source_kind'),
  sourceRef: text('source_ref'),
  sourcePayload: text('source_payload', { mode: 'json' }),
  confidence: real('confidence'),
  status: text('status').default('pending'),         // pending | promoted | dismissed | duplicate
  promotedTaskId: integer('promoted_task_id').references(() => tasks.id),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const timeBlocks = sqliteTable('time_blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  blockKind: text('block_kind').default('task'),     // task | meeting | habit | focus | break | buffer
  startAt: text('start_at').notNull(),
  endAt: text('end_at').notNull(),
  isLocked: integer('is_locked', { mode: 'boolean' }).default(false),
  isAuto: integer('is_auto', { mode: 'boolean' }).default(true),
  sourceKind: text('source_kind').default('manual'),
  sourceRef: text('source_ref'),
  status: text('status').default('planned'),         // planned | completed | skipped | overrun
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const schedulingPrefs = sqliteTable('scheduling_prefs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerId: integer('owner_id').references(() => owners.id),
  workdayStart: text('workday_start').default('09:00'),
  workdayEnd: text('workday_end').default('18:00'),
  deepWorkWindows: text('deep_work_windows', { mode: 'json' }).$type<{ start: string; end: string }[]>(),
  maxFocusBlockMinutes: integer('max_focus_block_minutes').default(90),
  minBreakMinutes: integer('min_break_minutes').default(10),
  dayTheme: text('day_theme', { mode: 'json' }).$type<Record<string, string>>(),
  planningMode: text('planning_mode').default('ritual'), // auto | ritual
  timezone: text('timezone'), // IANA zone (e.g. America/Los_Angeles); workday hours are wall-clock here
  planningHorizonDays: integer('planning_horizon_days').default(7), // "today set" lookahead for auto-scheduling
});

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

export const taskTags = sqliteTable('task_tags', {
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  tagId: integer('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
});

export const possibleTaskTags = sqliteTable('possible_task_tags', {
  possibleTaskId: integer('possible_task_id').references(() => possibleTasks.id, { onDelete: 'cascade' }).notNull(),
  tagId: integer('tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
});

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  config: text('config', { mode: 'json' }),
});

export const jobRuns = sqliteTable('job_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').references(() => scheduledJobs.id),
  startedAt: text('started_at').default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text('finished_at'),
  status: text('status').default('running'),         // running | done | error
  itemsCreated: integer('items_created').default(0),
  itemsUpdated: integer('items_updated').default(0),
  log: text('log'),
});
