/**
 * Companion Memory service. Two directions, both real as of AA4:
 *
 * PULL (Phase AA · AA0): the CI-Server `companion-memory` connector
 * (connectors/memory.ts) resolves per-owner creds and `memoryConnectorAvailable()`
 * reflects it truthfully; the pull surface (memory_pull_enabled flag + the AA1
 * suggest agent) rides it.
 *
 * PUSH (Phase AA · AA4): `syncToMemory` pushes the owner's completed tasks, completed
 * habit occurrences, and reflections to CI-Server's capture ingest (`POST /v1/events`),
 * gated by the memory_sync_enabled flag + the per-entity scope toggles, watermarked by
 * memory_last_synced_at. `pushConnectorAvailable(owner)` is creds-driven, the same rule
 * as the pull side. A daily `push_memory` job (0117) drives it in the background.
 */
import { sqlite } from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  memoryCreds,
  memoryMode,
  postEvents,
  MemoryUnavailable,
  type MemoryEvent,
  type MemoryCredsSource,
  type MemoryAuthKind,
} from '../connectors/memory.js';

export interface MemoryScopes {
  completed: boolean; // completed tasks & time actuals
  habits: boolean; // habits & streaks
  reflections: boolean; // daily reflections / briefings
}

/** Pull-side (AA0) connection state for the Settings panel. */
export interface MemoryPullStatus {
  /** scheduling_prefs.memory_pull_enabled — the AA master flag. */
  enabled: boolean;
  /** Creds resolve (Settings connection or env fallback). */
  available: boolean;
  /** Where the creds came from; null when unavailable. */
  source: MemoryCredsSource | null;
  /** How the settings connection authenticates (AA0b): 'oidc' = CI-Portal SSO,
   *  'manual' = pasted key/bearer, null for the env fallback / when unavailable. */
  authKind: MemoryAuthKind | null;
  /** Host of the connected CI-Server (display only — never the key). */
  host: string | null;
}

export interface MemoryStatus {
  enabled: boolean;
  connected: boolean;
  account: string | null;
  lastSyncedAt: string | null;
  /** Whether the CI-Server connector resolves creds for this owner (AA0 — real). */
  available: boolean;
  scopes: MemoryScopes;
  pull: MemoryPullStatus;
}

interface PrefsRow {
  memory_sync_enabled: number;
  memory_account: string | null;
  memory_last_synced_at: string | null;
  memory_sync_completed: number;
  memory_sync_habits: number;
  memory_sync_reflections: number;
  memory_pull_enabled: number;
}

function prefs(owner: string): PrefsRow | undefined {
  return sqlite
    .prepare(
      `SELECT memory_sync_enabled, memory_account, memory_last_synced_at,
              memory_sync_completed, memory_sync_habits, memory_sync_reflections,
              memory_pull_enabled
         FROM scheduling_prefs WHERE owner_id = ?`
    )
    .get(owner) as PrefsRow | undefined;
}

/**
 * Whether the Companion Memory connector is available for this owner: true iff
 * creds resolve (Settings connection → env fallback). Real as of AA0.
 */
export function memoryConnectorAvailable(owner: string): boolean {
  return memoryCreds(owner) !== null;
}

/** Column default (0147) — also the 48h the pull agents used to hardcode. */
const DEFAULT_MEMORY_WINDOW_DAYS = 2;

/**
 * How far AHEAD the memory pull reads, in ms (`scheduling_prefs.memory_window_days`).
 * Forward, not back: the pull surfaces UPCOMING events — the suggest agent mirrors them
 * into tasks and the brief lists them — so a backward window would stage work for things
 * that already happened. Shared by every pull consumer so one setting moves them together.
 *
 * Falls back to the column default for an owner with no seeded prefs row, and treats a
 * non-positive stored value as "unset" so a bad row can never collapse the window to zero
 * and silently stop all suggestions.
 */
