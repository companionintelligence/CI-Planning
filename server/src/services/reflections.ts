import { sqlite } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';
import { isoWeekKey } from '../lib/tz.js';
import { localISODate, isValidISODate } from '../lib/dates.js';

/**
 * services/reflections.ts (Phase W · W8b, Decision 3) — the owner-scoped CRUD/validation
 * for the `reflections` table, extracted from routes/reflections.ts so REST + GraphQL
 * share one code path. `writeAudit` fires INSIDE these functions; the SSE `broadcast`
 * stays transport-side (the route + resolver each fire the same events with the same
 * payloads, so behavior is byte-identical).
 *
 * A `reflections` row has no surrogate id — it is fully addressed by
 * (owner_id, kind, period_key, position). GraphQL uses `kind:period_key:position` as the
 * Node id (owner is always the current owner).
 *
 * The reflection KINDS:
 *   today_goal  — one per day  (period_key = 'YYYY-MM-DD', position 0)
 *   weekly_goal — three per week (period_key = 'YYYY-Www', position 0–2)
 *   day_note    — one per day  (period_key = 'YYYY-MM-DD', position 0)
 *   evening     — one per day  (period_key = 'YYYY-MM-DD', position 0) — Phase Z, flag-gated
 */

// The two goal kinds the /done + delete paths accept. day_note/evening are deliberately
// NOT here: they toggle no done_at and are written only through their dedicated paths.
export const GOAL_KINDS = new Set(['today_goal', 'weekly_goal']);
const VALID_SOURCE_KINDS = new Set(['manual', 'task', 'objective']);

/** A stored reflection row (all columns the app reads). */
export interface ReflectionRow {
  owner_id: string;
  kind: string;
  period_key: string;
  position: number;
  body: string;
  category_id: string | null;
  done_at: string | null;
  source_kind: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Normalize the optional (source_kind, source_ref) link pair. An unknown/absent kind or a
 * task/objective kind with no ref both collapse to the plain ('manual', null) default —
 * the `body` is always the display source of truth.
 */
export function normalizeSource(kind: unknown, ref: unknown): { source_kind: string; source_ref: string | null } {
  const k = typeof kind === 'string' && VALID_SOURCE_KINDS.has(kind) ? kind : 'manual';
  const r = typeof ref === 'string' && ref.trim() ? ref : null;
  if (k === 'manual' || !r) return { source_kind: 'manual', source_ref: null };
  return { source_kind: k, source_ref: r };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The today goal for a day (kind='today_goal', period_key=day, position 0). */
export function getTodayGoal(owner: string, period: string): ReflectionRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM reflections WHERE owner_id=? AND kind='today_goal' AND period_key=? AND position=0`)
    .get(owner, period) as ReflectionRow | undefined;
}

/** The three weekly-goal slots for the ISO week of the given day. */
export function getWeeklyGoals(owner: string, period: string): ReflectionRow[] {
  const weekKey = isoWeekKey(period);
  return sqlite
    .prepare(`SELECT * FROM reflections WHERE owner_id=? AND kind='weekly_goal' AND period_key=? ORDER BY position`)
    .all(owner, weekKey) as ReflectionRow[];
}

/** One weekly-goal slot by its exact ISO-week key + position (no day→week conversion). */
export function getWeeklyGoalSlot(owner: string, weekKey: string, position: number): ReflectionRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM reflections WHERE owner_id=? AND kind='weekly_goal' AND period_key=? AND position=?`)
    .get(owner, weekKey, position) as ReflectionRow | undefined;
}

/** The single day note for a day, if any. */
export function getDayNote(owner: string, period: string): ReflectionRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM reflections WHERE owner_id=? AND kind='day_note' AND period_key=? AND position=0`)
    .get(owner, period) as ReflectionRow | undefined;
}

/** The evening (EOD alignment) row for a day, if authored. */
export function getEvening(owner: string, period: string): ReflectionRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM reflections WHERE owner_id=? AND kind='evening' AND period_key=? AND position=0`)
    .get(owner, period) as ReflectionRow | undefined;
}

/** The color token the category (if any) carries in tag_prefs (kind='category'). */
export function categoryColorToken(owner: string, categoryId: string | null): string | null {
  if (!categoryId) return null;
  const row = sqlite
    .prepare(`SELECT color_token FROM tag_prefs WHERE owner_id=? AND tag_id=? AND kind='category'`)
    .get(owner, categoryId) as { color_token: string | null } | undefined;
  return row?.color_token ?? null;
}

/** The local dates in [from, to] that carry a non-empty day note (the calendar dot source). */
export function noteDates(owner: string, from: string, to: string): string[] {
  const rows = sqlite
    .prepare(
      `SELECT period_key AS date FROM reflections
        WHERE owner_id=? AND kind='day_note' AND period_key>=? AND period_key<=?
          AND TRIM(body) <> ''
        ORDER BY period_key`,
    )
    .all(owner, from, to) as { date: string }[];
  return rows.map((r) => r.date);
}

