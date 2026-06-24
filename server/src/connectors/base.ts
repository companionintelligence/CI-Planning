import { seal, open, loadKek } from '../lib/crypto/index.js';
import { sqlite } from '../db/index.js';
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
}

export interface RemoteEventInput {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
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
  listEvents(opts?: { from?: string; to?: string }): Promise<RemoteEvent[]>;
  createEvent(input: RemoteEventInput): Promise<RemoteEvent>;
  /** Throws EtagConflictError if ifMatch is non-null and doesn't match the remote etag. */
  updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent>;
  /** Throws EtagConflictError if ifMatch is non-null and doesn't match the remote etag. */
  deleteEvent(externalId: string, ifMatch: string | null): Promise<void>;
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

  abstract listEvents(opts?: { from?: string; to?: string }): Promise<RemoteEvent[]>;
  abstract createEvent(input: RemoteEventInput): Promise<RemoteEvent>;
  abstract updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent>;
  abstract deleteEvent(externalId: string, ifMatch: string | null): Promise<void>;
  protected abstract refreshToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }>;

  protected async getAccessToken(): Promise<string> {
    const ownerId = currentOwnerId();
    const kek = loadKek();
    const row = sqlite
      .prepare(
        'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
      )
      .get(ownerId, this.provider, this.account) as
      | { iv: string; auth_tag: string; ciphertext: string }
      | undefined;
    if (!row) throw new Error(`No connection token for ${this.provider}/${this.account}`);
    const tok = JSON.parse(open({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }, kek)) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
    };
    if (new Date(tok.expiresAt) <= new Date()) {
      return this._refreshAndStore(tok.refreshToken);
    }
    return tok.accessToken;
  }

  private async _refreshAndStore(rt: string): Promise<string> {
    const { accessToken, expiresAt } = await this.refreshToken(rt);
    const kek = loadKek();
    const sealed = seal(JSON.stringify({ accessToken, refreshToken: rt, expiresAt }), kek);
    sqlite
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
  static storeToken(
    provider: string,
    account: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: string },
  ): void {
    const kek = loadKek();
    const sealed = seal(JSON.stringify(tokens), kek);
    const ownerId = currentOwnerId();
    sqlite
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
