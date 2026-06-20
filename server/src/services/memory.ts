/**
 * Companion Memory sync (one-way push of planning history into the user's
 * Companion Memory). This is the **honest stub** the Settings UI talks to: the
 * toggle, scopes, and connection state are real and persisted in
 * `scheduling_prefs`, but the actual push rides the Phase I/J connector
 * (CI-Server OAuth / `tokenSource` seam), which isn't built yet — so
 * `memoryConnectorAvailable()` is false and `syncToMemory` reports `unavailable`.
 *
 * When Phase I lands, only `getConnector()` changes: it returns a real connector
 * whose `push()` sends the scoped payload and whose `isAvailable()` is true.
 */
import { sqlite } from '../db/index.js';

export interface MemoryScopes {
  completed: boolean; // completed tasks & time actuals
  habits: boolean; // habits & streaks
  reflections: boolean; // daily reflections / briefings
}

export interface MemoryStatus {
  enabled: boolean;
  connected: boolean;
  account: string | null;
  lastSyncedAt: string | null;
  /** Whether the real connector backend is wired (Phase I/J). False for now. */
  available: boolean;
  scopes: MemoryScopes;
}

interface PrefsRow {
  memory_sync_enabled: number;
  memory_account: string | null;
  memory_last_synced_at: string | null;
  memory_sync_completed: number;
  memory_sync_habits: number;
  memory_sync_reflections: number;
}

function prefs(owner: number): PrefsRow | undefined {
  return sqlite
    .prepare(
      `SELECT memory_sync_enabled, memory_account, memory_last_synced_at,
              memory_sync_completed, memory_sync_habits, memory_sync_reflections
         FROM scheduling_prefs WHERE owner_id = ?`
    )
    .get(owner) as PrefsRow | undefined;
}

/**
 * Whether the Companion Memory connector is actually available. Wired in Phase I/J
 * (the CI-Server connection / token source). Stubbed to false until then.
 */
export function memoryConnectorAvailable(): boolean {
  return false;
}

export function memoryStatus(owner: number): MemoryStatus {
  const p = prefs(owner);
  return {
    enabled: !!p?.memory_sync_enabled,
    connected: !!p?.memory_account,
    account: p?.memory_account ?? null,
    lastSyncedAt: p?.memory_last_synced_at ?? null,
    available: memoryConnectorAvailable(),
    scopes: {
      completed: !!p?.memory_sync_completed,
      habits: !!p?.memory_sync_habits,
      reflections: !!p?.memory_sync_reflections,
    },
  };
}

export type SyncResult =
  | { ok: true; syncedAt: string; counts: Record<string, number> }
  | { ok: false; reason: 'disabled' | 'not_connected' | 'unavailable' };

/**
 * Push enabled scopes to Companion Memory. Guards (off / not connected) are real;
 * the push is stubbed until the connector lands. On success it records
 * `memory_last_synced_at` — the only branch unreachable today.
 */
export function syncToMemory(owner: number): SyncResult {
  const p = prefs(owner);
  if (!p?.memory_sync_enabled) return { ok: false, reason: 'disabled' };
  if (!p.memory_account) return { ok: false, reason: 'not_connected' };
  if (!memoryConnectorAvailable()) return { ok: false, reason: 'unavailable' };

  // (Reachable once Phase I wires the connector.) Build the scoped payload, push
  // it, then stamp the sync time.
  const syncedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE scheduling_prefs SET memory_last_synced_at = ? WHERE owner_id = ?`).run(syncedAt, owner);
  return { ok: true, syncedAt, counts: {} };
}
