import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { broadcast } from '../routes/sse.js';
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

// ─── Mutation hooks (called from blocks route) ────────────────────────────────

/**
 * Enqueue a block for outbound push to every active connector for this owner.
 * ON CONFLICT refreshes created_at so a rapid edit doesn't add duplicate rows.
 * No-op when the owner has no registered connectors.
 */
export function enqueueOutbound(blockId: string): void {
  const ownerId = currentOwnerId();
  for (const c of getConnectors()) {
    sqlite
      .prepare(
        `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
         VALUES (uuid7(), ?, ?, ?, ?)
         ON CONFLICT(block_id, provider, account) DO UPDATE SET created_at = CURRENT_TIMESTAMP`,
      )
      .run(ownerId, blockId, c.provider, c.account);
  }
}

/**
 * Before deleting a block, push remote deletes for every outbound external_events
 * mapping. Errors are logged but do not block the local delete.
 */
export async function pushOutboundDeletes(blockId: string): Promise<void> {
  const outbound = sqlite
    .prepare(
      `SELECT provider, account, external_id, etag
       FROM external_events WHERE block_id = ? AND direction = 'outbound'`,
    )
    .all(blockId) as { provider: string; account: string; external_id: string; etag: string | null }[];

  if (outbound.length === 0) return;

  const connectors = getConnectors();
  for (const row of outbound) {
    const connector = connectors.find((c) => c.provider === row.provider && c.account === row.account);
    if (!connector) continue;
    try {
      await connector.deleteEvent(row.external_id, row.etag);
    } catch (err) {
      logger.warn('remote delete failed — local delete proceeding', {
        provider: row.provider,
        externalId: row.external_id,
        err: (err as Error).message,
      });
    }
  }
}

// ─── Inbound reconcile ────────────────────────────────────────────────────────

/**
 * Mirror remote events as locked meeting blocks.
 * Identity: (provider, account, external_id) + etag.
 * Remote-deleted events: inbound mappings absent from this cycle → local block deleted
 * (ON DELETE CASCADE on external_events.block_id removes the mapping row too).
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

  // Remote deletes: inbound mappings not present in this cycle
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

// ─── Outbound reconcile ───────────────────────────────────────────────────────

/**
 * Process outbound_queue: for each pending block, push to the provider.
 * If external_events already has a row for this block → updateEvent.
 * If not → createEvent, then write the external_events row.
 * On EtagConflictError → remote wins; record fresh etag.
 * On transient error → leave in queue for next cycle retry.
 */
async function applyOutbound(
  connector: CalendarConnector,
  ownerId: string,
  result: SyncResult,
): Promise<void> {
  const queued = sqlite
    .prepare(
      `SELECT oq.id AS queue_id, oq.block_id,
              tb.title, tb.start_at, tb.end_at, tb.all_day
       FROM outbound_queue oq
       JOIN time_blocks tb ON tb.id = oq.block_id
       WHERE oq.provider = ? AND oq.account = ? AND oq.owner_id = ?`,
    )
    .all(connector.provider, connector.account, ownerId) as Array<{
      queue_id: string;
      block_id: string;
      title: string;
      start_at: string;
      end_at: string;
      all_day: number;
    }>;

  for (const row of queued) {
    const input = { title: row.title, start: row.start_at, end: row.end_at, allDay: row.all_day === 1 };
    const existing = sqlite
      .prepare(
        `SELECT id, external_id, etag FROM external_events
         WHERE block_id = ? AND provider = ? AND account = ? AND direction = 'outbound'`,
      )
      .get(row.block_id, connector.provider, connector.account) as
      | { id: string; external_id: string; etag: string | null }
      | undefined;

    try {
      if (existing) {
        const updated = await connector.updateEvent(existing.external_id, input, existing.etag);
        sqlite
          .prepare(
            `UPDATE external_events SET etag = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          )
          .run(updated.etag ?? null, existing.id);
        result.updated++;
      } else {
        const created = await connector.createEvent(input);
        sqlite
          .prepare(
            `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, etag, direction, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'outbound', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          )
          .run(newId(), ownerId, connector.provider, connector.account, created.id, row.block_id, created.etag ?? null);
        result.created++;
      }
      // Remove from queue on success
      sqlite.prepare('DELETE FROM outbound_queue WHERE id = ?').run(row.queue_id);
    } catch (err) {
      if (err instanceof EtagConflictError) {
        // Remote changed since last sync — record fresh etag; retry next cycle with it.
        result.conflicts++;
        if (existing && err.freshEtag !== null) {
          sqlite
            .prepare(`UPDATE external_events SET etag = ? WHERE id = ?`)
            .run(err.freshEtag, existing.id);
        }
        sqlite.prepare('DELETE FROM outbound_queue WHERE id = ?').run(row.queue_id);
        logger.warn('outbound etag conflict — remote wins', {
          provider: connector.provider,
          externalId: existing?.external_id,
          freshEtag: err.freshEtag,
        });
      } else {
        // Transient error — leave in queue for next cycle
        result.errors.push((err as Error).message);
        logger.error('outbound push failed — will retry', {
          provider: connector.provider,
          blockId: row.block_id,
          err: (err as Error).message,
        });
      }
    }
  }
}

// ─── Public sync API ──────────────────────────────────────────────────────────

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

/** Sync all connectors registered for the current owner. Broadcasts SSE events. */
export async function syncAll(): Promise<SyncResult[]> {
  const connectors = getConnectors();
  if (connectors.length === 0) {
    logger.debug('syncAll: no connectors registered for this owner');
    return [];
  }

  const ownerId = currentOwnerId();
  broadcast(ownerId, 'sync:started', { connectors: connectors.map((c) => `${c.provider}/${c.account}`) });

  const results: SyncResult[] = [];
  for (const connector of connectors) {
    const r = await syncConnector(connector);
    results.push(r);
    broadcast(ownerId, 'sync:done', {
      provider: r.provider,
      account: r.account,
      created: r.created,
      updated: r.updated,
      deleted: r.deleted,
      conflicts: r.conflicts,
      errors: r.errors,
    });
  }

  return results;
}
