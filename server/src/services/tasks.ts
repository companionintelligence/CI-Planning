import { and, eq, gt, asc } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { tasks, taskDependencies } from '../db/schema.js';
import { setDependencies, DependencyCycleError } from '../engine/deps.js';
import { parseRule } from '../engine/recurrence.js';
import { generateRecurrences, ownerTimezone, type GenerateResult } from '../engine/recurrence-generate.js';
import { skipInstance, resolveTemplateId, deleteFutureOpenInstances } from '../engine/recurrence-ops.js';
import { syncTaskReminders } from '../engine/reminders.js';
import { syncBlockFromTask, clearTaskPlacement, revertTaskPlacementStatus, mirrorTaskStatusToBlocks, applyTaskPlacementStatus } from './block-task-sync.js';
import { ensureTaskPromoted, unpromoteIfEmpty, dropSourceObjective, recomputeObjectivesForTask } from './task-promotion.js';
import { ensureHabitPattern } from './patterns.js';
import { entityTagLevels, syncLeveledEntityTags } from './tags.js';
import { utcDayBounds, localDateInTZ } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';

/**
 * Task CRUD orchestration (Phase W step 3.1) — extracted from routes/tasks.ts so
 * REST + GraphQL share ONE implementation (no duplicated business logic; Decision 3).
 * Mirrors the services/tags.ts extraction: discriminated results, `writeAudit`
 * inside the service, SSE broadcasts + replan requests left to the caller (each
 * `ok` result carries the row / generated counts / synced block id the route needs
 * to emit the exact same events as before).
 *
 * All mutators are OWNER-SCOPED (W3.1a hardening — docs/W-step3-extraction-audit.md
 * §"Owner-scoping finding"): `updateTask` / `deleteTask` / `promoteToHabit` resolve +
 * mutate by (id, owner_id), and `skipRecurringInstance` gates on ownership before the
 * engine skip. A cross-owner id therefore returns `not_found` (REST still 404s,
 * unchanged for the legit owner) — closing the pre-extraction IDOR that keyed by id
 * alone (the routes on main did too; dormant while single-owner, live since Phase T).
 * `recallTask` already guarded by (id, owner_id). `ownerId` is otherwise used exactly
 * where the routes used `currentOwnerId()` (tag resolution, reminders, promotion,
 * audit). Engine calls (parseRule, generateRecurrences, setDependencies, …) stay
 * engine-side.
 *
 * The insert/update statements keep their drizzle form (identical SQL + camelCase
 * row shape for `taskToApi`), so the writers are async; better-sqlite3 executes
 * them synchronously underneath.
 */

/** A full drizzle `tasks` row (camelCase) — the shape `taskToApi` serializes. */
export type TaskRow = typeof tasks.$inferSelect;

/**
 * Resolve a client-supplied `parent_id` within the caller's own namespace (W3.1b).
 * Returns the id only when it names one of `ownerId`'s tasks; a foreign or unknown
 * id is dropped to `null` (no dangling cross-tenant parent ref, no existence leak).
 * `undefined`/`null` in → `null` out (top-level task).
 */
function ownedTaskId(ownerId: string, id: string | null | undefined): string | null {
  if (!id) return null;
  const row = sqlite.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, ownerId);
  return row ? id : null;
}

export type Subtype = 'standard' | 'habit' | 'quick';

/**
 * Resolve the canonical `subtype` from a PATCH/POST body. Accepts the legacy
 * `is_habit` field for backward compat (clients can still send it; the column
 * was dropped in 0048). Returns null when neither field was supplied.
 */
function subtypeWrite(body: { subtype?: Subtype; is_habit?: boolean }): { subtype: Subtype } | null {
  const subtype: Subtype | undefined =
    body.subtype !== undefined ? body.subtype : body.is_habit !== undefined ? (body.is_habit ? 'habit' : 'standard') : undefined;
  if (subtype === undefined) return null;
  return { subtype };
}

/**
 * Sync a task's leveled tags (Phase 5): primary tags (the home/work/community
 * direction + any intention tags) at level 1, secondary tags at level 2. A field
 * left `undefined` (a partial PATCH) preserves that level's existing tags. Names
 * are resolve-or-created + normalized by syncLeveledEntityTags. Mirrors
 * applyBlockTagLevels in routes/blocks.ts so tasks + blocks behave identically.
 */
