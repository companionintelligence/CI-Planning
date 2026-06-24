import type { Database } from 'better-sqlite3';

export const id = '0061_drop_unused_sync_columns';

/**
 * Wave 2 cleanup — drop speculative columns added in 0058/0060 that no code path reads:
 *  - sync_state.window_from / window_to: written by the cursor upsert but never SELECTed.
 *    The 410 re-init uses the connector's `expired` signal, not stored window bounds.
 *  - oauth_states.scopes: written at /start but unused at callback. oauth_states rows are
 *    single-use (deleted on consume) so they can't serve as an audit trail; granted scopes
 *    come back in the token response and the requested set is recomputable from config.
 *
 * SQLite (3.35+) supports ALTER TABLE ... DROP COLUMN; none of these columns are indexed
 * or part of a constraint, so the drops are safe.
 */
export function up(db: Database): void {
  db.exec(`
    ALTER TABLE sync_state DROP COLUMN window_from;
    ALTER TABLE sync_state DROP COLUMN window_to;
    ALTER TABLE oauth_states DROP COLUMN scopes;
  `);
}
