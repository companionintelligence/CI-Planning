import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ, todayInTZ } from '../lib/tz.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { renderCopy } from '../agents/render-copy.js';

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
  /**
   * Optional machine tag for the step that produced this entry (T3+ use
   * `plan_week:horizon`, `plan_week:sources`, …). Free-form on purpose: branches own
   * their own vocabulary, and `transcript` is a JSON blob, so new kinds need no
   * migration. Absent on plain conversational turns.
   */
  kind?: string;
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
  message: { role: string; text: string; ts?: string; kind?: string },
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
    // Only carried when supplied, so plain turns stay {role,text,ts} as before.
    ...(message.kind ? { kind: String(message.kind) } : {}),
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

// ── T3: read-only candidate preview ───────────────────────────────────────────

export interface CandidateTask { id: string; title: string; priority: number | null; due_at: string | null }

export interface PlanWeekCandidates {
  horizon: number;
  start: string;
  open_tasks: { count: number; will_stage: number; items: CandidateTask[] };
  flight_plan: { count: number };
  objectives: { count: number };
  recurring: { count: number };
}

/** `autoRun`'s clamp (services/engine-ops.ts:93), mirrored so the preview can't promise
 *  a horizon the placement run would silently narrow. */
const clampHorizon = (n: unknown): number => Math.max(1, Math.min(60, Math.floor(Number(n) || 1)));

/**
 * Today in the OWNER's timezone — the same value `fillFlightPlanCandidates` resolves via
 * its own `ownerToday` (engine/autoplan.ts:588). `scheduled_for` is owner-local, so a
 * server-tz `localISODate()` would mis-window scheduled tasks around midnight for any
 * owner in a different zone.
 */
function ownerToday(owner: string): string {
  return todayInTZ(ownerTimezone(owner));
}

/**
 * What "Fill next week" WOULD stage and place, without touching anything. Strictly
 * read-only — no INSERT/UPDATE/DELETE — so the preview step is free to re-run.
 *
 * `open_tasks` mirrors `fillFlightPlanCandidates`'s SELECT (engine/autoplan.ts:600) clause
 * for clause: open, non-habit, top-level, non-recurrence-child, unstaged, and either
 * unscheduled or scheduled for the anchor day with no live block. It is deliberately a
 * copy rather than a call — that function WRITES, and a preview must not. `count` is the
 * untruncated eligible total; `will_stage` applies fill's CANDIDATE_LIMIT of 20.
 *
 * The other three are informational scoping only (per the ticket's non-goals): the
 * Flight-plan / Objectives / Recurring toggles change what this summary shows, never what
 * placement does.
 */