export function applyTaskTagLevels(ownerId: string, taskId: string, opts: { tags?: string[]; secondary?: string[] }): void {
  const existing = entityTagLevels('task', taskId);
  const top = opts.tags !== undefined ? opts.tags : existing.filter((t) => t.level === 1).map((t) => t.name);
  const secondary = opts.secondary !== undefined ? opts.secondary : existing.filter((t) => t.level > 1).map((t) => t.name);
  syncLeveledEntityTags('task', taskId, [
    { level: 1, names: top },
    { level: 2, names: secondary },
  ], ownerId);
}

/** A task's secondary (level>1) tag names — the read surface (mirrors blocks). */
export function taskSecondaryTags(taskId: string): string[] {
  return entityTagLevels('task', taskId).filter((t) => t.level > 1).map((t) => t.name);
}

/**
 * Phase O · O0 — two-way completion: when a task a today-intention links to is
 * completed, auto-stamp that day's reflection done_at so S1 (the Intention star)
 * lights up without a second click. The same task can be the focus on more than
 * one day, so scope to the reflection whose period_key matches the completion day
 * — derived in the OWNER'S timezone to match how period_key is written (local
 * YYYY-MM-DD), not a UTC slice. COALESCE preserves an already-set done_at.
 */
export function stampTaskCompletionReflection(ownerId: string, taskId: string, completedAt: string): void {
  const now = new Date().toISOString();
  const periodKey = localDateInTZ(completedAt, ownerTimezone(ownerId));
  sqlite
    .prepare(
      `UPDATE reflections SET done_at = COALESCE(done_at, ?), updated_at = ?
         WHERE owner_id = ? AND kind = 'today_goal' AND period_key = ? AND position = 0
           AND source_kind = 'task' AND source_ref = ?`,
    )
    .run(now, now, ownerId, periodKey, taskId);
}

/** The POST /api/tasks body shape (snake_case API convention), both create paths. */
export type CreateTaskInput = {
  title?: string;
  description?: string;
  notes?: string;
  due_at?: string;
  scheduled_for?: string;
  defer_until?: string;
  task_time?: string;
  estimated_minutes?: number;
  priority?: number;
  // NOTE: no `owner_id` — the owner is ALWAYS the authenticated caller (W3.1b). A
  // client body `owner_id` is ignored (was a cross-tenant task-injection IDOR).
  parent_id?: string;
  tags?: string[];
  secondary_tags?: string[];
  depends_on?: string[];
  // AB1: route-level opt-in — POST /api/tasks runs placeStartAnchoredTask after create
  // when true AND scheduled_for is set. Ignored by the service itself (default false;
  // the wizard client creates its own block explicitly, so no unconditional hook).
  auto_place?: boolean;
  recurrence_rule?: string;
  recurrence_dtstart?: string;
  is_habit?: boolean;
  subtype?: Subtype;
};

export type CreateTaskResult =
  | { ok: true; task: TaskRow }
  | { ok: false; error: 'title_required' }
  | { ok: false; error: 'dependency_cycle'; detail: string };

/**
 * Create a one-off task: insert + tag-level sync + dependency edges + auto
 * reminders + parent promotion. Identical to the old POST /api/tasks non-recurring
 * path — including the cycle semantics: a `depends_on` cycle rejects the dependency
 * change AFTER the task row (and its tags) were written, and skips reminders /
 * promotion / audit, exactly as the route always did.
 */
export async function createTask(ownerId: string, input: CreateTaskInput): Promise<CreateTaskResult> {
  if (!input.title?.trim()) return { ok: false, error: 'title_required' };

  // CON-2c: resolve subtype ⇄ is_habit/is_fast_task once.
  const sw = subtypeWrite(input);

  // W3.1b: a parent_id must be one of the caller's own tasks — a foreign parent_id
  // is dropped (would otherwise be a dangling cross-tenant ref). null = top-level.
  const parentId = ownedTaskId(ownerId, input.parent_id);

  const [task] = await db
    .insert(tasks)
    .values({
      title: input.title.trim(),
      description: input.description,
      notes: input.notes,
      dueAt: input.due_at,
      scheduledFor: input.scheduled_for,
      deferUntil: input.defer_until,
      taskTime: input.task_time,
      estimatedMinutes: input.estimated_minutes,
      priority: input.priority ?? 3,
      parentId: parentId,
      ownerId, // W3.1b: always the authenticated caller — never a client body owner_id.
      ...(sw ?? {}),
    })
    .returning();

  if (input.tags !== undefined || input.secondary_tags !== undefined)
    applyTaskTagLevels(ownerId, task.id, { tags: input.tags, secondary: input.secondary_tags });
  if (Array.isArray(input.depends_on)) {
    try {
      // W3.1b: scope blockers to the caller's own tasks — a cross-owner id is dropped.
      setDependencies(task.id, input.depends_on, ownerId);
    } catch (err) {
      if (err instanceof DependencyCycleError) return { ok: false, error: 'dependency_cycle', detail: err.message };
      throw err;
    }
  }
  syncTaskReminders(ownerId, task.id); // Phase H (b): derive reminders from due_at + Reminder Defaults
  // §H: creating a subtask promotes its parent to an objective (task list star).
  if (parentId) ensureTaskPromoted(parentId, ownerId);

  writeAudit({ ownerId, actor: 'owner', action: 'create', entity: `task:${task.id}` });
  return { ok: true, task };
}

