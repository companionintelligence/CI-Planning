import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { config } from '../lib/config.js';
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
 * No-op when writeback is disabled (CP_SYNC_WRITEBACK off) or when the block is
 * an inbound calendar mirror — we never push meeting mirrors back (I9).
 */
export function enqueueOutbound(blockId: string): void {
  if (!config.sync.writeback) return;
  // I9: inbound-mirrored blocks must never be pushed back to the provider. Checked
  // inside this function (not only at call sites) so future callers can't bypass it.
  const isInbound = sqlite
    .prepare(`SELECT 1 FROM external_events WHERE block_id = ? AND direction = 'inbound'`)
    .get(blockId);
  if (isInbound) return;
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
 * Mirror remote events as locked meeting blocks. Identity: (provider, account, external_id)
 * + etag. This is the SINGLE canonical inbound path (ingest.ts no longer mirrors events).
 *
 * `cycle` gates how deletes are detected:
 *  - 'incremental' — a syncToken page carries explicit tombstones ({ deleted:true }). We
 *    delete exactly the tombstoned inbound blocks (their external_events mapping cascades).
 *  - 'full' — a full (no-token) listing. I8: we DO NOT run an absence-based delete sweep.
 *    An event merely absent from this page (e.g. filtered out by the window, or paged) is
 *    NOT a delete signal; only an incremental tombstone deletes. A full cycle never removes
 *    an inbound mapping.
 */
function applyInbound(
  connector: CalendarConnector,
  remoteEvents: RemoteEvent[],
  ownerId: string,
  result: SyncResult,
  cycle: 'full' | 'incremental',
): void {
  for (const event of remoteEvents) {
    // ── Tombstone (incremental delete signal) ──────────────────────────────
    if (event.deleted) {
      // I8: only an INCREMENTAL cycle deletes. A full cycle never carries tombstones, but
      // guard anyway so an absent/stale event can never trigger a delete on a full re-init.
      if (cycle !== 'incremental') continue;
      const mapping = sqlite
        .prepare(
          `SELECT block_id FROM external_events
           WHERE provider = ? AND account = ? AND external_id = ? AND direction = 'inbound' AND owner_id = ?`,
        )
        .get(connector.provider, connector.account, event.id, ownerId) as { block_id: string } | undefined;
      if (mapping) {
        // Deleting the block cascades the external_events mapping (ON DELETE CASCADE).
        sqlite.prepare('DELETE FROM time_blocks WHERE id = ?').run(mapping.block_id);
        result.deleted++;
      }
      continue;
    }

    // Fetch any existing mapping for this external_id regardless of direction.
    // Outbound rows mean we pushed this event — skip creating an inbound mirror.
    const mapping = sqlite
      .prepare(
        'SELECT id, block_id, etag, direction FROM external_events WHERE provider = ? AND account = ? AND external_id = ?',
      )
      .get(connector.provider, connector.account, event.id) as
      | { id: string; block_id: string; etag: string | null; direction: string }
      | undefined;

    if (!mapping) {
      // Atomic: the block mirror and its identity mapping must commit together. A
      // partial commit (block without mapping) would orphan the block AND let the next
      // cycle re-insert a duplicate — the 0027 unique index covers only 'gmail'/'gcal',
      // not the 'google' source_kind used here, so nothing else dedupes it.
      const blockId = newId();
      sqlite.transaction(() => {
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
      })();
      result.created++;
    } else if (mapping.direction === 'inbound' && event.etag !== mapping.etag) {
      // Inbound event changed remotely — update the local mirror + its etag atomically.
      sqlite.transaction(() => {
        sqlite
          .prepare(`UPDATE time_blocks SET title = ?, start_at = ?, end_at = ? WHERE id = ?`)
          .run(event.title, event.start, event.end, mapping.block_id);
        sqlite
          .prepare(
            `UPDATE external_events SET etag = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          )
          .run(event.etag ?? null, mapping.id);
      })();
      result.updated++;
    }
    // direction='outbound' or etag unchanged → no-op
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
  if (!config.sync.writeback) return;
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
    // I7: stable idempotency key → connector derives cp+base32hex(blockId) provider event id
    const input = { title: row.title, start: row.start_at, end: row.end_at, allDay: row.all_day === 1, idempotencyKey: row.block_id };
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
        // Remote changed since last sync — record fresh etag, remove from queue.
        // I12: clear the incremental cursor so the next sync cycle does a full re-pull
        // and overwrites the local block with the authoritative remote state.
        result.conflicts++;
        if (existing && err.freshEtag !== null) {
          sqlite
            .prepare(`UPDATE external_events SET etag = ? WHERE id = ?`)
            .run(err.freshEtag, existing.id);
        }
        clearCalendarCursor(connector, ownerId);
        sqlite.prepare('DELETE FROM outbound_queue WHERE id = ?').run(row.queue_id);
        logger.warn('outbound etag conflict — remote wins; cursor cleared for re-pull', {
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

// ─── Calendar incremental cursor (sync_state, resource='calendar_synctoken') ──

const CALENDAR_SYNCTOKEN = 'calendar_synctoken';

/** Read the stored incremental syncToken for (owner, provider, account), or null. */
function readCalendarCursor(connector: CalendarConnector, ownerId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = ?`,
    )
    .get(ownerId, connector.provider, connector.account, CALENDAR_SYNCTOKEN) as
    | { cursor: string | null }
    | undefined;
  return row?.cursor ?? null;
}

/** Persist the next incremental syncToken (advance-after-commit). Null clears it. */
function writeCalendarCursor(
  connector: CalendarConnector,
  ownerId: string,
  cursor: string | null,
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, provider, account, resource) DO UPDATE SET
         cursor = excluded.cursor,
         updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
    .run(
      newId(),
      ownerId,
      connector.provider,
      connector.account,
      CALENDAR_SYNCTOKEN,
      cursor,
    );
}

/** Clear the stored cursor (e.g. after the provider rejects it as expired). */
function clearCalendarCursor(connector: CalendarConnector, ownerId: string): void {
  sqlite
    .prepare(
      `DELETE FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = ?`,
    )
    .run(ownerId, connector.provider, connector.account, CALENDAR_SYNCTOKEN);
}

// ─── Public sync API ──────────────────────────────────────────────────────────

/**
 * Run one sync cycle for a single connector.
 *
 * Inbound mode is chosen by the stored cursor:
 *  - cursor present → INCREMENTAL: listEvents({ syncToken }). If the provider reports the
 *    token expired (HTTP 410 → { expired:true }), clear it and re-list FULL, treated as a
 *    full cycle (I8: no deletes on the re-init).
 *  - no cursor → FULL: listEvents({ from, to }) over the bounded window.
 * The returned nextSyncToken is persisted only after applyInbound succeeds (advance-after-
 * commit), so a mid-cycle throw replays the same window/token next time.
 */
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
  const window = syncWindow();

  try {
    const storedCursor = readCalendarCursor(connector, ownerId);

    let cycle: 'full' | 'incremental';
    let page: Awaited<ReturnType<CalendarConnector['listEvents']>>;

    if (storedCursor) {
      page = await connector.listEvents({ syncToken: storedCursor });
      if (page.expired) {
        // Provider rejected the stale token — drop it and re-init with a full window.
        clearCalendarCursor(connector, ownerId);
        page = await connector.listEvents({ from: window.from, to: window.to });
        cycle = 'full';
      } else {
        cycle = 'incremental';
      }
    } else {
      page = await connector.listEvents({ from: window.from, to: window.to });
      cycle = 'full';
    }

    applyInbound(connector, page.events, ownerId, result, cycle);

    // Persist the new cursor only after applyInbound committed (advance-after-commit). A
    // full re-init that itself returned no token leaves the cursor cleared → next cycle
    // re-inits full again. We never persist a null/undefined over a good token here because
    // the only path that nulls it is the explicit clearCalendarCursor above.
    if (page.nextSyncToken != null) {
      writeCalendarCursor(connector, ownerId, page.nextSyncToken);
    }

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