export function memoryWindowMs(owner: string): number {
  const row = sqlite
    .prepare(`SELECT memory_window_days FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { memory_window_days?: number | null } | undefined;
  const days = Number(row?.memory_window_days);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_MEMORY_WINDOW_DAYS) * 86_400_000;
}

/**
 * Whether the PUSH backend is reachable for this owner: true iff creds resolve —
 * the SAME creds-driven rule as the pull side (memoryConnectorAvailable). Real as
 * of AA4.
 */
function pushConnectorAvailable(owner: string): boolean {
  return memoryCreds(owner) !== null;
}

export function memoryStatus(owner: string): MemoryStatus {
  const p = prefs(owner);
  const creds = memoryCreds(owner);
  let host: string | null = null;
  if (creds) {
    try {
      host = new URL(creds.url).host;
    } catch {
      host = creds.url;
    }
  }
  return {
    enabled: !!p?.memory_sync_enabled,
    connected: !!p?.memory_account,
    account: p?.memory_account ?? null,
    lastSyncedAt: p?.memory_last_synced_at ?? null,
    available: creds !== null,
    scopes: {
      completed: !!p?.memory_sync_completed,
      habits: !!p?.memory_sync_habits,
      reflections: !!p?.memory_sync_reflections,
    },
    pull: {
      enabled: !!p?.memory_pull_enabled,
      available: creds !== null,
      source: creds?.source ?? null,
      authKind: creds?.authKind ?? null,
      host,
    },
  };
}

export interface SyncCounts {
  /** Events built per scope (before the push). */
  completed: number;
  habits: number;
  reflections: number;
  /** CI-Server's idempotent-ingest tallies (fixture mode: ingested = total, rest 0). */
  ingested: number;
  duplicate: number;
  rejected: number;
}

export type SyncResult =
  | {
      ok: true;
      syncedAt: string;
      counts: SyncCounts;
      /** Which transport handled the push. 'fixture' = no network — the counts are
       *  simulated (offline-by-default posture); callers MUST NOT log a fixture pass
       *  as if events reached CI-Server. */
      transport: 'live' | 'fixture';
    }
  | { ok: false; reason: 'disabled' | 'not_connected' | 'unavailable' };

/** If no prior sync, only push entities completed/updated within this recent window. */
const INITIAL_WINDOW_DAYS = 30;

interface TaskEventRow {
  id: string;
  title: string;
  completed_at: string;
  estimated_minutes: number | null;
  actual_minutes: number | null;
}

interface ReflectionEventRow {
  kind: string;
  period_key: string;
  body: string;
  updated_at: string;
}

/**
 * Completed tasks with completed_at past the watermark. `notHabit` excludes tasks that
 * are members of a Habit pattern so a completed habit isn't double-pushed as a plain
 * task_completed AND a habit_done — the habits scope owns those.
 */
function completedTaskEvents(owner: string, since: string, notHabit: boolean): MemoryEvent[] {
  const rows = sqlite
    .prepare(
      `SELECT t.id, t.title, t.completed_at, t.estimated_minutes, t.actual_minutes
         FROM tasks t
        WHERE t.owner_id = ? AND t.status = 'done' AND t.completed_at IS NOT NULL AND t.completed_at > ?
          ${notHabit ? `AND t.id NOT IN (
            SELECT pt.task_id FROM pattern_tasks pt
              JOIN patterns p ON p.id = pt.pattern_id
              JOIN pattern_types pty ON pty.id = p.type_id
             WHERE p.owner_id = ? AND pty.name = 'Habit')` : ``}
        ORDER BY t.completed_at`,
    )
    .all(...(notHabit ? [owner, since, owner] : [owner, since])) as TaskEventRow[];
  return rows.map((r) => ({
    source_id: `task:${r.id}`,
    type: 'task_completed',
    occurred_at: r.completed_at,
    payload: {
      title: r.title,
      completed_at: r.completed_at,
      estimated_minutes: r.estimated_minutes ?? null,
      ...(r.actual_minutes ? { actual_minutes: r.actual_minutes } : {}),
    },
  }));
}

/**
 * Completed habit occurrences: a task that belongs to a Habit pattern (pattern_types.name
 * = 'Habit'), done, completed_at past the watermark. DISTINCT — a task in several Habit
 * patterns is one event. source_id = task:<id> (the completion is the task's), typed
 * 'habit_done'.
 */
function habitEvents(owner: string, since: string): MemoryEvent[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT t.id, t.title, t.completed_at, t.estimated_minutes, t.actual_minutes
         FROM tasks t
         JOIN pattern_tasks pt ON pt.task_id = t.id
         JOIN patterns p ON p.id = pt.pattern_id
         JOIN pattern_types pty ON pty.id = p.type_id
        WHERE t.owner_id = ? AND p.owner_id = ? AND pty.name = 'Habit'
          AND t.status = 'done' AND t.completed_at IS NOT NULL AND t.completed_at > ?
        ORDER BY t.completed_at`,
    )
    .all(owner, owner, since) as TaskEventRow[];
  return rows.map((r) => ({
    source_id: `task:${r.id}`,
    type: 'habit_done',
    occurred_at: r.completed_at,
    payload: {
      title: r.title,
      completed_at: r.completed_at,
      estimated_minutes: r.estimated_minutes ?? null,
      ...(r.actual_minutes ? { actual_minutes: r.actual_minutes } : {}),
    },
  }));
}

