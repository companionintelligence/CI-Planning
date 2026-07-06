import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';

export interface DayType { id: string; key: string; name: string; is_builtin: boolean }

const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * UTC day-of-week at noon — matches the legacy `isWeekendDate()` (autoplan.ts) so the
 * default resolution (no per-date assignment, no week-map row) is byte-identical to
 * today's workday/weekend split. 0=Sun … 6=Sat.
 */
function utcDow(dateStr: string): number {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

/**
 * Resolve a local date 'YYYY-MM-DD' to a day-type KEY for an owner:
 *   per-date assignment → weekly default map → UTC weekend heuristic.
 *
 * The heuristic fallback is the contract that preserves behavior: with no day_types /
 * map rows (a new owner, or a reset test DB) it returns exactly what `isWeekendDate()`
 * did. The seeded builtins + map make the default visible & editable, nothing more.
 */
export function resolveDayType(ownerId: string, date: string): string {
  return resolveDayTypeWithSource(ownerId, date).key;
}

export type DayTypeSource = 'assignment' | 'map' | 'default';

/** Like resolveDayType but also reports WHERE the key came from — so the UI can show
 *  whether a date carries an explicit per-date override (and offer "reset to default"). */
export function resolveDayTypeWithSource(ownerId: string, date: string): { key: string; source: DayTypeSource } {
  const a = sqlite
    .prepare(`SELECT day_type_key FROM day_assignments WHERE owner_id = ? AND date = ?`)
    .get(ownerId, date) as { day_type_key: string } | undefined;
  if (a) return { key: a.day_type_key, source: 'assignment' };

  const dow = utcDow(date);
  const m = sqlite
    .prepare(`SELECT day_type_key FROM day_of_week_map WHERE owner_id = ? AND dow = ?`)
    .get(ownerId, dow) as { day_type_key: string } | undefined;
  if (m) return { key: m.day_type_key, source: 'map' };

  return { key: dow === 0 || dow === 6 ? 'weekend' : 'workday', source: 'default' };
}

// ── Catalog CRUD (consumed by routes/day-types.ts) ────────────────────────────
export function listDayTypes(ownerId: string): DayType[] {
  return (
    sqlite
      .prepare(`SELECT id, key, name, is_builtin FROM day_types WHERE owner_id = ? ORDER BY is_builtin DESC, name`)
      .all(ownerId) as { id: string; key: string; name: string; is_builtin: number }[]
  ).map((r) => ({ id: r.id, key: r.key, name: r.name, is_builtin: !!r.is_builtin }));
}

export function getDayType(ownerId: string, id: string): DayType | undefined {
  const r = sqlite
    .prepare(`SELECT id, key, name, is_builtin FROM day_types WHERE owner_id = ? AND id = ?`)
    .get(ownerId, id) as { id: string; key: string; name: string; is_builtin: number } | undefined;
  return r ? { id: r.id, key: r.key, name: r.name, is_builtin: !!r.is_builtin } : undefined;
}

/** Create a custom (non-builtin) day type. Throws on a duplicate key (UNIQUE). */
export function createDayType(ownerId: string, key: string, name: string): DayType {
  const id = newId();
  sqlite
    .prepare(`INSERT INTO day_types (id, owner_id, key, name, is_builtin) VALUES (?, ?, ?, ?, 0)`)
    .run(id, ownerId, key, name);
  return { id, key, name, is_builtin: false };
}

export function renameDayType(ownerId: string, id: string, name: string): void {
  sqlite.prepare(`UPDATE day_types SET name = ? WHERE owner_id = ? AND id = ?`).run(name, ownerId, id);
}

/** Delete a custom day type and clean up any map/assignment rows that referenced it. */
export function deleteDayType(ownerId: string, dt: DayType): void {
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM day_types WHERE owner_id = ? AND id = ?`).run(ownerId, dt.id);
    sqlite.prepare(`DELETE FROM day_of_week_map WHERE owner_id = ? AND day_type_key = ?`).run(ownerId, dt.key);
    sqlite.prepare(`DELETE FROM day_assignments WHERE owner_id = ? AND day_type_key = ?`).run(ownerId, dt.key);
  })();
}

/** The weekly default map as a complete dow→key record, heuristic-filled for any gap. */
export function getWeekMap(ownerId: string): Record<number, string> {
  const rows = sqlite
    .prepare(`SELECT dow, day_type_key FROM day_of_week_map WHERE owner_id = ?`)
    .all(ownerId) as { dow: number; day_type_key: string }[];
  const byDow = new Map(rows.map((r) => [r.dow, r.day_type_key]));
  const out: Record<number, string> = {};
  for (let dow = 0; dow < 7; dow++) {
    out[dow] = byDow.get(dow) ?? (dow === 0 || dow === 6 ? 'weekend' : 'workday');
  }
  return out;
}

/** Replace the weekly map atomically with the given dow→key entries. */
export function setWeekMap(ownerId: string, map: Record<number, string>): void {
  sqlite.transaction(() => {
    const ins = sqlite.prepare(
      `INSERT INTO day_of_week_map (owner_id, dow, day_type_key) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, dow) DO UPDATE SET day_type_key = excluded.day_type_key`,
    );
    for (const [dow, key] of Object.entries(map)) ins.run(ownerId, Number(dow), key);
  })();
}

export function listAssignments(ownerId: string): Record<string, string> {
  const rows = sqlite
    .prepare(`SELECT date, day_type_key FROM day_assignments WHERE owner_id = ? ORDER BY date`)
    .all(ownerId) as { date: string; day_type_key: string }[];
  return Object.fromEntries(rows.map((r) => [r.date, r.day_type_key]));
}

export function assignDate(ownerId: string, date: string, key: string): void {
  sqlite
    .prepare(
      `INSERT INTO day_assignments (owner_id, date, day_type_key) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, date) DO UPDATE SET day_type_key = excluded.day_type_key`,
    )
    .run(ownerId, date, key);
}

export function clearAssignment(ownerId: string, date: string): void {
  sqlite.prepare(`DELETE FROM day_assignments WHERE owner_id = ? AND date = ?`).run(ownerId, date);
}

/** True when `key` names a day type the owner has defined (used to validate writes). */
export function dayTypeKeyExists(ownerId: string, key: string): boolean {
  return !!sqlite
    .prepare(`SELECT 1 FROM day_types WHERE owner_id = ? AND key = ? LIMIT 1`)
    .get(ownerId, key);
}

// ── Validated catalog CRUD (Phase W · W7, Decision 3) ─────────────────────────
// Slug/name/dup/builtin validation extracted from routes/day-types.ts so REST + GraphQL
// share one owner-scoped path. writeAudit fires here; these routes emit no SSE.

export type CreateDayTypeResult = { ok: true; dayType: DayType } | { ok: false; error: 'bad_key' | 'name_required' | 'duplicate' };

export function createDayTypeChecked(ownerId: string, rawKey: unknown, rawName: unknown): CreateDayTypeResult {
  const key = String(rawKey ?? '').trim().toLowerCase();
  const name = String(rawName ?? '').trim();
  if (!KEY_RE.test(key)) return { ok: false, error: 'bad_key' };
  if (!name) return { ok: false, error: 'name_required' };
  if (dayTypeKeyExists(ownerId, key)) return { ok: false, error: 'duplicate' };
  const dayType = createDayType(ownerId, key, name);
  writeAudit({ ownerId, actor: 'owner', action: 'create', entity: `day-type:${key}` });
  return { ok: true, dayType };
}

export type RenameDayTypeResult = { ok: true; dayType: DayType } | { ok: false; error: 'not_found' | 'name_required' };

export function renameDayTypeChecked(ownerId: string, id: string, rawName: unknown): RenameDayTypeResult {
  const dt = getDayType(ownerId, id);
  if (!dt) return { ok: false, error: 'not_found' };
  const name = String(rawName ?? '').trim();
  if (!name) return { ok: false, error: 'name_required' };
  renameDayType(ownerId, dt.id, name);
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `day-type:${dt.key}` });
  return { ok: true, dayType: { ...dt, name } };
}

export type DeleteDayTypeResult = { ok: true; dayType: DayType } | { ok: false; error: 'not_found' | 'builtin' };

export function deleteDayTypeChecked(ownerId: string, id: string): DeleteDayTypeResult {
  const dt = getDayType(ownerId, id);
  if (!dt) return { ok: false, error: 'not_found' };
  if (dt.is_builtin) return { ok: false, error: 'builtin' };
  deleteDayType(ownerId, dt);
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `day-type:${dt.key}` });
  return { ok: true, dayType: dt };
}