export type CreateRecurringTaskResult =
  | { ok: true; template: TaskRow; generated: GenerateResult }
  | { ok: false; error: 'title_required' }
  | { ok: false; error: 'invalid_rule'; message: string };

/**
 * Create a recurring task: a TEMPLATE row (status 'recurring', never scheduled
 * directly) with a validated rule, then materialize its instances now so the
 * series appears immediately. A habit template also gets its Habit-type Pattern
 * (G2/E′). Identical to the old POST /api/tasks recurrence path.
 */
export async function createRecurringTask(ownerId: string, input: CreateTaskInput): Promise<CreateRecurringTaskResult> {
  if (!input.title?.trim()) return { ok: false, error: 'title_required' };

  const parsed = parseRule(input.recurrence_rule ?? '');
  if (!parsed.ok) return { ok: false, error: 'invalid_rule', message: parsed.error };

  const sw = subtypeWrite(input);
  const owner = ownerId; // W3.1b: always the authenticated caller — never a client body owner_id.
  const tz = ownerTimezone(owner);
  const [template] = await db
    .insert(tasks)
    .values({
      title: input.title.trim(),
      notes: input.notes,
      taskTime: input.task_time,
      estimatedMinutes: input.estimated_minutes,
      priority: input.priority ?? 3,
      status: 'recurring',
      recurrenceRule: parsed.rule,
      recurrenceDtstart: input.recurrence_dtstart ?? utcDayBounds(localISODate(), tz).start,
      ownerId: owner,
      ...(sw ?? {}),
    })
    .returning();
  if (input.tags !== undefined || input.secondary_tags !== undefined)
    applyTaskTagLevels(ownerId, template.id, { tags: input.tags, secondary: input.secondary_tags });
  // Bridge: a habit task is also represented as a Habit-type Pattern (G2/E′).
  if (sw?.subtype === 'habit') ensureHabitPattern(template.id, owner, template.title);
  const generated = generateRecurrences();

  writeAudit({ ownerId, actor: 'owner', action: 'create', entity: `task:${template.id}` });
  return { ok: true, template, generated };
}

/** The PATCH /api/tasks/:id body shape — accepts both snake_case (client/API
 *  convention) and camelCase (drizzle) field names. */
export type UpdateTaskInput = {
  title?: string;
  description?: string | null;
  notes?: string | null;
  due_at?: string | null;
  dueAt?: string | null;
  scheduled_for?: string | null;
  defer_until?: string | null;
  task_time?: string | null;
  estimated_minutes?: number | null;
  estimatedMinutes?: number | null;
  priority?: number;
  status?: string;
  completed?: boolean;
  completed_at?: string | null;
  parent_id?: string | null;
  tags?: string[];
  secondary_tags?: string[];
  depends_on?: string[];
  recurrence_rule?: string | null;
  recurrence_dtstart?: string | null;
  is_habit?: boolean;
  subtype?: Subtype;
};

/** scope=series edits the whole recurring series (the template); scope=instance
 *  (default) edits just this row. For a non-recurring task the two coincide. */
export type UpdateTaskScope = 'instance' | 'series';

/**
 * The camelCase column names whose change can shift the day's plan — the ONLY edits
 * that should trigger a reactive reflow (B2). A title/notes/description/parent/tag
 * edit leaves placement untouched, so firing requestReplan for it needlessly churns
 * the day (and, pre-AE, could surface a wipe). Callers pass `updateTask`'s
 * `updatedFields`; tags/deps aren't columns so they never appear there (correct —
 * neither re-packs the day). Shared by REST + GraphQL so both gate identically.
 */
