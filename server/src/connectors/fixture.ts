import { randomUUID } from 'node:crypto';
import type { CalendarConnector, RemoteEvent, RemoteEventInput, ListEventsResult, ListEventsOpts } from './base.js';
import { EtagConflictError } from './base.js';

/** Opaque sync-token prefix. A token not carrying this prefix is treated as unknown → expired. */
const TOKEN_PREFIX = 'fixtok-v';

/** An event record plus the monotonic version at which it last changed. */
interface VersionedEvent {
  event: RemoteEvent;
  /** Version at which this event was created or last updated (used for incremental diffs). */
  version: number;
  /** The idempotency key that minted this event, if any (so a repeat key returns it). */
  idempotencyKey?: string;
}

/** A retained tombstone for an event deleted at a given version (incremental delete signal). */
interface Tombstone {
  id: string;
  start: string;
  end: string;
  version: number;
}

/**
 * In-memory fixture connector for tests. A FAITHFUL double for the real Google connector
 * across BOTH idempotency (createEvent honors input.idempotencyKey) AND incremental sync
 * (a monotonic version counter drives full vs incremental listEvents with tombstones).
 * No network, no token store. Stateful across calls — seed events, then run syncConnector,
 * then assert.
 *
 * Sync-token contract (consumed by WP5):
 *  - listEvents() with NO syncToken → FULL cycle: { events: [all live events],
 *    nextSyncToken: <token@currentVersion> }.
 *  - listEvents({ syncToken }) → INCREMENTAL: { events: [events created/updated since the
 *    token's version] PLUS a tombstone { id, start, end, etag:null, deleted:true } for each
 *    event deleted since that version], nextSyncToken: <token@currentVersion> }.
 *  - An unknown / unparseable syncToken → { events: [], expired: true } (simulates Google's
 *    410 → caller re-inits with a full window). from/to bounds still apply to full cycles.
 */
export class FixtureConnector implements CalendarConnector {
  readonly mode = 'fixture' as const;
  readonly provider: string;
  readonly account: string;

  private events = new Map<string, VersionedEvent>();
  /** Retained tombstones keyed by external id, for incremental delete signalling. */
  private tombstones = new Map<string, Tombstone>();
  private _nextId = 0;
  /** Monotonic version, bumped on every create/update/delete. */
  private _version = 0;

  constructor(provider = 'fixture', account = 'test@fixture.local') {
    this.provider = provider;
    this.account = account;
  }

  /** Seed a pre-existing event (for test setup). Bumps the version like a create. */
  seed(event: RemoteEvent): void {
    this.events.set(event.id, { event: { ...event }, version: ++this._version });
    this.tombstones.delete(event.id);
  }

  private makeToken(): string {
    return `${TOKEN_PREFIX}${this._version}`;
  }

  /** Parse a sync token's version, or null when the token isn't one we issued. */
  private parseToken(token: string): number | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const n = Number(token.slice(TOKEN_PREFIX.length));
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  async listEvents(opts?: ListEventsOpts): Promise<ListEventsResult> {
    // ── Incremental mode (a syncToken was supplied) ──────────────────────────
    if (opts?.syncToken) {
      const since = this.parseToken(opts.syncToken);
      if (since === null) {
        // Unknown / too-old token → simulate Google 410: caller must re-init full.
        return { events: [], expired: true };
      }
      const changed: RemoteEvent[] = [];
      for (const { event, version } of this.events.values()) {
        if (version > since) changed.push({ ...event });
      }
      for (const t of this.tombstones.values()) {
        if (t.version > since) {
          changed.push({ id: t.id, title: '', start: t.start, end: t.end, etag: null, deleted: true });
        }
      }
      return { events: changed, nextSyncToken: this.makeToken() };
    }

    // ── Full mode (no syncToken) ─────────────────────────────────────────────
    let events = [...this.events.values()].map((v) => ({ ...v.event }));
    if (opts?.from) events = events.filter((e) => e.start >= opts.from!);
    if (opts?.to)   events = events.filter((e) => e.start <= opts.to!);
    return { events, nextSyncToken: this.makeToken() };
  }

  async createEvent(input: RemoteEventInput): Promise<RemoteEvent> {
    // Idempotency: a repeat key returns the existing event (no new id, size unchanged).
    if (input.idempotencyKey) {
      for (const v of this.events.values()) {
        if (v.idempotencyKey === input.idempotencyKey) return { ...v.event };
      }
    }
    const { idempotencyKey, ...rest } = input;
    const event: RemoteEvent = { ...rest, id: `fixture-${++this._nextId}`, etag: randomUUID() };
    this.events.set(event.id, {
      event,
      version: ++this._version,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    this.tombstones.delete(event.id);
    return { ...event };
  }

  async updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent> {
    const existing = this.events.get(externalId);
    if (!existing) throw new Error(`FixtureConnector: event not found: ${externalId}`);
    if (ifMatch !== null && existing.event.etag !== ifMatch) {
      throw new EtagConflictError(externalId, existing.event.etag);
    }
    const { idempotencyKey: _ignored, ...rest } = input;
    const updated: RemoteEvent = { ...existing.event, ...rest, etag: randomUUID() };
    this.events.set(externalId, {
      event: updated,
      version: ++this._version,
      ...(existing.idempotencyKey ? { idempotencyKey: existing.idempotencyKey } : {}),
    });
    return { ...updated };
  }

  async deleteEvent(externalId: string, ifMatch: string | null): Promise<void> {
    const existing = this.events.get(externalId);
    if (!existing) return; // already gone — idempotent
    if (ifMatch !== null && existing.event.etag !== ifMatch) {
      throw new EtagConflictError(externalId, existing.event.etag);
    }
    this.events.delete(externalId);
    // Retain a tombstone so incremental queries that started before this delete see it.
    this.tombstones.set(externalId, {
      id: externalId,
      start: existing.event.start,
      end: existing.event.end,
      version: ++this._version,
    });
  }

  /** Read the connector's current in-memory event (for test assertions). */
  get(externalId: string): RemoteEvent | undefined {
    const v = this.events.get(externalId);
    return v ? { ...v.event } : undefined;
  }

  get size(): number {
    return this.events.size;
  }

  clear(): void {
    this.events.clear();
    this.tombstones.clear();
    this._nextId = 0;
    this._version = 0;
  }
}
