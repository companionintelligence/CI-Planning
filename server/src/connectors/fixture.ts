import { randomUUID } from 'node:crypto';
import type { CalendarConnector, RemoteEvent, RemoteEventInput, ListEventsResult, ListEventsOpts } from './base.js';
import { EtagConflictError } from './base.js';

/**
 * In-memory fixture connector for tests. Supports the full create→update→delete
 * lifecycle with etag conflict detection. No network, no token store.
 * Stateful across calls — seed events, then run syncConnector, then assert.
 */
export class FixtureConnector implements CalendarConnector {
  readonly mode = 'fixture' as const;
  readonly provider: string;
  readonly account: string;

  private events = new Map<string, RemoteEvent>();
  private _nextId = 0;

  constructor(provider = 'fixture', account = 'test@fixture.local') {
    this.provider = provider;
    this.account = account;
  }

  /** Seed a pre-existing event (for test setup). */
  seed(event: RemoteEvent): void {
    this.events.set(event.id, { ...event });
  }

  async listEvents(opts?: ListEventsOpts): Promise<ListEventsResult> {
    let events = [...this.events.values()];
    if (opts?.from) events = events.filter((e) => e.start >= opts.from!);
    if (opts?.to)   events = events.filter((e) => e.start <= opts.to!);
    return { events };
  }

  async createEvent(input: RemoteEventInput): Promise<RemoteEvent> {
    const event: RemoteEvent = { ...input, id: `fixture-${++this._nextId}`, etag: randomUUID() };
    this.events.set(event.id, event);
    return { ...event };
  }

  async updateEvent(externalId: string, input: RemoteEventInput, ifMatch: string | null): Promise<RemoteEvent> {
    const existing = this.events.get(externalId);
    if (!existing) throw new Error(`FixtureConnector: event not found: ${externalId}`);
    if (ifMatch !== null && existing.etag !== ifMatch) throw new EtagConflictError(externalId, existing.etag);
    const updated: RemoteEvent = { ...existing, ...input, etag: randomUUID() };
    this.events.set(externalId, updated);
    return { ...updated };
  }

  async deleteEvent(externalId: string, ifMatch: string | null): Promise<void> {
    const existing = this.events.get(externalId);
    if (!existing) return; // already gone — idempotent
    if (ifMatch !== null && existing.etag !== ifMatch) throw new EtagConflictError(externalId, existing.etag);
    this.events.delete(externalId);
  }

  /** Read the connector's current in-memory event (for test assertions). */
  get(externalId: string): RemoteEvent | undefined {
    return this.events.get(externalId);
  }

  get size(): number {
    return this.events.size;
  }

  clear(): void {
    this.events.clear();
    this._nextId = 0;
  }
}