const SCHEDULING_FIELDS = new Set([
  'scheduledFor', 'taskTime', 'estimatedMinutes', 'priority', 'dueAt', 'status', 'completedAt', 'deferUntil',
]);
export function updateTouchesSchedule(updatedFields: readonly string[]): boolean {
  return updatedFields.some((f) => SCHEDULING_FIELDS.has(f));
}

export type UpdateTaskResult =
  | {
      ok: true;
      task: TaskRow;
      /** The row actually edited (the template under scope=series). */
      targetId: string;
      /** camelCase column names written — the caller's Phase-L stampRow input (stamping
       *  stays route-side for W3.1; it moves in here at W3.3). */
      updatedFields: string[];
      /** Block moved by the reverse task→block sync (REQ2), for the caller's block:updated. */
      syncedBlockId: string | null;
      /** True when clearing `scheduled_for` removed the task's placement block(s) — the
       *  caller broadcasts block:updated so the Planner drops the now-unscheduled task. */
      unscheduled: boolean;
      /** Blocks whose status was flipped by the task→block done-state mirror
       *  (completed on task done; back to planned on reopen) — the caller broadcasts
       *  block:updated for each so the Planner refreshes. */
      mirroredBlockIds: string[];
      /** Present when a series edit re-materialized instances (recurrence:generated). */
      generated?: GenerateResult;
    }
  | { ok: false; error: 'invalid_rule'; message: string }
  | { ok: false; error: 'not_found' }
  // The column UPDATE (and tag sync) already applied when the dependency change is
  // rejected — targetId/updatedFields let the caller stamp exactly as before.
  | { ok: false; error: 'dependency_cycle'; detail: string; targetId: string; updatedFields: string[] };

/**
 * Update a task (or its whole series). Carries the full PATCH pipeline extracted
 * from the route: alias merge → rule validation → column UPDATE → tag re-sync
 * (partial PATCH preserves unset levels) → dependencies → reminders → parent
 * promotion/GC → reverse block sync (instance scope) → series re-materialization
 * → Phase-O completion-reflection stamp.
 */