/** Day-note / evening reflections updated past the watermark. */
function reflectionEvents(owner: string, since: string): MemoryEvent[] {
  const rows = sqlite
    .prepare(
      `SELECT kind, period_key, body, updated_at
         FROM reflections
        WHERE owner_id = ? AND kind IN ('day_note', 'evening') AND updated_at > ?
        ORDER BY updated_at`,
    )
    .all(owner, since) as ReflectionEventRow[];
  return rows.map((r) => ({
    // A reflection has no surrogate id; (owner, kind, period_key, position) addresses it —
    // and there is exactly one day_note/evening per day (position 0), so kind+period_key
    // is a stable idempotency key across re-pushes.
    source_id: `reflection:${r.kind}:${r.period_key}`,
    type: 'reflection',
    occurred_at: r.updated_at,
    payload: { kind: r.kind, period_key: r.period_key, body: r.body },
  }));
}

/**
 * Push the enabled scopes to Companion Memory (`POST /v1/events`, idempotent server-side).
 * Guards: off → 'disabled', connected-but-no-creds → 'unavailable', not connected →
 * 'not_connected'. Builds task_completed / habit_done / reflection events past the
 * `memory_last_synced_at` watermark (or the last {@link INITIAL_WINDOW_DAYS} on a first
 * sync), honoring the per-entity scope toggles. The next watermark is captured BEFORE
 * the SELECT so an event that occurs during the push is re-selected next run rather than
 * skipped (idempotent ingest makes the rare double-push harmless). On a successful push
 * it stamps that instant into `memory_last_synced_at`; a {@link MemoryUnavailable}
 * degrades to `{ ok:false, reason:'unavailable' }` WITHOUT stamping, so the next run
 * retries the same window.
 */
export async function syncToMemory(owner: string): Promise<SyncResult> {
  const p = prefs(owner);
  if (!p?.memory_sync_enabled) return { ok: false, reason: 'disabled' };
  if (!p.memory_account) return { ok: false, reason: 'not_connected' };
  if (!pushConnectorAvailable(owner)) return { ok: false, reason: 'unavailable' };

  // Capture the next watermark BEFORE selecting events. Stamping a timestamp taken
  // AFTER the SELECT+push would skip any row whose completed_at/updated_at fell between
  // the SELECT and the stamp — permanent data loss. Anchoring the stamp to a pre-SELECT
  // instant means such a row is < syncedAt and so is re-selected next run; a rare
  // double-push is harmless (CI-Server ingest is idempotent on source_id). No skips.
  const syncedAt = new Date().toISOString();
  const since = p.memory_last_synced_at ?? new Date(Date.now() - INITIAL_WINDOW_DAYS * 86_400_000).toISOString();
  const wantHabits = !!p.memory_sync_habits;

  // When habits are pushed, drop them from the completed-task set so a done habit isn't
  // sent twice (task_completed + habit_done). With habits OFF, completed habit tasks
  // still flow through the completed scope like any other task.
  const completed = p.memory_sync_completed ? completedTaskEvents(owner, since, wantHabits) : [];
  const habits = wantHabits ? habitEvents(owner, since) : [];
  const reflections = p.memory_sync_reflections ? reflectionEvents(owner, since) : [];
  const events = [...completed, ...habits, ...reflections];

  let ingest;
  try {
    ingest = await postEvents(owner, events);
  } catch (err) {
    if (err instanceof MemoryUnavailable) {
      logger.warn('memory sync: CI-Server unavailable — skipping (watermark not advanced)', { owner, err: err.message });
      return { ok: false, reason: 'unavailable' };
    }
    throw err;
  }

  // Stamp the pre-SELECT instant (see above) — never a fresh "now" that could leapfrog
  // events that occurred during the push.
  sqlite.prepare(`UPDATE scheduling_prefs SET memory_last_synced_at = ? WHERE owner_id = ?`).run(syncedAt, owner);
  const counts: SyncCounts = {
    completed: completed.length,
    habits: habits.length,
    reflections: reflections.length,
    ingested: ingest.ingested,
    duplicate: ingest.duplicate,
    rejected: ingest.rejected,
  };
  // 'off' can't reach here: memoryCreds returns null in off mode, so the
  // pushConnectorAvailable guard above already returned 'unavailable'. A successful
  // push therefore always rode a real transport — live or fixture.
  const transport = memoryMode() === 'fixture' ? ('fixture' as const) : ('live' as const);
  logger.info('memory sync done', { owner, transport, ...counts });
  return { ok: true, syncedAt, counts, transport };
}
