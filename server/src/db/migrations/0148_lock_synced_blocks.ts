import type { Database } from 'better-sqlite3';

export const id = '0148_lock_synced_blocks';

/**
 * Focus × Time Blocks, Phase 1 — L00: a synced calendar event is locked, always.
 *
 * The source calendar owns its time; the app never moves it. `agents/sync.ts` has
 * stamped `is_locked = 1` on inbound mirrors since before the multi-tenant migration,
 * so the ongoing path is already correct — this backfills the rows that predate or
 * bypass it, and makes the invariant true of the whole table rather than only of
 * blocks created by the current code:
 *
 *  - blocks ADOPTED by 0059 (pre-Wave-0 gcal mirrors, which got an external_events
 *    identity row but were never re-examined for lock state);
 *  - rows restored from a backup taken before this rule existed;
 *  - anything a fixture or an older seed inserted unlocked.
 *
 * Scoped to INBOUND mappings: an outbound row is a local block we push TO a calendar,
 * and the owner still owns its time — locking those would freeze the owner's own
 * blocks. Idempotent (the UPDATE is a no-op once locked), and it never unlocks
 * anything, so a deliberate lock elsewhere survives.
 */
export function up(db: Database): void {
  db.exec(`
    UPDATE time_blocks
       SET is_locked = 1
     WHERE is_locked = 0
       AND id IN (SELECT block_id FROM external_events WHERE direction = 'inbound')
  `);
}