export async function updateTask(
  ownerId: string,
  id: string,
  input: UpdateTaskInput,
  scope: UpdateTaskScope = 'instance',
): Promise<UpdateTaskResult> {
  const targetId = scope === 'series' ? (resolveTemplateId(id) ?? id) : id;

  // Capture the pre-edit parent so a re-parent can GC the OLD parent's auto-objective
  // if this was its last subtask.
  const prevParentId = input.parent_id !== undefined
    ? (sqlite.prepare(`SELECT parent_id FROM tasks WHERE id = ? AND owner_id = ?`).get(targetId, ownerId) as { parent_id: string | null } | undefined)?.parent_id ?? null
    : null;

  const update: Partial<typeof tasks.$inferInsert> = {};
  if (input.title !== undefined)             update.title = input.title;
  if (input.description !== undefined)       update.description = input.description;
  if (input.notes !== undefined)             update.notes = input.notes;
  if (input.due_at !== undefined)            update.dueAt = input.due_at;
  if (input.dueAt !== undefined)             update.dueAt = input.dueAt;
  if (input.scheduled_for !== undefined)     update.scheduledFor = input.scheduled_for;
  if (input.defer_until !== undefined)       update.deferUntil = input.defer_until;
  if (input.task_time !== undefined)         update.taskTime = input.task_time;
  if (input.estimated_minutes !== undefined) update.estimatedMinutes = input.estimated_minutes;
  if (input.estimatedMinutes !== undefined)  update.estimatedMinutes = input.estimatedMinutes;
  if (input.priority !== undefined)          update.priority = input.priority;
  if (input.status !== undefined)            update.status = input.status;
  if (input.completed_at !== undefined)      update.completedAt = input.completed_at;
  // W3.1b: re-parenting must target a caller-owned task; a foreign parent_id is
  // dropped to null (an explicit null un-parents). `parentIdSet` remembers a
  // parent_id was in the PATCH; `newParentId` is the validated value written.
  const parentIdSet = input.parent_id !== undefined;
  const newParentId = parentIdSet ? ownedTaskId(ownerId, input.parent_id) : null;
  if (parentIdSet)                           update.parentId = newParentId;
  const sw = subtypeWrite(input);
  if (sw) update.subtype = sw.subtype;
  if (input.recurrence_dtstart !== undefined) update.recurrenceDtstart = input.recurrence_dtstart;
  if (input.completed)                       { update.status = 'done'; update.completedAt = new Date().toISOString(); }
  // `completed: false` reopens the task (refined against wasDone below — it only
  // applies to a currently-done task). An explicit `status` in the same PATCH wins.
  if (input.completed === false && input.status === undefined) { update.status = 'open'; update.completedAt = null; }

  // A recurrence-rule change is validated; an invalid rule is a 422, never a 500.
  if (input.recurrence_rule !== undefined) {
    if (input.recurrence_rule === null) {
      update.recurrenceRule = null;
    } else {
      const parsed = parseRule(input.recurrence_rule);
      if (!parsed.ok) return { ok: false, error: 'invalid_rule', message: parsed.error };
      update.recurrenceRule = parsed.rule;
    }
  }

  // Capture pre-edit done-state so a completion flip (done⇄not-done) can refresh the
  // progress_cache of every objective this task rolls up into. recomputeProgress keys
  // on t.status === 'done', and updateTask is the ONLY mutator that flips it — yet,
  // unlike delete/link/unlink, it never recomputed. Query only when the write can
  // change status; undefined means "no status change, so no transition to react to".
  const wasDone = update.status !== undefined
    ? ((sqlite.prepare(`SELECT status FROM tasks WHERE id = ? AND owner_id = ?`).get(targetId, ownerId) as { status: string } | undefined)?.status === 'done')
    : undefined;

  // Refine the `completed` shortcut against the pre-edit state:
  //  - re-completing an already-done task must not clobber its original completed_at;
  //  - `completed: false` on a task that isn't done is a no-op (never forces a
  //    scheduled/in_progress task back to 'open').
  if (input.completed === true && wasDone) delete update.completedAt;
  if (input.completed === false && input.status === undefined && !wasDone) {
    delete update.status;
    delete update.completedAt;
  }

  // Only issue an UPDATE when there are column changes; a tags/depends-only
  // PATCH still resolves the task (drizzle rejects an empty .set()). Both branches
  // are owner-scoped (W3.1a): a cross-owner id matches no row → not_found (404),
  // and no column/tag/dependency mutation runs (all of it is gated below the guard).
  const updatedFields = Object.keys(update);
  const [task] = updatedFields.length
    ? await db.update(tasks).set(update).where(and(eq(tasks.id, targetId), eq(tasks.ownerId, ownerId))).returning()
    : await db.select().from(tasks).where(and(eq(tasks.id, targetId), eq(tasks.ownerId, ownerId)));
  if (!task) return { ok: false, error: 'not_found' };

  if (Array.isArray(input.tags) || Array.isArray(input.secondary_tags)) {
    // Partial: an omitted level is preserved (mirrors the block PATCH semantics).
    applyTaskTagLevels(ownerId, targetId, { tags: input.tags, secondary: input.secondary_tags });
  }

  if (Array.isArray(input.depends_on)) {
    try {
      // W3.1b: scope blockers to the caller's own tasks — a cross-owner id is dropped.
      setDependencies(targetId, input.depends_on, ownerId);
    } catch (err) {
      if (err instanceof DependencyCycleError) {
        // Phase L: the column UPDATE already applied before the dependency change was
        // rejected, so stamp version/field_ts here (moved in from routes/tasks.ts at
        // W3.3b) exactly as the route did on this 409 path — same target, same fields,
        // same guard — so REST stays byte-equivalent and a GraphQL update stamps too.
        if (updatedFields.length > 0) stampRow(sqlite, 'task', targetId, updatedFields);
        return { ok: false, error: 'dependency_cycle', detail: err.message, targetId, updatedFields };
      }
      throw err;
    }
  }
  syncTaskReminders(ownerId, targetId); // Phase H (b): re-derive if due_at changed
  // §H: re-parenting a task UNDER another promotes that parent to an objective; moving
  // it AWAY may leave the old parent empty → GC that parent's pristine auto-objective.
  if (newParentId) ensureTaskPromoted(newParentId, ownerId);
  if (parentIdSet && prevParentId && prevParentId !== newParentId) {
    unpromoteIfEmpty(prevParentId, ownerId);
  }

  // REQ2 (reverse sync): editing a task's time/day/estimate moves its placed block in
  // lockstep. Instance scope only — a series edit re-materializes instances below.
  const estimateChanged = input.estimated_minutes !== undefined || input.estimatedMinutes !== undefined;
  // Clearing the start intent (scheduled_for → null/empty) UNSCHEDULES the task: its
  // placement block(s) are removed so it leaves the Planner and returns to the backlog.
  const clearingStart = input.scheduled_for !== undefined && !input.scheduled_for;
  let syncedBlockId: string | null = null;
  let unscheduled = false;
  if (scope === 'instance' && clearingStart) {
    unscheduled = clearTaskPlacement(targetId, ownerId) > 0;
    // Removing the last active placement must not strand the task at status='scheduled'
    // with no block — return it to the open backlog (no-op if a locked block remains).
    if (revertTaskPlacementStatus(targetId, ownerId)) task.status = 'open';
  } else if (
    scope === 'instance' &&
    (input.scheduled_for !== undefined || input.task_time !== undefined || estimateChanged)
  ) {
    syncedBlockId = syncBlockFromTask(targetId, ownerId, { resizeToEstimate: estimateChanged });
  }

  // A series edit that changes the recurrence pattern or per-instance time drops
  // future un-actioned instances and re-materializes them under the new rule;
  // past / completed / skipped / missed instances are preserved.
  let generated: GenerateResult | undefined;
  if (
    scope === 'series' &&
    resolveTemplateId(targetId) != null &&
    (input.recurrence_rule !== undefined || input.recurrence_dtstart !== undefined || input.task_time !== undefined)
  ) {
    deleteFutureOpenInstances(targetId);
    generated = generateRecurrences();
  }

  // Phase O · O0 — completing a task lights up the today-intention linked to it.
  if (task.status === 'done') {
    const completedAt = typeof input.completed_at === 'string' && input.completed_at ? input.completed_at : new Date().toISOString();
    stampTaskCompletionReflection(ownerId, targetId, completedAt);
  }

  // AF-5: a done⇄not-done flip changes how much of every linked objective is complete,
  // so refresh their progress_cache rollup here too (mirrors deleteTask, which already
  // recomputes on cancel). Guarded on an actual transition — a non-status edit, or a
  // status change that doesn't cross the done boundary, leaves the rollup untouched.
  let mirroredBlockIds: string[] = [];
  if (wasDone !== undefined && wasDone !== (task.status === 'done')) {
    recomputeObjectivesForTask(targetId);
    // Task→block done-state mirror (the inverse of mirrorBlockStatusToTask): checking
    // a task off completes its Planner block(s); reopening it revives them. Instance
    // scope only, and only toward a LIVE reopen status — a done→cancelled flip must
    // not resurrect planned blocks.
    if (scope === 'instance' && (task.status === 'done' || ['open', 'scheduled', 'in_progress'].includes(task.status ?? ''))) {
      mirroredBlockIds = mirrorTaskStatusToBlocks(targetId, ownerId);
      // Reviving a placement re-schedules an open task (same parity rule every other
      // placement path follows).
      if (task.status === 'open' && mirroredBlockIds.length > 0 && applyTaskPlacementStatus(targetId, ownerId)) {
        task.status = 'scheduled';
      }
    }
  }

  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `task:${targetId}` });
  // Phase L: stamp version/field_ts so concurrent sync ops from other devices compare
  // correctly against this online edit using field-level LWW. Moved in from
  // routes/tasks.ts at W3.3b (was route-side for W3.1) so REST and the coming GraphQL
  // updateTask mutation both version their column writes — same target, same fields,
  // same guard (`updatedFields.length > 0`) the route used, so REST stays byte-equivalent
  // (the route stamped after the service returned; audit already fired inside the service).
  if (updatedFields.length > 0) stampRow(sqlite, 'task', targetId, updatedFields);

  return { ok: true, task, targetId, updatedFields, syncedBlockId, unscheduled, mirroredBlockIds, generated };
}