export function planWeekCandidates(horizonRaw: unknown): PlanWeekCandidates {
  const owner = currentOwnerId();
  const horizon = clampHorizon(horizonRaw);
  // NOT a caller-supplied day. `POST /api/auto/fill` takes no date and always resolves
  // ownerToday itself, so anchoring the preview on anything else would make it describe a
  // different task set than the confirm it gates — listing tasks fill will not stage and
  // hiding ones it will. The run's own anchor (selectedDay) is passed straight to
  // /api/auto/run by the client and is a separate concern.
  const start = ownerToday(owner);

  // Mirrors fillFlightPlanCandidates (autoplan.ts:600) — minus the write and the LIMIT.
  const ELIGIBLE = `
    FROM tasks
     WHERE owner_id = ? AND status = 'open'
       AND subtype IS NOT 'habit'
       AND parent_id IS NULL
       AND recurrence_parent_id IS NULL
       AND (scheduled_for IS NULL
            OR (scheduled_for = ? AND NOT EXISTS (
                  SELECT 1 FROM time_blocks tb
                   WHERE tb.task_id = tasks.id AND tb.block_kind = 'task'
                     AND tb.status NOT IN ('completed','skipped','cancelled'))))
       AND id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)`;

  const { n: openCount } = sqlite
    .prepare(`SELECT COUNT(*) AS n ${ELIGIBLE}`)
    .get(owner, start, owner) as { n: number };

  const items = sqlite
    .prepare(`SELECT id, title, priority, due_at ${ELIGIBLE}
              ORDER BY priority, COALESCE(due_at, '9999-12-31'), id LIMIT 20`)
    .all(owner, start, owner) as CandidateTask[];

  const { n: fpCount } = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ? AND selected = 1`)
    .get(owner) as { n: number };

  // Open, unstaged tasks carrying a LIVE objective link — an informational subset of
  // open_tasks.
  //
  // "Live" needs all three predicates, per the rule #369 established: `linked = 1` alone
  // is NOT enough (a soft-deleted link keeps linked=1's sibling rows around), the
  // objective must not be ARCHIVED (archive is orthogonal to status — an archived
  // objective is absent from the live tree), and the objective must be OURS. Joining
  // objective_tasks without joining objectives counts another owner's objective through a
  // cross-owner link row — the same cross-tenant leak #369 closed in buildTree's CTEs.
  const { n: objCount } = sqlite
    .prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM tasks t
                JOIN objective_tasks ot ON ot.task_id = t.id AND ot.linked = 1
                JOIN objectives o ON o.id = ot.objective_id
                     AND o.owner_id = ? AND o.archived_at IS NULL
               WHERE t.owner_id = ? AND t.status = 'open'
                 AND t.id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)`)
    .get(owner, owner, owner) as { n: number };

  const { n: recCount } = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM tasks
               WHERE owner_id = ? AND (recurrence_rule IS NOT NULL OR subtype = 'habit')`)
    .get(owner) as { n: number };

  return {
    horizon,
    start,
    open_tasks: { count: openCount, will_stage: Math.min(openCount, 20), items },
    flight_plan: { count: fpCount },
    objectives: { count: objCount },
    recurring: { count: recCount },
  };
}

/** `false` when nothing was removed — unknown id or another owner's row alike. */
export function deleteSession(id: string): boolean {
  const info = sqlite
    .prepare(`DELETE FROM planning_sessions WHERE id = ? AND owner_id = ?`)
    .run(id, currentOwnerId());
  return info.changes > 0;
}

// ── T10 (#346): consolidate / summarize ─────────────────────────────────────────

export interface ConsolidateResult { summary: string; source: 'model' | 'fallback' }

/**
 * Collapse a caller-selected set of the owner's own sessions into one prose summary.
 * Builds a deterministic digest, passes it as BOTH `facts` and `fallback` to a single
 * `renderCopy('weekly_review', …)` call, and persists `copy.text` onto the newest
 * selected session's `summary` (source rows are never deleted — Clear/T6 owns that).
 *
 * T1's schema (migration 0131) has no action/created-task count columns, so both are
 * derived from `transcript`: `actionCount` is every logged turn (the simplest faithful
 * proxy); `createdTaskCount` counts turns tagged with a per-task placement kind
 * (`plan_week:schedule_set` / `plan_week:schedule_auto`, T4's Schedule-Tasks branch).
 * Fill-branch sessions (T3/T9) record their placement in one aggregate
 * `plan_week:confirm` line rather than per task, so they contribute 0 to
 * `createdTaskCount` — a real gap in what the transcript captures, not a bug here.
 */
export async function consolidateSessions(ids: unknown): Promise<SessionResult<ConsolidateResult>> {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((v) => typeof v === 'string' && v)) {
    return { ok: false, error: 'ids must be a non-empty array of strings' };
  }
  const owner = currentOwnerId();
  // Ids belonging to another owner simply don't match this WHERE clause — never leaked,
  // never mutated, same as every other owner-scoped read in this file.
  const placeholders = ids.map(() => '?').join(',');
  const rows = sqlite
    .prepare(`SELECT * FROM planning_sessions WHERE owner_id = ? AND id IN (${placeholders}) ORDER BY started_at DESC`)
    .all(owner, ...ids) as SessionRow[];
  if (rows.length === 0) {
    return { ok: false, error: 'no owned sessions found for the given ids' };
  }
  const sessions = rows.map(hydrate); // newest first (started_at DESC)

  const tz = ownerTimezone(owner);
  const dates = sessions.map((s) => localDateInTZ(s.started_at, tz)).sort();
  const dateRange = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;

  const branches = [...new Set(sessions.map((s) => s.entry_branch))].sort();
  const branchLine = branches.length ? branches.join(', ') : 'no branch recorded';

  let actionCount = 0;
  let createdTaskCount = 0;
  for (const s of sessions) {
    actionCount += s.transcript.length;
    for (const turn of s.transcript) {
      if (turn.kind === 'plan_week:schedule_set' || turn.kind === 'plan_week:schedule_auto') createdTaskCount++;
    }
  }

  const digest =
    `${sessions.length} planning session${sessions.length === 1 ? '' : 's'} ` +
    `(${dateRange}) across ${branches.length} branch${branches.length === 1 ? '' : 'es'}: ${branchLine}. ` +
    `${actionCount} action${actionCount === 1 ? '' : 's'} recorded, ` +
    `${createdTaskCount} task${createdTaskCount === 1 ? '' : 's'} placed.`;

  const copy = await renderCopy('weekly_review', { facts: digest, fallback: digest });

  const newest = sessions[0];
  sqlite
    .prepare(`UPDATE planning_sessions SET summary = ? WHERE id = ? AND owner_id = ?`)
    .run(copy.text, newest.id, owner);

  return { ok: true, value: { summary: copy.text, source: copy.source } };
}
