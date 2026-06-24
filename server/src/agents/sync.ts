import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import type { CalendarConnector, RemoteEvent } from '../connectors/base.js';
import { EtagConflictError } from '../connectors/base.js';
import { getConnectors } from '../connectors/index.js';

export interface SyncResult {
  provider: string;
  account: string;
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
  errors: string[];
}

const WINDOW_PAST_DAYS   = 7;
const WINDOW_FUTURE_DAYS = 30;

function syncWindow(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - WINDOW_PAST_DAYS);
  const to = new Date(now);
  to.setDate(to.getDate() + WINDOW_FUTURE_DAYS);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Inbound reconcile: mirror remote events as locked meeting blocks.
 * Identity key: (provider, account, external_id). Change detected by etag.
 * Remote deletes: any inbound mapping not seen in this cycle → delete local block
 * (ON DELETE CASCADE on external_events.block_id cleans up the mapping row).
 */
function applyInbound(
  connector: CalendarConnector,
  remoteEvents: RemoteEvent[],
  ownerId: string,
  result: SyncResult,
): void {
  const seenIds = new Set(remoteEvents.map((e) => e.id));

  for (const event of remoteEvents) {
    const mapping = sqlite
      .prepare(
        'SELECT id, block_id, etag FROM external_events WHERE provider = ? AND account = ? AND external_id = ?',
      )
      .get(connector.provider, connector.account, event.id) as
      | { id: string; block_id: string; etag: string | null }
      | undefined;

    if (!mapping) {
      const blockId = newId();
      sqlite
        .prepare(
          `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, source_ref, status)
           VALUES (?, NULL, ?, 'meeting', ?, ?, 1, 0, ?, ?, 'planned')`,
        )
        .run(blockId, event.title, event.start, event.end, connector.provider, event.id);
      sqlite
        .prepare(
          `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, etag, direction, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        )
        .run(newId(), ownerId, connector.provider, connector.account, event.id, blockId, event.etag ?? null);
      result.created++;
    } else if (event.etag !== mapping.etag) {
      sqlite
        .prepare(`UPDATE time_blocks SET title = ?, start_at = ?, end_at = ? WHERE id = ?`)
        .run(event.title, event.start, event.end, mapping.block_id);
      sqlite
        .prepare(
          `UPDATE external_events SET etag = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(event.etag ?? null, mapping.id);
      result.updated++;
    }
    // etag unchanged → no-op
  }

  // Detect remote deletes: inbound mappings not present in this sync window
  const allInbound = sqlite
    .prepare(
      `SELECT block_id, external_id FROM external_events
       WHERE provider = ? AND account = ? AND direction = 'inbound' AND owner_id = ?`,
    )
    .all(connector.provider, connector.account, ownerId) as { block_id: string; external_id: string }[];

  for (const row of allInbound) {
    if (!seenIds.has(row.external_id)) {
      sqlite.prepare('DELETE FROM time_blocks WHERE id = ?').run(row.block_id);
      result.deleted++;
    }
  }
}

/**
 * Outbound reconcile: re-push all blocks with outbound external_events mappings.
 * Etag conflict → remote wins (deterministic resolution); freshEtag is recorded.
 * New outbound blocks are created by block mutation hooks (PR J-3).
 */
async function applyOutbound(
  connector: CalendarConnector,
  ownerId: string,
  result: SyncResult,
): Promise<void> {
  const outbound = sqlite
    .prepare(
      `SELECT ee.id AS mapping_id, ee.external_id, ee.etag,
              tb.title, tb.start_at, tb.end_at, tb.all_day
       FROM external_events ee
       JOIN time_blocks tb ON tb.id = ee.block_id
       WHERE ee.provider = ? AND ee.account = ? AND ee.direction = 'outbound' AND ee.owner_id = ?`,
    )
    .all(connector.provider, connector.account, ownerId) as Array<{
      mapping_id: string;
      external_id: string;
      etag: string | null;
      title: string;
      start_at: string;
      end_at: string;
      all_day: number;
    }>;

  for (const row of outbound) {
    const input = { title: row.title, start: row.start_at, end: row.end_at, allDay: row.all_day === 1 };
    try {
      const updated = await connector.updateEvent(row.external_id, input, row.etag);
      sqlite
        .prepare(
          `UPDATE external_events SET etag = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(updated.etag ?? null, row.mapping_id);
      result.updated++;
    } catch (err) {
      if (err instanceof EtagConflictError) {
        // Remote changed since last sync — remote wins; record its etag.
        result.conflicts++;
        if (err.freshEtag !== null) {
          sqlite
            .prepare(`UPDATE external_events SET etag = ? WHERE id = ?`)
            .run(err.freshEtag, row.mapping_id);
        }
        logger.warn('outbound etag conflict — remote wins', {
          provider: connector.provider,
          externalId: row.external_id,
          freshEtag: err.freshEtag,
        });
      } else {
        result.errors.push((err as Error).message);
        logger.error('outbound sync error', {
          provider: connector.provider,
          externalId: row.external_id,
          err: (err as Error).message,
        });
      }
    }
  }
}

/** Run a full sync cycle for a single connector. */
export async function syncConnector(connector: CalendarConnector): Promise<SyncResult> {
  const result: SyncResult = {
    provider: connector.provider,
    account: connector.account,
    created: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    errors: [],
  };

  const ownerId = currentOwnerId();
  const { from, to } = syncWindow();

  try {
    const remoteEvents = await connector.listEvents({ from, to });
    applyInbound(connector, remoteEvents, ownerId, result);
    await applyOutbound(connector, ownerId, result);
  } catch (err) {
    result.errors.push((err as Error).message);
    logger.error('syncConnector failed', {
      provider: connector.provider,
      account: connector.account,
      err: (err as Error).message,
    });
  }

  logger.info('syncConnector done', { ...result });
  return result;
}

/** Sync all connectors registered for the current owner. */
export async function syncAll(): Promise<SyncResult[]> {
  const connectors = getConnectors();
  if (connectors.length === 0) {
    logger.debug('syncAll: no connectors registered for this owner');
    return [];
  }
  const results: SyncResult[] = [];
  for (const connector of connectors) {
    results.push(await syncConnector(connector));
  }
  return results;
}
