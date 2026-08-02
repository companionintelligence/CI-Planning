import { seal, open, loadKek } from '../lib/crypto/index.js';
import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { currentOwnerId } from '../lib/context.js';
import { logger } from '../lib/logger.js';

export interface RemoteEvent {
  id: string;
  title: string;
  start: string;   // ISO UTC
  end: string;     // ISO UTC
  etag: string | null;
  allDay?: boolean;
  /**
   * Set by listEvents when the provider reports this event as cancelled/deleted in an
   * incremental (syncToken) page. The reconciler treats a `deleted` event as a tombstone
   * (remove the local mirror) rather than an upsert. Absent/false on full listings.
   */
  deleted?: boolean;
}

export interface RemoteEventInput {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  /**
   * Caller-supplied stable key for createEvent (the local block id). The connector MUST
   * derive a DETERMINISTIC provider event id from it — `'cp' + base32(blockId)` — so a
   * retried create lands on the SAME provider event instead of duplicating it (the I7
   * idempotency invariant). When the provider returns 409 (already exists), createEvent
   * MUST read the event back and return its canonical { id, etag } (the echo-guard
   * invariant) rather than throwing. These are contracts WP4 implements.
   */
  idempotencyKey?: string;
}

/**
 * Result envelope for listEvents. `events` is the page; `nextSyncToken` is the opaque
 * cursor to pass back as opts.syncToken next cycle (incremental sync); `expired` is true
 * when the provider rejected a stale syncToken (HTTP 410) and the caller must restart with
 * a full window (no syncToken). WP1 fixture returns only `events`.
 */
export interface ListEventsResult {
  events: RemoteEvent[];
  nextSyncToken?: string | null;
  expired?: boolean;
}

/** Options for listEvents. `syncToken` selects incremental mode; `from`/`to` bound a full window. */
export interface ListEventsOpts {
  from?: string;
  to?: string;
  syncToken?: string;
}

/** Thrown by updateEvent/deleteEvent when the remote etag doesn't match ifMatch. */
export class EtagConflictError extends Error {
  constructor(
    public readonly externalId: string,
    public readonly freshEtag: string | null,
  ) {
    super(`Etag conflict on event ${externalId}`);
    this.name = 'EtagConflictError';
  }
}

export interface CalendarConnector {
  readonly provider: string;
  readonly account: string;
  readonly mode: 'fixture' | 'live';
  /** Returns a page envelope (events + optional incremental cursor / expiry signal). */
  listEvents(opts?: ListEventsOpts): Promise<ListEventsResult>;
  /**
   * Create a provider event. MUST derive a deterministic provider id from
   * input.idempotencyKey and, on a 409 conflict, read the event back and return its
   * canonical { id, etag } (the I7 + echo-guard invariants). Always returns the canonical
   * RemoteEvent so the caller can persist the mapping.
   */
  createEvent(input: RemoteEventInput): Promise<RemoteEvent>;
  /** Throws EtagConflictError if ifMatch is non-null and doesn't match the remote etag. */
  updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent>;
  /** Throws EtagConflictError if ifMatch is non-null and doesn't match the remote etag. */
  deleteEvent(externalId: string, ifMatch: string | null): Promise<void>;
  /**
   * Release any transport the connector is holding (optional — connectors backed by
   * plain HTTP have nothing to free). The Google connector holds an McpGoogleSession
   * whose child process must be reaped after each sync cycle, otherwise every 15-minute
   * run leaks one. Implementations MUST be idempotent and MUST NOT throw.
   */
  close?(): Promise<void>;
}

/**
 * Abstract base for OAuth2-backed calendar connectors. Manages the encrypted
 * token store (connection_tokens via lib/crypto). Subclasses implement the
 * provider-specific API calls.
 *
 * Stored token JSON: { accessToken, refreshToken, expiresAt (ISO) }
 */
export abstract class BaseOAuth2Client implements CalendarConnector {
  abstract readonly provider: string;
  abstract readonly account: string;
  readonly mode = 'live' as const;

  abstract listEvents(opts?: ListEventsOpts): Promise<ListEventsResult>;
  abstract createEvent(input: RemoteEventInput): Promise<RemoteEvent>;
  abstract updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent>;
  abstract deleteEvent(externalId: string, ifMatch: string | null): Promise<void>;
  protected abstract refreshToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }>;

  /**
   * In-process refresh single-flight. Keyed by (owner, provider, account): concurrent
   * getAccessToken() calls that all see the same expired token share ONE _refreshAndStore
   * promise, so the provider's refresh endpoint is hit exactly once (no refresh-token
   * stampede / race on the stored row). The entry is cleared in finally.
   */
  private static refreshInFlight = new Map<string, Promise<string>>();

  /**
   * Reconcile a refresh token across a refresh response. Google omits refresh_token on
   * subsequent refreshes, so an empty incoming value means "keep the existing one". Never
   * persist an empty refresh token (the I4 contract): throws if BOTH are empty.
   */
  static mergeRefreshToken(existing: string | null | undefined, incoming: string | null | undefined): string {
    if (incoming) return incoming;
    if (existing) return existing;
    throw new Error('mergeRefreshToken: refusing to persist an empty refresh token (I4)');
  }

  protected async getAccessToken(): Promise<string> {
    const ownerId = currentOwnerId();
    const kek = loadKek();
    const row = await store()
      .prepare(
        'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
      )
      .get<{ iv: string; auth_tag: string; ciphertext: string }>(ownerId, this.provider, this.account);
    if (!row) throw new Error(`No connection token for ${this.provider}/${this.account}`);
    const tok = JSON.parse(open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, kek)) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
    };
    if (new Date(tok.expiresAt) <= new Date()) {
      const key = `${ownerId}:${this.provider}:${this.account}`;
      let inflight = BaseOAuth2Client.refreshInFlight.get(key);
      if (!inflight) {
        inflight = this._refreshAndStore(tok.refreshToken).finally(() => {
          BaseOAuth2Client.refreshInFlight.delete(key);
        });
        BaseOAuth2Client.refreshInFlight.set(key, inflight);
      }
      return inflight;
    }
    return tok.accessToken;
  }

  private async _refreshAndStore(rt: string): Promise<string> {
    const { accessToken, expiresAt } = await this.refreshToken(rt);
    const kek = loadKek();
    const sealed = seal(JSON.stringify({ accessToken, refreshToken: rt, expiresAt }), kek);
    await store()
      .prepare(
        `UPDATE connection_tokens
         SET iv = ?, auth_tag = ?, ciphertext = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE owner_id = ? AND provider = ? AND account = ?`,
      )
      .run(sealed.iv, sealed.authTag, sealed.ciphertext, currentOwnerId(), this.provider, this.account);
    logger.info('OAuth token refreshed', { provider: this.provider, account: this.account });
    return accessToken;
  }

  /** Upsert a fresh token set — call from the OAuth callback route. */
  static async storeToken(
    provider: string,
    account: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: string },
  ): Promise<void> {
    const kek = loadKek();
    const sealed = seal(JSON.stringify(tokens), kek);
    const ownerId = currentOwnerId();
    await store()
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, provider, account) DO UPDATE SET
           iv = excluded.iv, auth_tag = excluded.auth_tag, ciphertext = excluded.ciphertext,
           updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(newId(), ownerId, provider, account, sealed.iv, sealed.authTag, sealed.ciphertext);
  }
}
