import { sqlite } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { removeEntityTags, routineDerivedTags, type DerivedRoutineTags } from './tags.js';
import { validatePatternRule } from '../engine/patterns-place.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';

/**
 * Patterns (Phase G, ticket G1) — typed, reusable task collections (Routine ▢ / Habit ◯
 * / Ritual △ + user-defined kinds). Tasks-only, many-to-many membership; no own
 * recurrence per member. Owner-scoped throughout.
 *
 * Phase W · W6 (Decision 3): the pattern-type + pattern CRUD is extracted here so REST +
 * GraphQL share ONE owner-scoped implementation — `patterns.test.ts` (and
 * patterns-promote / pattern-recurrence) is the byte-equivalence lock. `writeAudit` fires
 * INSIDE these functions (the tags-service precedent); SSE `broadcast` stays transport-side
 * (route + resolver each fire it). The engine-ish handlers (fast-tasks, promote-from-*,
 * place-today) remain in routes/patterns.ts and reuse the exported helpers below.
 *
 * better-sqlite3 is synchronous; these are plain sync functions.
 */

// ── Row + serialized shapes (the exact REST payloads) ─────────────────────────
export interface TypeRow {
  id: string;
  owner_id: string;
  name: string;
  icon_shape: string;
  reminder_config: string | null;
  is_builtin: number;
  color_token: string | null;
  texture: string | null;
  default_est_minutes: number | null;
  notify: number;
}
export interface PatternRow {
  id: string;
  owner_id: string;
  type_id: string | null;
  name: string;
  tag: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  recurrence_dtstart: string | null;
  created_at: string;
}

export function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const serializeType = (t: TypeRow) => ({
  id: t.id,
  owner_id: t.owner_id,
  name: t.name,
  icon_shape: t.icon_shape,
  reminder_config: parseJson(t.reminder_config),
  is_builtin: !!t.is_builtin,
  color_token: t.color_token,
  texture: t.texture,
  default_est_minutes: t.default_est_minutes,
  notify: !!t.notify,
});

/** Member task ids for a pattern, in (position, task_id) order. */
export function taskIdsOf(patternId: string): string[] {
  return (
    sqlite
      .prepare(`SELECT task_id FROM pattern_tasks WHERE pattern_id = ? ORDER BY position, task_id`)
      .all(patternId) as { task_id: string }[]
  ).map((r) => r.task_id);
}

/**
 * AF-11 (D2): a routine's tags are DERIVED — the union of its member tasks' tags,
 * kind-classified into `directions` (multiple legal) + `intentions`. `tag` (the old
 * authored column) is kept in the payload for API-shape compat but is always null
 * after migration 0120. List callers pass the batched `derived` map entry (one query
 * for the whole list — see routineDerivedTagsByIds); single-row callers omit it.
 */
export const serializePattern = (p: PatternRow, derived?: DerivedRoutineTags) => {
  const d = derived ?? routineDerivedTags(p.id);
  return {
    id: p.id,
    owner_id: p.owner_id,
    type_id: p.type_id,
    name: p.name,
    tag: p.tag,
    directions: d.directions,
    intentions: d.intentions,
    notes: p.notes,
    recurrence_rule: p.recurrence_rule,
    recurrence_dtstart: p.recurrence_dtstart,
    created_at: p.created_at,
    task_ids: taskIdsOf(p.id),
  };
};

/** Replace a pattern's membership set with `taskIds` (in order). FK guards existence. */
export function setMembers(patternId: string, taskIds: string[]) {
  sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ?`).run(patternId);
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`);
  taskIds.forEach((taskId, i) => ins.run(patternId, taskId, i));
}

/** The name of one of the OWNER's pattern types by id (used for the Ritual-recurrence
 *  guard). Owner-scoped so a stray cross-owner type_id can't drive recurrence validation
 *  off another owner's kind name. */