export type DeleteTaskResult = { ok: true; task: TaskRow } | { ok: false; error: 'not_found' };

/**
 * Soft-delete a task (status → 'cancelled'): drops its auto reminders and runs the
 * objectives upkeep — drop the objective this task spawned (if pristine); if it was
 * a subtask, GC its parent's objective when now empty; and recompute any objective
 * still linking it so progress doesn't count the abandoned task.
 */
export async function deleteTask(ownerId: string, id: string): Promise<DeleteTaskResult> {
  const [task] = await db
    .update(tasks)
    .set({ status: 'cancelled' })
    .where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId))) // W3.1a: owner-scoped
    .returning();
  if (!task) return { ok: false, error: 'not_found' };
  syncTaskReminders(ownerId, id); // Phase H (b): a cancelled task drops its auto reminders
  dropSourceObjective(id, ownerId);
  if (task.parentId) unpromoteIfEmpty(task.parentId, ownerId);
  recomputeObjectivesForTask(id);
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `task:${id}` });
  return { ok: true, task };
}

export type PromoteToHabitResult = { ok: true; task: TaskRow } | { ok: false; error: 'not_found' };

/**
 * Make a (possibly fast/ritual-local) task a habit: flag it, drop fast-task
 * hiding, and ensure its Habit-type pattern (G2).
 */
