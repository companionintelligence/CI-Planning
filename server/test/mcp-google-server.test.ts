import { describe, it, expect } from 'vitest';
import {
  createCalendarHandlers,
  mapGoogleEvent,
  toGoogleDate,
  type ToolResult,
} from '../src/mcp/google-server.js';

/** A scripted fetch: each call shifts the next response and records the request. */
interface Call {
  url: string;
  init?: RequestInit;
}
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() {
        return r.body;
      },
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      },
    };
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const structured = (r: ToolResult) => r.structuredContent as Record<string, any>;
const headerOf = (init: RequestInit | undefined, name: string) =>
  (init?.headers as Record<string, string> | undefined)?.[name];

describe('mappers', () => {
  it('maps a timed event', () => {
    const e = mapGoogleEvent({
      id: 'e1',
      summary: 'Standup',
      etag: 'W/"1"',
      start: { dateTime: '2026-06-24T09:00:00Z' },
      end: { dateTime: '2026-06-24T09:15:00Z' },
    });
    expect(e).toMatchObject({ id: 'e1', title: 'Standup', start: '2026-06-24T09:00:00Z', etag: 'W/"1"' });
    expect(e.allDay).toBeUndefined();
    expect(e.deleted).toBeUndefined();
  });

  it('flags an all-day event from a date-only start', () => {
    const e = mapGoogleEvent({ id: 'e2', summary: 'Holiday', start: { date: '2026-07-04' }, end: { date: '2026-07-05' } });
    expect(e).toMatchObject({ allDay: true, start: '2026-07-04' });
  });

  it('flags a cancelled event as deleted (R3 tombstone) even with no times', () => {
    const e = mapGoogleEvent({ id: 'e3', status: 'cancelled', etag: 'W/"9"' });
    expect(e).toMatchObject({ id: 'e3', deleted: true });
  });

  it('toGoogleDate: timed vs all-day', () => {
    expect(toGoogleDate('2026-06-24T09:00:00Z', false)).toEqual({ dateTime: '2026-06-24T09:00:00Z', timeZone: 'UTC' });
    expect(toGoogleDate('2026-07-04T00:00:00.000Z', true)).toEqual({ date: '2026-07-04' });
    expect(toGoogleDate('2026-07-04', true)).toEqual({ date: '2026-07-04' });
  });
});

describe('calendar_list_events', () => {
  it('full window: sends timeMin/timeMax + orderBy, maps items, returns nextSyncToken', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: {
          items: [{ id: 'e1', summary: 'A', start: { dateTime: '2026-06-24T09:00:00Z' }, end: { dateTime: '2026-06-24T10:00:00Z' }, etag: 'W/"1"' }],
          nextSyncToken: 'tok-1',
        },
      },
    ]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.listEvents({ timeMin: '2026-06-01T00:00:00Z', timeMax: '2026-06-30T00:00:00Z' });

    const u = new URL(calls[0].url);
    expect(u.searchParams.get('timeMin')).toBe('2026-06-01T00:00:00Z');
    expect(u.searchParams.get('orderBy')).toBe('startTime');
    expect(u.searchParams.get('syncToken')).toBeNull();
    expect(headerOf(calls[0].init, 'Authorization')).toBe('Bearer AT');
    expect(structured(r)).toMatchObject({ nextSyncToken: 'tok-1', expired: false });
    expect(structured(r).events[0]).toMatchObject({ id: 'e1', title: 'A' });
  });

  it('incremental: sends syncToken + showDeleted (not timeMin) and surfaces tombstones', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: {
          items: [{ id: 'gone', status: 'cancelled', etag: 'W/"5"' }],
          nextSyncToken: 'tok-2',
        },
      },
    ]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.listEvents({ syncToken: 'tok-1' });

    const u = new URL(calls[0].url);
    expect(u.searchParams.get('syncToken')).toBe('tok-1');
    expect(u.searchParams.get('showDeleted')).toBe('true');
    expect(u.searchParams.get('timeMin')).toBeNull();
    expect(structured(r).events[0]).toMatchObject({ id: 'gone', deleted: true });
    expect(structured(r).nextSyncToken).toBe('tok-2');
  });

  it('drains pages and captures nextSyncToken from the last page', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { items: [{ id: 'p1', start: { dateTime: 'x' }, end: { dateTime: 'y' } }], nextPageToken: 'pg2' } },
      { status: 200, body: { items: [{ id: 'p2', start: { dateTime: 'x' }, end: { dateTime: 'y' } }], nextSyncToken: 'final' } },
    ]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.listEvents({});
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get('pageToken')).toBe('pg2');
    expect(structured(r).events.map((e: any) => e.id)).toEqual(['p1', 'p2']);
    expect(structured(r).nextSyncToken).toBe('final');
  });

  it('410 (stale syncToken) → { expired: true }', async () => {
    const { fetchImpl } = stubFetch([{ status: 410, body: 'Sync token is no longer valid' }]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.listEvents({ syncToken: 'old' });
    expect(structured(r)).toEqual({ events: [], expired: true });
  });
});