function typeNameOf(owner: string, typeId: string | null): string | null {
  if (typeId == null) return null;
  const row = sqlite.prepare(`SELECT name FROM pattern_types WHERE id = ? AND owner_id = ?`).get(typeId, owner) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Validate + normalize a recurrence body on a pattern. Only Habit + Routine types may
 * carry a rule (Rituals are hidden in V1). If the caller omits `recurrence_dtstart`,
 * defaults to local-noon-as-UTC (mirrors the task-level convention in
 * engine/recurrence.ts — keeps every hit a safe ~12h from the local midnight boundary so
 * a DST flip never moves a hit's local date).
 */
function buildRecurrenceFields(
  owner: string,
  typeId: string | null,
  rule: string | null | undefined,
  dtstart: string | null | undefined,
): { ok: true; rule: string | null; dtstart: string | null } | { ok: false; error: string } {
  if (rule === undefined && dtstart === undefined) return { ok: true, rule: undefined as unknown as null, dtstart: undefined as unknown as null };
  if (rule == null) return { ok: true, rule: null, dtstart: null }; // explicit clear
  const typeName = typeNameOf(owner, typeId);
  if (typeName !== 'Habit' && typeName !== 'Routine') {
    return { ok: false, error: 'only Habit and Routine patterns can recur' };
  }
  const v = validatePatternRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  if (dtstart) return { ok: true, rule: v.rule, dtstart };
  const tz = (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { timezone: string | null } | undefined)?.timezone || serverTimezone();
  return { ok: true, rule: v.rule, dtstart: zonedWallTimeToUTC(localISODate(), '12:00', tz) };
}

// ── Pattern types (PatternKindType) ───────────────────────────────────────────
export interface TypeInput {
  name?: string;
  icon_shape?: string;
  reminder_config?: unknown;
  color_token?: string | null;
  texture?: string | null;
  default_est_minutes?: number | null;
  notify?: boolean;
}

/** The owner's pattern types, built-ins first. Ritual is hidden unless `enable_rituals`
 *  is set (0024) — the row stays in the DB so flipping the flag back on restores it. */
export function listPatternTypeRows(owner: string): TypeRow[] {
  const rows = sqlite.prepare(`SELECT * FROM pattern_types WHERE owner_id = ? ORDER BY is_builtin DESC, id`).all(owner) as TypeRow[];
  const enableRituals = !!(sqlite.prepare(`SELECT enable_rituals FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { enable_rituals: number } | undefined)?.enable_rituals;
  return enableRituals ? rows : rows.filter((r) => r.name !== 'Ritual');
}

/** One of the owner's pattern types (raw row), or undefined (not found / not this owner's). */
export function getPatternTypeRow(owner: string, id: string): TypeRow | undefined {
  return sqlite.prepare(`SELECT * FROM pattern_types WHERE id = ? AND owner_id = ?`).get(id, owner) as TypeRow | undefined;
}

export type CreateTypeResult = { ok: true; row: TypeRow } | { ok: false; error: 'missing_fields' | 'insert_failed'; message?: string };

export function createPatternType(owner: string, input: TypeInput): CreateTypeResult {
  if (!input.name?.trim() || !input.icon_shape?.trim()) return { ok: false, error: 'missing_fields' };
  try {
    const row = sqlite
      .prepare(
        `INSERT INTO pattern_types (id, owner_id, name, icon_shape, reminder_config, is_builtin, color_token, texture, default_est_minutes, notify)
         VALUES (uuid7(), ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        owner,
        input.name.trim(),
        input.icon_shape.trim(),
        input.reminder_config != null ? JSON.stringify(input.reminder_config) : null,
        input.color_token ?? null,
        input.texture ?? null,
        input.default_est_minutes ?? null,
        input.notify ? 1 : 0,
      ) as TypeRow;
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${row.id}` });
    return { ok: true, row };
  } catch (err) {
    return { ok: false, error: 'insert_failed', message: (err as Error).message };
  }
}

export type UpdateTypeResult = { ok: true; row: TypeRow } | { ok: false; error: 'not_found' };

export function updatePatternType(owner: string, id: string, input: TypeInput): UpdateTypeResult {
  const existing = getPatternTypeRow(owner, id);
  if (!existing) return { ok: false, error: 'not_found' };
  const name = input.name?.trim() ?? existing.name;
  const iconShape = input.icon_shape?.trim() ?? existing.icon_shape;
  // Explicit null clears to SQL NULL (consistent with createPatternType), not the string
  // "null" that JSON.stringify(null) would store.
  const reminder = input.reminder_config !== undefined
    ? (input.reminder_config != null ? JSON.stringify(input.reminder_config) : null)
    : existing.reminder_config;
  const colorToken = input.color_token !== undefined ? input.color_token : existing.color_token;
  const texture = input.texture !== undefined ? input.texture : existing.texture;
  const defaultEst = input.default_est_minutes !== undefined ? input.default_est_minutes : existing.default_est_minutes;
  const notify = input.notify !== undefined ? (input.notify ? 1 : 0) : existing.notify;
  const row = sqlite
    .prepare(
      `UPDATE pattern_types SET name = ?, icon_shape = ?, reminder_config = ?, color_token = ?, texture = ?, default_est_minutes = ?, notify = ?
        WHERE id = ? RETURNING *`,
    )
    .get(name, iconShape, reminder, colorToken, texture, defaultEst, notify, id) as TypeRow;
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${id}` });
  return { ok: true, row };
}

export type DeleteTypeResult = { ok: true } | { ok: false; error: 'not_found' | 'builtin' | 'in_use' };

export function deletePatternType(owner: string, id: string): DeleteTypeResult {
  const t = getPatternTypeRow(owner, id);
  if (!t) return { ok: false, error: 'not_found' };
  if (t.is_builtin) return { ok: false, error: 'builtin' };
  // Owner-scoped count: only THIS owner's patterns can block deletion of THIS owner's kind
  // (a cross-owner type_id, were one to exist, must not let another tenant hold it hostage).
  const inUse = sqlite.prepare(`SELECT COUNT(*) AS c FROM patterns WHERE type_id = ? AND owner_id = ?`).get(id, owner) as { c: number };
  if (inUse.c > 0) return { ok: false, error: 'in_use' };
  sqlite.prepare(`DELETE FROM pattern_types WHERE id = ?`).run(id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `routine:${id}` });
  return { ok: true };
}

// ── Patterns (PatternType) ────────────────────────────────────────────────────
export interface CreatePatternInput {
  type_id?: string | null;
  name?: string;
  /** AF-11: accepted for API compat, IGNORED — routines derive tags from members. */
  tag?: string | null;
  notes?: string | null;
  task_ids?: string[];
  recurrence_rule?: string | null;
  recurrence_dtstart?: string | null;
}
export type UpdatePatternInput = CreatePatternInput;

/** The owner's patterns (raw rows), newest first — the REST list order. */
export function listPatternRows(owner: string): PatternRow[] {
  return sqlite.prepare(`SELECT * FROM patterns WHERE owner_id = ? ORDER BY created_at DESC, id DESC`).all(owner) as PatternRow[];
}

/** One of the owner's patterns (raw row), or undefined (not found / not this owner's). */
export function getPatternRow(owner: string, id: string): PatternRow | undefined {
  return sqlite.prepare(`SELECT * FROM patterns WHERE id = ? AND owner_id = ?`).get(id, owner) as PatternRow | undefined;
}

export type CreatePatternResult =
  | { ok: true; row: PatternRow }
  | { ok: false; error: 'name_required' | 'unknown_type' | 'bad_recurrence' | 'bad_membership'; message?: string };

export function createPattern(owner: string, input: CreatePatternInput): CreatePatternResult {
  if (!input.name?.trim()) return { ok: false, error: 'name_required' };
  // Validate the type belongs to this owner.
  if (input.type_id != null) {
    const type = sqlite.prepare(`SELECT id FROM pattern_types WHERE id = ? AND owner_id = ?`).get(input.type_id, owner) as { id: string } | undefined;
    if (!type) return { ok: false, error: 'unknown_type' };
  }
  const rec = buildRecurrenceFields(owner, input.type_id ?? null, input.recurrence_rule, input.recurrence_dtstart);
  if (!rec.ok) return { ok: false, error: 'bad_recurrence', message: rec.error };

  // AF-11 (D2): routines author NO tags — their tags derive from member tasks at read
  // time. An incoming `tag` is accepted for API compat (old clients still send it) but
  // IGNORED: the column stays NULL and nothing is mirrored to entity_tags.
  const p = sqlite
    .prepare(`INSERT INTO patterns (id, owner_id, type_id, name, tag, notes, recurrence_rule, recurrence_dtstart) VALUES (uuid7(), ?, ?, ?, NULL, ?, ?, ?) RETURNING *`)
    .get(
      owner,
      input.type_id ?? null,
      input.name.trim(),
      input.notes ?? null,
      rec.rule === undefined ? null : rec.rule,
      rec.dtstart === undefined ? null : rec.dtstart,
    ) as PatternRow;
  if (Array.isArray(input.task_ids) && input.task_ids.length) {
    try {
      setMembers(p.id, input.task_ids);
    } catch (err) {
      return { ok: false, error: 'bad_membership', message: (err as Error).message };
    }
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${p.id}` });
  return { ok: true, row: p };
}

export type UpdatePatternResult =
  | { ok: true; row: PatternRow }
  | { ok: false; error: 'not_found' | 'unknown_type' | 'bad_recurrence' | 'bad_membership'; message?: string };

export function updatePattern(owner: string, id: string, input: UpdatePatternInput): UpdatePatternResult {
  const existing = getPatternRow(owner, id);
  if (!existing) return { ok: false, error: 'not_found' };
  // Validate a newly-assigned type belongs to this owner (createPattern does the same).
  // patterns.type_id only FKs pattern_types.id with no owner constraint, so without this a
  // PATCH could point a pattern at another owner's kind (breaking delete guards + driving
  // recurrence validation off a foreign kind name).
  if (input.type_id != null) {
    const type = sqlite.prepare(`SELECT id FROM pattern_types WHERE id = ? AND owner_id = ?`).get(input.type_id, owner) as { id: string } | undefined;
    if (!type) return { ok: false, error: 'unknown_type' };
  }
  const nextTypeId = input.type_id !== undefined ? input.type_id : existing.type_id;
  const rec = buildRecurrenceFields(owner, nextTypeId, input.recurrence_rule, input.recurrence_dtstart);
  if (!rec.ok) return { ok: false, error: 'bad_recurrence', message: rec.error };

  // AF-11 (D2): `input.tag` is accepted-and-IGNORED (API compat) — the column is
  // preserved as-is (NULL after migration 0120) and entity_tags is never written.
  const row = sqlite
    .prepare(`UPDATE patterns SET type_id = ?, name = ?, notes = ?, recurrence_rule = ?, recurrence_dtstart = ? WHERE id = ? RETURNING *`)
    .get(
      nextTypeId,
      input.name?.trim() ?? existing.name,
      input.notes !== undefined ? input.notes : existing.notes,
      rec.rule === undefined ? existing.recurrence_rule : rec.rule,
      rec.dtstart === undefined ? existing.recurrence_dtstart : rec.dtstart,
      id,
    ) as PatternRow;
  if (Array.isArray(input.task_ids)) {
    try {
      setMembers(id, input.task_ids);
    } catch (err) {
      return { ok: false, error: 'bad_membership', message: (err as Error).message };
    }
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${id}` });
  return { ok: true, row };
}