export async function promoteToHabit(ownerId: string, id: string): Promise<PromoteToHabitResult> {
  const [task] = await db
    .update(tasks)
    .set({ subtype: 'habit' })
    .where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId))) // W3.1a: owner-scoped
    .returning();
  if (!task) return { ok: false, error: 'not_found' };
  ensureHabitPattern(id, task.ownerId ?? ownerId, task.title);
  writeAudit({ ownerId, actor: 'owner', action: 'promote', entity: `task:${id}` });
  return { ok: true, task };
}

export type RecallTaskResult = { ok: true; task: TaskRow } | { ok: false; error: 'not_found' };

/**
 * Clone a (usually shelved/Past) task to a brand-new task (new id): carries
 * title/tags/estimate/notes/subtype + subtasks (recursively, reset to open);
 * Routine membership only when prefs.recall_keeps_pattern. Fresh dates/status;
 * no recurrence or history. cockpit-v2 Phase 6.
 */
export async function recallTask(ownerId: string, taskId: string): Promise<RecallTaskResult> {
  if (!sqlite.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(taskId, ownerId)) {
    return { ok: false, error: 'not_found' };
  }
  const keepPattern = !!(sqlite.prepare('SELECT recall_keeps_pattern AS v FROM scheduling_prefs WHERE owner_id = ?').get(ownerId) as { v: number } | undefined)?.v;

  // Recursively clone a task + its subtree (better-sqlite3 is synchronous). The top
  // clone is a fresh independent task (parent_id null); uuid7() mints each new id.
  const cloneTree = (srcId: string, parentId: string | null): string => {
    const s = sqlite.prepare(
      'SELECT title, description, notes, estimated_minutes, priority, task_time, subtype, source_kind FROM tasks WHERE id = ?'
    ).get(srcId) as {
      title: string; description: string | null; notes: string | null;
      estimated_minutes: number | null; priority: number | null; task_time: string | null;
      subtype: string | null; source_kind: string | null;
    };
    const st = s.subtype ?? 'standard';
    const newId = (sqlite.prepare(
      `INSERT INTO tasks (id, title, description, notes, estimated_minutes, priority, task_time, subtype, parent_id, owner_id, status, source_kind)
       VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?) RETURNING id`
    ).get(s.title, s.description, s.notes, s.estimated_minutes, s.priority ?? 3, s.task_time, st, parentId, ownerId, s.source_kind ?? 'manual') as { id: string }).id;
    // Carry tags (entity_tags, all levels); Routine membership only when the pref is on.
    sqlite.prepare("INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) SELECT 'task', ?, tag_id, level FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ?").run(newId, srcId);
    if (keepPattern) {
      sqlite.prepare('INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) SELECT pattern_id, ?, position FROM pattern_tasks WHERE task_id = ?').run(newId, srcId);
    }
    for (const k of sqlite.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(srcId) as { id: string }[]) {
      cloneTree(k.id, newId);
    }
    return newId;
  };

  // Atomic: a partway failure must not leave a half-built clone subtree.
  const newId = sqlite.transaction(() => cloneTree(taskId, null))();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, newId));
  writeAudit({ ownerId, actor: 'owner', action: 'recall', entity: `task:${newId}` });
  return { ok: true, task };
}

export type SkipInstanceResult =
  | { ok: true; task: TaskRow; skipped: string }
  | { ok: false; error: 'not_found' | 'not_instance' };

