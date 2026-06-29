import type { Database } from 'better-sqlite3';

export interface Op {
  opId: string;
  entity: 'task' | 'block';
  entityId: string;
  /** Snake_case, API-shape field names — only whitelisted fields are applied. */
  fields: Record<string, unknown>;
  baseVersion: number;
  /** UTC ISO client clock — tiebreak for same-field LWW, never authoritative. */
  clientTs: string;
}

export interface ApplyResult {
  opId: string;
  entityId: string;
  /** Monotonic per-record version after this op. */
  version: number;
  /** Fields that were actually written. */
  applied: Record<string, unknown>;
  /** Fields whose clientTs was older than an already-applied write — dropped by LWW. */
  dropped: string[];
}

// Allowlist prevents arbitrary column writes / SQL injection via field names.
const TASK_FIELDS = new Set([
  'title', 'description', 'notes', 'due_at', 'scheduled_for', 'defer_until',
  'task_time', 'estimated_minutes', 'priority', 'status', 'completed_at',
  'parent_id', 'subtype',
]);

const BLOCK_FIELDS = new Set([
  'title', 'start_at', 'end_at', 'is_locked', 'status', 'block_kind',
  'tag', 'block_type', 'goal_start_date', 'duration_minutes', 'note',
  'all_day', 'parent_block_id', 'category_id',
]);

function nowUTC(): string {
  return new Date().toISOString();
}

/**
 * Enforce the monotonic-completion rule (Locked Decision D3, §4).
 *
 * - `status`: once 'done', a merge cannot silently revert it. Un-completing
 *   requires a deliberate op that explicitly carries the new status.
 * - `completed_at`: once set, keep the EARLIEST timestamp; a concurrent edit
 *   can never null it out or replace it with a later stamp.
 */
export function applyMonotonic(field: string, row: Record<string, unknown>, value: unknown): unknown {
  if (field === 'status' && row['status'] === 'done' && value !== 'done') {
    return 'done';
  }
  if (field === 'completed_at') {
    const existing = row['completed_at'] as string | null | undefined;
    if (existing && (value == null || String(value) > existing)) return existing;
  }
  return value;
}

/**
 * Apply one op to a row using field-level LWW + monotonic completion.
 * Runs synchronously on the raw better-sqlite3 `Database` so it can be
 * called inside a `sqlite.transaction()` callback.
 */
export function applyOp(sqlite: Database, op: Op, ownerId: string): ApplyResult {
  const table = op.entity === 'task' ? 'tasks' : 'time_blocks';
  const allowed = op.entity === 'task' ? TASK_FIELDS : BLOCK_FIELDS;

  const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(op.entityId) as
    Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error('not found'), { status: 404 });

  // Tasks carry owner_id; blocks are scoped implicitly by session auth.
  if (op.entity === 'task' && row['owner_id'] !== ownerId) {
    throw Object.assign(new Error('not found'), { status: 404 });
  }

  const fieldTs: Record<string, string> = row['field_ts']
    ? JSON.parse(row['field_ts'] as string)
    : {};
  const merged: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [field, value] of Object.entries(op.fields)) {
    if (!allowed.has(field)) continue; // silently drop disallowed fields
    if (op.clientTs >= (fieldTs[field] ?? '')) {
      merged[field] = applyMonotonic(field, row, value);
      fieldTs[field] = op.clientTs;
    } else {
      dropped.push(field);
    }
  }

  const version = ((row['version'] as number) ?? 0) + 1;
  const updatedAt = nowUTC();

  const setClauses: string[] = [];
  const setValues: unknown[] = [];
  for (const [f, v] of Object.entries(merged)) {
    setClauses.push(`${f} = ?`);
    setValues.push(v);
  }
  setClauses.push('version = ?', 'updated_at = ?', 'field_ts = ?');
  setValues.push(version, updatedAt, JSON.stringify(fieldTs), op.entityId);

  sqlite
    .prepare(`UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...setValues);

  return { opId: op.opId, entityId: op.entityId, version, applied: merged, dropped };
}

// Camel → snake_case maps for the stampRow helper (mirrors the PATCH routes'
// `update` object key names).
const TASK_CAMEL_TO_SNAKE: Record<string, string> = {
  title: 'title', description: 'description', notes: 'notes',
  dueAt: 'due_at', scheduledFor: 'scheduled_for', deferUntil: 'defer_until',
  taskTime: 'task_time', estimatedMinutes: 'estimated_minutes',
  priority: 'priority', status: 'status', completedAt: 'completed_at',
  parentId: 'parent_id', subtype: 'subtype',
  recurrenceRule: 'recurrence_rule', recurrenceDtstart: 'recurrence_dtstart',
};

const BLOCK_CAMEL_TO_SNAKE: Record<string, string> = {
  title: 'title', startAt: 'start_at', endAt: 'end_at', isLocked: 'is_locked',
  status: 'status', blockKind: 'block_kind', tag: 'tag', blockType: 'block_type',
  goalStartDate: 'goal_start_date', durationMinutes: 'duration_minutes',
  note: 'note', allDay: 'all_day', parentBlockId: 'parent_block_id',
  categoryId: 'category_id', colorToken: 'color_token', isAuto: 'is_auto',
  recurrenceRule: 'recurrence_rule', recurrenceDtstart: 'recurrence_dtstart',
};

/**
 * Stamp an online PATCH's modified fields with the server clock so that any
 * queued sync op with an older `clientTs` for those same fields loses the LWW
 * comparison on arrival.
 *
 * Called from existing PATCH routes after a successful Drizzle update so that
 * direct online edits are version-tracked on the same path as sync ops.
 *
 * `camelFields` — the keys of the Drizzle `update` object (camelCase). Unknown
 * keys are silently skipped; recurrence/meta columns outside the sync whitelist
 * get stamped but not participted in sync merges (harmless).
 */
export function stampRow(
  sqlite: Database,
  entity: 'task' | 'block',
  entityId: string,
  camelFields: string[],
): void {
  const table = entity === 'task' ? 'tasks' : 'time_blocks';
  const map = entity === 'task' ? TASK_CAMEL_TO_SNAKE : BLOCK_CAMEL_TO_SNAKE;
  const snakeFields = camelFields.map((f) => map[f]).filter(Boolean);
  if (snakeFields.length === 0) return;

  const row = sqlite
    .prepare(`SELECT version, field_ts FROM ${table} WHERE id = ?`)
    .get(entityId) as { version: number | null; field_ts: string | null } | undefined;
  if (!row) return;

  const now = nowUTC();
  const fieldTs: Record<string, string> = row.field_ts ? JSON.parse(row.field_ts) : {};
  for (const f of snakeFields) fieldTs[f] = now;

  sqlite
    .prepare(`UPDATE ${table} SET version = ?, updated_at = ?, field_ts = ? WHERE id = ?`)
    .run((row.version ?? 0) + 1, now, JSON.stringify(fieldTs), entityId);
}
