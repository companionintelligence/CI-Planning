import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';

/**
 * services/planning-sessions.ts (FTUE · T1, #337) — owner-scoped CRUD for the
 * `planning_sessions` table (migration 0131).
 *
 * One row per "Plan my week" session; the entire conversation is a single JSON array
 * in `transcript`. There is deliberately no per-turn events table — see the ticket's
 * Non-goals. T2+ append to the transcript as the assistant runs; T6 (Logs) reads.
 *
 * These functions take NO owner argument: they self-scope via `currentOwnerId()` and
 * every statement filters `owner_id = ?`. A row belonging to another owner is
 * indistinguishable from a missing one (`undefined` / `false`), which is what lets the
 * route map both to a flat 404 without leaking existence.
 *
 * `entry_branch` and `status` are validated here rather than by a CHECK constraint, so
 * adding a branch is a code change, not a migration. Callers get a discriminated
 * result for the two validating entry points; the rest return `undefined` when absent.
 *
 * No `writeAudit` and no SSE `broadcast`: planning sessions are operational chat logs,
 * not audited domain writes (ticket Non-goals).
 */

export type PlanWeekEntryBranch = 'fill_week' | 'schedule_tasks' | 'review' | 'onboarding';
export type PlanWeekSessionStatus = 'open' | 'completed' | 'abandoned';

export interface TranscriptMessage {
  role: 'system' | 'user';
  text: string;
  ts: string;
}

export const ENTRY_BRANCHES: ReadonlySet<string> = new Set<PlanWeekEntryBranch>([
  'fill_week',
  'schedule_tasks',
  'review',
  'onboarding',
]);

export const SESSION_STATUSES: ReadonlySet<string> = new Set<PlanWeekSessionStatus>([
  'open',
  'completed',
  'abandoned',
]);

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['system', 'user']);

/** The hydrated shape every read/return goes through — never the raw row. */
export interface PlanningSession {
  id: string;
  owner_id: string;
  started_at: string;
  ended_at: string | null;
  entry_branch: PlanWeekEntryBranch;
  status: PlanWeekSessionStatus;
  llm_used: boolean;
  transcript: TranscriptMessage[];
  summary: string | null;
  created_at: string;
}

/** Validation failures the route maps to 422. */
export type SessionResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface SessionRow {
  id: string;
  owner_id: string;
  started_at: string;
  ended_at: string | null;
  entry_branch: string;
  status: string;
  llm_used: number;
  transcript: string;
  summary: string | null;
  created_at: string;
}

/**
 * Raw row → API shape: `transcript` parsed to an array and `llm_used` coerced to a
 * boolean. Every returning function funnels through this so the JSON string and the
 * 0/1 integer never escape the service.
 *
 * A transcript that fails to parse (hand-edited row, truncated write) degrades to `[]`
 * rather than throwing — a corrupt log must not make the session unreadable.
 */
function hydrate(row: SessionRow): PlanningSession {
  let transcript: TranscriptMessage[] = [];
  try {
    const parsed: unknown = JSON.parse(row.transcript);
    if (Array.isArray(parsed)) transcript = parsed as TranscriptMessage[];
  } catch {
    transcript = [];
  }
  return {
    id: row.id,
    owner_id: row.owner_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    entry_branch: row.entry_branch as PlanWeekEntryBranch,
    status: row.status as PlanWeekSessionStatus,
    llm_used: !!row.llm_used,
    transcript,
    summary: row.summary,
    created_at: row.created_at,
  };
}

/** Owner-scoped fetch of the raw row — the single place the scoping predicate lives. */
function rawById(id: string, owner: string): SessionRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM planning_sessions WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as SessionRow | undefined;
}