/**
 * Skip a recurring instance: mark it `skipped` and add its day to the template's
 * EXDATE so a regenerate won't resurrect it (engine skipInstance does both).
 */
export async function skipRecurringInstance(ownerId: string, id: string): Promise<SkipInstanceResult> {
  // W3.1a: the engine `skipInstance` resolves the task by id alone, so gate on
  // ownership here (mirrors recallTask) before it can mark another owner's instance
  // skipped / write an EXDATE onto their template. A cross-owner id → not_found (404),
  // exactly what a non-existent id already returned — the legit-owner path is unchanged.
  if (!sqlite.prepare('SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?').get(id, ownerId)) {
    return { ok: false, error: 'not_found' };
  }
  const res = skipInstance(id);
  if (!res.ok) return { ok: false, error: res.reason };
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  writeAudit({ ownerId, actor: 'owner', action: 'skip', entity: `task:${id}` });
  return { ok: true, task, skipped: res.date };
}

/**
 * Owner-scoped READ surface (Phase W · W3.3b) for the GraphQL TaskType resolvers.
 * None of these existed before — REST attached tags/deps ad hoc in the route. Per
 * Decision 3 the resolvers read through the service, never inline against the DB,
 * and every read filters by `owner_id` so a cross-owner id is invisible (getTask →
 * undefined → resolver null; it never appears in a listing or a subtree).
 *
 * The connections keyset-paginate on `id` (UUIDv7 is time-ordered, so id order is a
 * stable, meaningful "creation" order) and fetch `limit + 1` rows so the resolver can
 * report hasNextPage, mirroring the tag connection helpers in pagination.ts.
 */

/** A single owned task (camelCase drizzle row for the field resolvers). undefined =
 *  not found OR not this owner's — the caller can't tell the two apart (no existence
 *  leak). Uses drizzle so the row shape is camelCase, matching listTasks/listSubtasks. */
export async function getTask(ownerId: string, id: string): Promise<TaskRow | undefined> {
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)));
  return task;
}

/** One keyset page of the owner's tasks, optionally status-filtered, ordered by id.
 *  Fetch `limit + 1` to detect a next page. `after` is the last id of the prior page. */
export async function listTasks(
  ownerId: string,
  opts: { status?: string; after?: string; limit: number },
): Promise<TaskRow[]> {
  const conds = [eq(tasks.ownerId, ownerId)];
  if (opts.status) conds.push(eq(tasks.status, opts.status));
  if (opts.after) conds.push(gt(tasks.id, opts.after));
  return db.select().from(tasks).where(and(...conds)).orderBy(asc(tasks.id)).limit(opts.limit);
}

/** Total count for the `tasks` connection (same owner/status filter, no keyset). */
export function countTasks(ownerId: string, status?: string): number {
  const row = status
    ? sqlite.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status = ?').get(ownerId, status)
    : sqlite.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?').get(ownerId);
  return (row as { n: number }).n;
}

/** One keyset page of a task's subtasks (owner-scoped: subtasks share the parent's
 *  owner, and the parent-id filter is ANDed with owner_id so a foreign parent yields
 *  nothing). Ordered by id. */
export async function listSubtasks(
  ownerId: string,
  parentId: string,
  opts: { after?: string; limit: number },
): Promise<TaskRow[]> {
  const conds = [eq(tasks.parentId, parentId), eq(tasks.ownerId, ownerId)];
  if (opts.after) conds.push(gt(tasks.id, opts.after));
  return db.select().from(tasks).where(and(...conds)).orderBy(asc(tasks.id)).limit(opts.limit);
}

/** Subtask count for the `subtasks` connection totalCount. */
export function countSubtasks(ownerId: string, parentId: string): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND owner_id = ?')
    .get(parentId, ownerId);
  return (row as { n: number }).n;
}

/** A task's blocker rows (task_dependencies.depends_on_id → task), owner-scoped: the
 *  join to tasks is filtered by owner_id so a blocker owned by someone else (there
 *  shouldn't be one — setDependencies scopes writes — but defence in depth) never leaks.
 *  Ordered by id for determinism. */
export async function dependsOn(ownerId: string, id: string): Promise<TaskRow[]> {
  return db
    .select({ t: tasks })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(and(eq(taskDependencies.taskId, id), eq(tasks.ownerId, ownerId)))
    .orderBy(asc(tasks.id))
    .then((rows) => rows.map((r) => r.t));
}