// ── Validated writes ────────────────────────────────────────────────────────────
// Each returns a discriminated result the transport maps to a status/error; writeAudit
// fires here. `action` is 'upsert' | 'delete' so the caller can broadcast the matching
// 'reflection:updated' / 'reflection:deleted' SSE event.

export type UpsertGoalResult =
  | { ok: true; action: 'upsert' | 'delete'; row: ReflectionRow | null }
  | { ok: false; error: 'period_key_required' };

/**
 * Upsert (or, on an empty/whitespace body, delete) the single today goal. Mirrors
 * PUT /api/reflections/today exactly.
 */
export function upsertTodayGoal(
  owner: string,
  input: { period_key?: string; body?: string; category_id?: string | null; source_kind?: string; source_ref?: string | null },
): UpsertGoalResult {
  if (!input.period_key) return { ok: false, error: 'period_key_required' };
  const period_key = input.period_key;
  const now = new Date().toISOString();
  const trimmed = (input.body ?? '').trim();
  const src = normalizeSource(input.source_kind, input.source_ref);

  if (!trimmed) {
    sqlite
      .prepare(`DELETE FROM reflections WHERE owner_id=? AND kind='today_goal' AND period_key=? AND position=0`)
      .run(owner, period_key);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:today:${period_key}` });
    return { ok: true, action: 'delete', row: null };
  }
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, category_id, source_kind, source_ref, created_at, updated_at)
       VALUES (?, 'today_goal', ?, 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
         body=excluded.body, category_id=excluded.category_id,
         source_kind=excluded.source_kind, source_ref=excluded.source_ref,
         updated_at=excluded.updated_at`,
    )
    .run(owner, period_key, trimmed, input.category_id ?? null, src.source_kind, src.source_ref, now, now);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:today:${period_key}` });
  return { ok: true, action: 'upsert', row: getTodayGoal(owner, period_key) ?? null };
}

export type UpsertWeeklyResult =
  | { ok: true; action: 'upsert' | 'delete'; row: ReflectionRow | null }
  | { ok: false; error: 'bad_position' | 'period_key_required' };

/**
 * Upsert (or delete on empty body) one of the three stable weekly-goal slots (position 0–2).
 * Mirrors PUT /api/reflections/weekly/:position exactly.
 */
export function upsertWeeklyGoal(
  owner: string,
  position: number,
  input: { period_key?: string; body?: string; category_id?: string | null; source_kind?: string; source_ref?: string | null },
): UpsertWeeklyResult {
  if (!Number.isInteger(position) || position < 0 || position > 2) return { ok: false, error: 'bad_position' };
  if (!input.period_key) return { ok: false, error: 'period_key_required' };
  const period_key = input.period_key;
  const now = new Date().toISOString();
  const trimmed = (input.body ?? '').trim();
  const src = normalizeSource(input.source_kind, input.source_ref);

  if (!trimmed) {
    sqlite
      .prepare(`DELETE FROM reflections WHERE owner_id=? AND kind='weekly_goal' AND period_key=? AND position=?`)
      .run(owner, period_key, position);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:weekly:${period_key}:${position}` });
    return { ok: true, action: 'delete', row: null };
  }
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, category_id, source_kind, source_ref, created_at, updated_at)
       VALUES (?, 'weekly_goal', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
         body=excluded.body, category_id=excluded.category_id,
         source_kind=excluded.source_kind, source_ref=excluded.source_ref,
         updated_at=excluded.updated_at`,
    )
    .run(owner, period_key, position, trimmed, input.category_id ?? null, src.source_kind, src.source_ref, now, now);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:weekly:${period_key}:${position}` });
  const row = sqlite
    .prepare(`SELECT * FROM reflections WHERE owner_id=? AND kind='weekly_goal' AND period_key=? AND position=?`)
    .get(owner, period_key, position) as ReflectionRow | undefined;
  return { ok: true, action: 'upsert', row: row ?? null };
}

export type UpsertNoteResult =
  | { ok: true; action: 'upsert' | 'delete'; row: ReflectionRow | null }
  | { ok: false; error: 'bad_period_key' };

/**
 * Upsert (or delete on empty body) the single day note. `period_key` IS the day the note
 * belongs to, so it must be a real date. Mirrors PUT /api/reflections/note exactly.
 */