describe('calendar_create_event', () => {
  it('passes idempotencyKey as the event id and maps the result', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { id: 'cpabc', summary: 'Task', start: { dateTime: 's' }, end: { dateTime: 'e' }, etag: 'W/"1"' } },
    ]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.createEvent({ title: 'Task', start: '2026-06-24T09:00:00Z', end: '2026-06-24T10:00:00Z', idempotencyKey: 'cpabc' });
    expect(JSON.parse(String(calls[0].init!.body)).id).toBe('cpabc');
    expect(structured(r)).toMatchObject({ id: 'cpabc', title: 'Task', etag: 'W/"1"' });
  });

  it('409 (duplicate id) → isError carrying "409" (drives the connector read-back, I7)', async () => {
    const { fetchImpl } = stubFetch([{ status: 409, body: 'duplicate' }]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.createEvent({ title: 'T', start: 's', end: 'e', idempotencyKey: 'cpdup' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('409');
  });
});

describe('calendar_update_event', () => {
  it('sends If-Match from ifMatch and maps the result', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { id: 'e1', summary: 'Updated', start: { dateTime: 's' }, end: { dateTime: 'e' }, etag: 'W/"2"' } },
    ]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.updateEvent({ id: 'e1', title: 'Updated', start: 's', end: 'e', ifMatch: 'W/"1"' });
    expect(headerOf(calls[0].init, 'If-Match')).toBe('W/"1"');
    expect(calls[0].init!.method).toBe('PUT');
    expect(structured(r)).toMatchObject({ title: 'Updated', etag: 'W/"2"' });
  });

  it('412 (etag conflict) → isError carrying "412" (drives EtagConflictError, I12)', async () => {
    const { fetchImpl } = stubFetch([{ status: 412, body: 'precondition failed' }]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.updateEvent({ id: 'e1', title: 'X', start: 's', end: 'e', ifMatch: 'stale' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('412');
  });

  it('omits If-Match when ifMatch is null', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { id: 'e1', start: { dateTime: 's' }, end: { dateTime: 'e' } } }]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    await h.updateEvent({ id: 'e1', title: 'X', start: 's', end: 'e', ifMatch: null });
    expect(headerOf(calls[0].init, 'If-Match')).toBeUndefined();
  });
});

describe('calendar_delete_event', () => {
  it('204 → ok', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204, body: '' }]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.deleteEvent({ id: 'e1', ifMatch: 'W/"1"' });
    expect(r.isError).toBeUndefined();
    expect(headerOf(calls[0].init, 'If-Match')).toBe('W/"1"');
  });

  it('404/410 (already gone) → ok (idempotent)', async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = stubFetch([{ status, body: 'gone' }]);
      const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
      const r = await h.deleteEvent({ id: 'e1', ifMatch: null });
      expect(r.isError).toBeUndefined();
    }
  });

  it('412 → isError carrying "412"', async () => {
    const { fetchImpl } = stubFetch([{ status: 412, body: 'conflict' }]);
    const h = createCalendarHandlers({ fetchImpl, token: 'AT' });
    const r = await h.deleteEvent({ id: 'e1', ifMatch: 'stale' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('412');
  });
});