export type DeletePatternResult = { ok: true } | { ok: false; error: 'not_found' };

export function deletePattern(owner: string, id: string): DeletePatternResult {
  const p = sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(id, owner) as { id: string } | undefined;
  if (!p) return { ok: false, error: 'not_found' };
  // Ritual-local fast tasks are owned by the pattern — delete them with it. Shared real
  // tasks are untouched (only membership rows cascade). CON-3 cascade: hard-deleted tasks
  // + the routine drop their tag rows first (fast-task ids read before the DELETE).
  const fastTasks = sqlite
    .prepare(`SELECT id FROM tasks WHERE subtype = 'quick' AND id IN (SELECT task_id FROM pattern_tasks WHERE pattern_id = ?)`)
    .all(id) as { id: string }[];
  for (const t of fastTasks) removeEntityTags('task', t.id);
  sqlite.prepare(`DELETE FROM tasks WHERE subtype = 'quick' AND id IN (SELECT task_id FROM pattern_tasks WHERE pattern_id = ?)`).run(id);
  sqlite.prepare(`DELETE FROM patterns WHERE id = ?`).run(id); // pattern_tasks cascade; shared tasks untouched
  removeEntityTags('routine', id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `routine:${id}` });
  return { ok: true };
}

export type AddTaskResult = { ok: true } | { ok: false; error: 'not_found' | 'add_failed'; message?: string };