export function upsertDayNote(owner: string, input: { period_key?: string; body?: string }): UpsertNoteResult {
  if (!isValidISODate(input.period_key)) return { ok: false, error: 'bad_period_key' };
  const period_key = input.period_key!;
  const now = new Date().toISOString();
  const trimmed = (input.body ?? '').trim();

  if (!trimmed) {
    sqlite
      .prepare(`DELETE FROM reflections WHERE owner_id=? AND kind='day_note' AND period_key=? AND position=0`)
      .run(owner, period_key);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:day_note:${period_key}` });
    return { ok: true, action: 'delete', row: null };
  }
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'day_note', ?, 0, ?, ?, ?)
       ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
         body=excluded.body, updated_at=excluded.updated_at`,
    )
    .run(owner, period_key, trimmed, now, now);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:day_note:${period_key}` });
  return { ok: true, action: 'upsert', row: getDayNote(owner, period_key) ?? null };
}

export type UpsertEveningResult =
  | { ok: true; action: 'upsert' | 'delete'; row: ReflectionRow | null }
  | { ok: false; error: 'bad_period_key' };

/**
 * Upsert (or delete on empty body) the evening (EOD alignment) row — the user's own edits
 * over the narrative. Mirrors PUT /api/reflections/evening exactly (flag gating lives in
 * the transport, not here).
 */
export function upsertEvening(owner: string, input: { period_key?: string; body?: string }): UpsertEveningResult {
  if (!isValidISODate(input.period_key)) return { ok: false, error: 'bad_period_key' };
  const period_key = input.period_key!;
  const now = new Date().toISOString();
  const trimmed = (input.body ?? '').trim();

  if (!trimmed) {
    sqlite
      .prepare(`DELETE FROM reflections WHERE owner_id=? AND kind='evening' AND period_key=? AND position=0`)
      .run(owner, period_key);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:evening:${period_key}` });
    return { ok: true, action: 'delete', row: null };
  }
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'evening', ?, 0, ?, ?, ?)
       ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
         body=excluded.body, updated_at=excluded.updated_at`,
    )
    .run(owner, period_key, trimmed, now, now);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:evening:${period_key}` });
  return { ok: true, action: 'upsert', row: getEvening(owner, period_key) ?? null };
}

/**
 * Persist an evening narrative that POST /api/reflections/evening/open generated (or
 * refreshed). Unlike upsertEvening this never deletes — the modal always writes prose.
 */
export function saveEveningNarrative(owner: string, period_key: string, prose: string): ReflectionRow | null {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'evening', ?, 0, ?, ?, ?)
       ON CONFLICT(owner_id, kind, period_key, position) DO UPDATE SET
         body=excluded.body, updated_at=excluded.updated_at`,
    )
    .run(owner, period_key, prose, now, now);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'upsert', entity: `reflection:evening:${period_key}` });
  return getEvening(owner, period_key) ?? null;
}

export type ToggleDoneResult =
  | { ok: true }
  | { ok: false; error: 'bad_kind' | 'bad_position' | 'period_key_required' | 'not_found' };

/**
 * Toggle the done_at timestamp on a today/weekly goal row. Mirrors
 * POST /api/reflections/:kind/:position/done exactly.
 */
export function toggleDone(
  owner: string,
  kind: string,
  position: number,
  input: { period_key?: string; done?: boolean },
): ToggleDoneResult {
  if (!GOAL_KINDS.has(kind)) return { ok: false, error: 'bad_kind' };
  const maxPos = kind === 'today_goal' ? 0 : 2;
  if (!Number.isInteger(position) || position < 0 || position > maxPos) return { ok: false, error: 'bad_position' };
  if (!input.period_key) return { ok: false, error: 'period_key_required' };

  const now = new Date().toISOString();
  const result = sqlite
    .prepare(`UPDATE reflections SET done_at=?, updated_at=? WHERE owner_id=? AND kind=? AND period_key=? AND position=?`)
    .run(input.done ? now : null, now, owner, kind, input.period_key, position);
  if (result.changes === 0) return { ok: false, error: 'not_found' };

  writeAudit({ ownerId: owner, actor: 'owner', action: input.done ? 'done' : 'undone', entity: `reflection:${kind}:${input.period_key}:${position}` });
  return { ok: true };
}

export type DeleteGoalResult = { ok: true; removed: boolean } | { ok: false; error: 'bad_kind' | 'period_key_required' };

/**
 * Delete a today/weekly goal row by composite key. Idempotent (a missing row still
 * succeeds). Mirrors DELETE /api/reflections/:kind/:position exactly. `removed` reports
 * whether a row actually existed (from the DELETE `changes` count).
 */
export function deleteGoal(owner: string, kind: string, position: number, period_key: string | undefined): DeleteGoalResult {
  if (!GOAL_KINDS.has(kind)) return { ok: false, error: 'bad_kind' };
  if (!period_key) return { ok: false, error: 'period_key_required' };

  const result = sqlite
    .prepare(`DELETE FROM reflections WHERE owner_id=? AND kind=? AND period_key=? AND position=?`)
    .run(owner, kind, period_key, position);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `reflection:${kind}:${period_key}:${position}` });
  return { ok: true, removed: result.changes > 0 };
}

/** Convenience: today's local date, matching the routes' default period. */
export function defaultPeriod(): string {
  return localISODate();
}
