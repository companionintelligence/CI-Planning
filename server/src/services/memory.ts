/**
 * Companion Memory service. Two directions, two states of doneness:
 *
 * PULL (Phase AA · AA0 — real): the CI-Server `companion-memory` connector
 * (connectors/memory.ts) resolves per-owner creds and `memoryConnectorAvailable()`
 * reflects it truthfully; the pull surface (memory_pull_enabled flag + the AA1
 * suggest agent) rides it.
 *
 * PUSH (AA4 — still the honest stub): the toggle, scopes, and connection state are
 * real and persisted in `scheduling_prefs`, but the actual push lands with AA4 —
 * so `pushConnectorAvailable()` is false and `syncToMemory` reports `unavailable`.
 */
import { sqlite } from '../db/index.js';
import { memoryCreds, type MemoryCredsSource } from '../connectors/memory.js';

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

/**
 * Whether the PUSH backend is wired. Still the honest stub — the one-way push is
 * AA4; keeping this false stops `syncToMemory` from stamping a fake success now
 * that pull creds can resolve.
 */
function pushConnectorAvailable(): boolean {
  return false;
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
      host,
    },
  };
}

export type SyncResult =
  | { ok: true; syncedAt: string; counts: Record<string, number> }
  | { ok: false; reason: 'disabled' | 'not_connected' | 'unavailable' };

/**
 * Push enabled scopes to Companion Memory. Guards (off / not connected) are real;
 * the push is stubbed until AA4 lands. On success it records
 * `memory_last_synced_at` — the only branch unreachable today.
 */
export function syncToMemory(owner: string): SyncResult {
  const p = prefs(owner);
  if (!p?.memory_sync_enabled) return { ok: false, reason: 'disabled' };
  if (!p.memory_account) return { ok: false, reason: 'not_connected' };
  if (!pushConnectorAvailable()) return { ok: false, reason: 'unavailable' };

  // (Reachable once Phase I wires the connector.) Build the scoped payload, push
  // it, then stamp the sync time.
  const syncedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE scheduling_prefs SET memory_last_synced_at = ? WHERE owner_id = ?`).run(syncedAt, owner);
  return { ok: true, syncedAt, counts: {} };
}