/** Add one task to a pattern (owner-scoped). FK guards task existence; a failure surfaces
 *  as add_failed (the route 400s it). Idempotent on the (pattern, task) PK. */
export function addPatternTask(owner: string, patternId: string, taskId: string, position = 0): AddTaskResult {
  if (!sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner)) return { ok: false, error: 'not_found' };
  try {
    sqlite.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(patternId, taskId, position);
  } catch (err) {
    return { ok: false, error: 'add_failed', message: (err as Error).message };
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${patternId}` });
  return { ok: true };
}

export type RemoveTaskResult = { ok: true } | { ok: false; error: 'not_found' };

/** Remove one task's membership from a pattern (owner-scoped; the task row is untouched). */
export function removePatternTask(owner: string, patternId: string, taskId: string): RemoveTaskResult {
  if (!sqlite.prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner)) return { ok: false, error: 'not_found' };
  sqlite.prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ? AND task_id = ?`).run(patternId, taskId);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${patternId}` });
  return { ok: true };
}

/**
 * Habit → Pattern bridge (Phase G, G2 / E′). Ensure a habit task is represented as a
 * Habit-type Pattern, keeping the pattern model in sync with the task's `subtype='habit'`.
 * Idempotent; a no-op if the owner has no built-in Habit type or the task is already in one.
 */
export function ensureHabitPattern(taskId: string, ownerId: string, name: string): void {
  const habitType = sqlite
    .prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1 AND owner_id = ?`)
    .get(ownerId) as { id: string } | undefined;
  if (!habitType) return;

  const already = sqlite
    .prepare(
      `SELECT 1 FROM pattern_tasks pt JOIN patterns p ON p.id = pt.pattern_id
        WHERE pt.task_id = ? AND p.type_id = ?`,
    )
    .get(taskId, habitType.id);
  if (already) return;

  const p = sqlite
    .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(ownerId, habitType.id, name) as { id: string };
  sqlite.prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(p.id, taskId);
}