/** Open a session on a branch. Invalid branch → `{ ok: false }` (route: 422). */
export function openSession(entryBranch: string): SessionResult<PlanningSession> {
  if (!ENTRY_BRANCHES.has(entryBranch)) {
    return { ok: false, error: `entry_branch must be one of: ${[...ENTRY_BRANCHES].join(', ')}` };
  }
  const owner = currentOwnerId();
  const id = newId();
  sqlite
    .prepare(`INSERT INTO planning_sessions (id, owner_id, entry_branch) VALUES (?, ?, ?)`)
    .run(id, owner, entryBranch);
  // Re-read so the DB's own CURRENT_TIMESTAMP defaults are what we return.
  return { ok: true, value: hydrate(rawById(id, owner) as SessionRow) };
}

/**
 * Append one message to the transcript. `ts` is stamped server-side when absent — a
 * client clock must not decide log ordering. Unknown id / other owner → `undefined`.
 */
export function appendTranscript(
  id: string,
  message: { role: string; text: string; ts?: string },
): SessionResult<PlanningSession> | undefined {
  const owner = currentOwnerId();
  const row = rawById(id, owner);
  if (!row) return undefined;
  if (!MESSAGE_ROLES.has(message.role)) {
    return { ok: false, error: `message.role must be one of: ${[...MESSAGE_ROLES].join(', ')}` };
  }
  const entry: TranscriptMessage = {
    role: message.role as TranscriptMessage['role'],
    text: String(message.text ?? ''),
    ts: message.ts ?? new Date().toISOString(),
  };
  const next = [...hydrate(row).transcript, entry];
  sqlite
    .prepare(`UPDATE planning_sessions SET transcript = ? WHERE id = ? AND owner_id = ?`)
    .run(JSON.stringify(next), id, owner);
  return { ok: true, value: hydrate(rawById(id, owner) as SessionRow) };
}

/** Replace the whole transcript. Unknown id / other owner → `undefined`. */
export function setTranscript(id: string, arr: TranscriptMessage[]): PlanningSession | undefined {
  const owner = currentOwnerId();
  if (!rawById(id, owner)) return undefined;
  sqlite
    .prepare(`UPDATE planning_sessions SET transcript = ? WHERE id = ? AND owner_id = ?`)
    .run(JSON.stringify(Array.isArray(arr) ? arr : []), id, owner);
  return hydrate(rawById(id, owner) as SessionRow);
}

/**
 * Close a session: stamp `ended_at` and set the terminal status. `summary` and
 * `llmUsed` are only written when supplied, so a close can't blank a summary an
 * earlier call already stored. Unknown id / other owner → `undefined`.
 */
export function closeSession(
  id: string,
  patch: { status: string; summary?: string; llmUsed?: boolean },
): SessionResult<PlanningSession> | undefined {
  const owner = currentOwnerId();
  if (!rawById(id, owner)) return undefined;
  if (!SESSION_STATUSES.has(patch.status)) {
    return { ok: false, error: `status must be one of: ${[...SESSION_STATUSES].join(', ')}` };
  }
  const sets = ['ended_at = ?', 'status = ?'];
  const vals: unknown[] = [new Date().toISOString(), patch.status];
  if (patch.summary !== undefined) { sets.push('summary = ?'); vals.push(patch.summary); }
  if (patch.llmUsed !== undefined) { sets.push('llm_used = ?'); vals.push(patch.llmUsed ? 1 : 0); }
  sqlite
    .prepare(`UPDATE planning_sessions SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`)
    .run(...vals, id, owner);
  return { ok: true, value: hydrate(rawById(id, owner) as SessionRow) };
}

/** Every session of the current owner, newest first (the Logs tab's order). */
export function listSessions(): PlanningSession[] {
  const rows = sqlite
    .prepare(`SELECT * FROM planning_sessions WHERE owner_id = ? ORDER BY started_at DESC`)
    .all(currentOwnerId()) as SessionRow[];
  return rows.map(hydrate);
}

export function getSession(id: string): PlanningSession | undefined {
  const row = rawById(id, currentOwnerId());
  return row ? hydrate(row) : undefined;
}

/** `false` when nothing was removed — unknown id or another owner's row alike. */
export function deleteSession(id: string): boolean {
  const info = sqlite
    .prepare(`DELETE FROM planning_sessions WHERE id = ? AND owner_id = ?`)
    .run(id, currentOwnerId());
  return info.changes > 0;
}
