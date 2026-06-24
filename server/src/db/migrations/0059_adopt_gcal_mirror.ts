import type { Database } from 'better-sqlite3';
import { newId, SYSTEM_OWNER_ID } from '../../lib/ids.js';

export const id = '0059_adopt_gcal_mirror';

/**
 * Wave 0 (WP1) — I11 ADOPT (never delete). Pre-Wave-0 Google calendar mirroring wrote
 * locked 'meeting' blocks (source_kind='gcal', source_ref=<provider event id>) WITHOUT
 * an external_events identity row. The new sync layer keys on external_events, so those
 * legacy blocks would look "unknown" and be re-mirrored (duplicates) or, worse, deleted
 * as orphans. This migration ADOPTS them: for each such block lacking a mapping, insert
 * an inbound external_events row pointing at it.
 *
 * NEVER deletes a block or a mapping. Idempotent: guarded by NOT EXISTS on both
 * (provider, account, external_id) and block_id, so a re-run inserts nothing.
 *
 * time_blocks has no owner_id (single-owner era) → owner_id = SYSTEM_OWNER_ID.
 */
export function up(db: Database): void {
  const candidates = db
    .prepare(
      `SELECT tb.id AS block_id, tb.source_ref AS external_id
       FROM time_blocks tb
       WHERE tb.source_kind = 'gcal'
         AND tb.block_kind = 'meeting'
         AND tb.source_ref IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM external_events ee WHERE ee.block_id = tb.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM external_events ee
           WHERE ee.provider = 'google' AND ee.account = 'legacy' AND ee.external_id = tb.source_ref
         )`,
    )
    .all() as Array<{ block_id: string; external_id: string }>;

  if (candidates.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO external_events
       (id, owner_id, provider, account, external_id, block_id, etag, direction, last_synced_at)
     VALUES (?, ?, 'google', 'legacy', ?, ?, NULL, 'inbound', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  );

  for (const row of candidates) {
    insert.run(newId(), SYSTEM_OWNER_ID, row.external_id, row.block_id);
  }
}
