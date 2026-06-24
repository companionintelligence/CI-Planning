import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Google Calendar MCP **server** logic — the counterpart CP's MCP *client*
 * (server/src/mcp/client.ts) spawns and drives over stdio. This module is import-safe
 * (no transport, no process I/O, no top-level side effects) so the entire CP-specific
 * contract is unit-testable with a stubbed fetch. The thin stdio entry that actually
 * spawns lives in server/src/scripts/mcp-google-server.ts.
 *
 * Tools exposed (the 4 calendar names CP pins in REQUIRED_TOOLS.calendar):
 *   calendar_list_events   → { events, nextSyncToken, expired }
 *   calendar_create_event  → a single event; a duplicate deterministic id → HTTP 409
 *   calendar_update_event  → a single event; an etag/If-Match mismatch → HTTP 412
 *   calendar_delete_event  → ok; an etag mismatch → HTTP 412; already-gone resolves ok
 *
 * Error contract: a non-2xx Google status (other than the expiry/idempotent cases below)
 * is returned as an `isError` result whose text carries the numeric status. CP's
 * McpGoogleSession.callTool turns that into a thrown error, and GoogleCalendarConnector's
 * statusOf() regex-matches the status — so 409 drives the create read-back (I7) and 412
 * drives EtagConflictError (I12). The server therefore need not convey fresh etags.
 *
 * Gmail tools are intentionally absent (calendar-first; gmail.readonly is a restricted
 * scope needing a CASA assessment — see docs/google-cloud-setup.md §7). CP's spawn()
 * requires the Gmail tools only when config.google.enableGmail is set, so a calendar-only
 * server connects cleanly.
 */

type FetchImpl = typeof globalThis.fetch;

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/**
 * Single-user, local-first: operate on the connected account's `primary` calendar. The
 * spawned MCP child receives a deliberately minimal env (the bearer token + PATH only —
 * see McpGoogleSession.minimalEnv / I6), so a configurable calendar id would be stripped
 * at that boundary anyway. Multi-calendar support is a future change that would widen the
 * child env (and its I6 assertion), so it is deliberately out of scope here.
 */
const CALENDAR_ID = 'primary';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A CallTool-style result. `structuredContent` is the payload CP's client reads. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  etag?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** Map a Google Calendar API event into the RemoteEvent-ish shape CP's client expects. */
export function mapGoogleEvent(ev: GoogleEvent): Record<string, unknown> {
  const allDay = !!ev.start?.date && !ev.start?.dateTime;
  return {
    id: ev.id ?? '',
    title: ev.summary ?? '',
    start: ev.start?.dateTime ?? ev.start?.date ?? '',
    end: ev.end?.dateTime ?? ev.end?.date ?? '',
    etag: ev.etag ?? null,
    ...(allDay ? { allDay: true } : {}),
    // A cancelled event (incremental tombstone) → deleted:true (R3). Such events often
    // carry only { id, status, etag } and no start/end — that's fine, WP5 keys deletes on id.
    ...(ev.status === 'cancelled' ? { deleted: true } : {}),
  };
}

/** Build a Google start/end object from an ISO instant (or date) + an allDay flag. */
export function toGoogleDate(iso: string, allDay: boolean): Record<string, string> {
  if (allDay) {
    return { date: DATE_ONLY.test(iso) ? iso : iso.slice(0, 10) };
  }
  return { dateTime: iso, timeZone: 'UTC' };
}

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/**
 * An error result. The numeric status MUST appear in the text: McpGoogleSession surfaces
 * it in the thrown message and the connector's statusOf() parses it back out.
 */
function fail(tool: string, status: number, detail = ''): ToolResult {
  return { content: [{ type: 'text', text: `${tool} failed: HTTP ${status} ${detail}`.trim() }], isError: true };
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

export interface CalendarHandlerDeps {
  fetchImpl: FetchImpl;
  token: string;
  calendarId?: string;
}

export interface CalendarHandlers {
  listEvents(args: { timeMin?: string; timeMax?: string; syncToken?: string }): Promise<ToolResult>;
  createEvent(args: { title: string; start: string; end: string; allDay?: boolean; idempotencyKey?: string }): Promise<ToolResult>;
  updateEvent(args: { id: string; title: string; start: string; end: string; allDay?: boolean; ifMatch?: string | null }): Promise<ToolResult>;
  deleteEvent(args: { id: string; ifMatch?: string | null }): Promise<ToolResult>;
}

/**
 * Build the calendar tool handlers bound to an injected fetch + bearer token. Pure of any
 * global state — tests pass a stub fetch; the entry script passes globalThis.fetch.
 */
export function createCalendarHandlers(deps: CalendarHandlerDeps): CalendarHandlers {
  const { fetchImpl, token } = deps;
  const calId = encodeURIComponent(deps.calendarId ?? CALENDAR_ID);
  const auth = { Authorization: `Bearer ${token}` };

  return {
    async listEvents(args) {
      const incremental = !!args.syncToken;
      const events: Record<string, unknown>[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;

      // Drain pages: Google returns nextSyncToken only on the LAST page.
      do {
        const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
        if (incremental) {
          // With a syncToken you must NOT also send timeMin/timeMax/orderBy. showDeleted
          // surfaces cancelled events as tombstones.
          params.set('syncToken', args.syncToken!);
          params.set('showDeleted', 'true');
        } else {
          if (args.timeMin) params.set('timeMin', args.timeMin);
          if (args.timeMax) params.set('timeMax', args.timeMax);
          params.set('orderBy', 'startTime');
        }
        if (pageToken) params.set('pageToken', pageToken);

        const res = await fetchImpl(`${CAL_BASE}/${calId}/events?${params.toString()}`, { headers: auth });

        // Expired/invalid syncToken → Google 410. Signal expiry so CP clears the cursor
        // and re-inits with a full window (I8 — a full re-init never deletes).
        if (res.status === 410) return ok({ events: [], expired: true });
        if (!res.ok) return fail('calendar_list_events', res.status, await safeText(res));

        const json = (await res.json()) as {
          items?: GoogleEvent[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };
        for (const it of json.items ?? []) events.push(mapGoogleEvent(it));
        pageToken = json.nextPageToken;
        if (json.nextSyncToken) nextSyncToken = json.nextSyncToken;
      } while (pageToken);

      return ok({ events, nextSyncToken, expired: false });
    },

    async createEvent(args) {
      const body: Record<string, unknown> = {
        summary: args.title,
        start: toGoogleDate(args.start, !!args.allDay),
        end: toGoogleDate(args.end, !!args.allDay),
      };
      // CP already derived a valid base32hex id from the block id; passing it makes the
      // create deterministic (I7). A retry of the same id → Google 409.
      if (args.idempotencyKey) body.id = args.idempotencyKey;

      const res = await fetchImpl(`${CAL_BASE}/${calId}/events`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) return fail('calendar_create_event', 409, 'duplicate event id');
      if (!res.ok) return fail('calendar_create_event', res.status, await safeText(res));
      return ok(mapGoogleEvent((await res.json()) as GoogleEvent));
    },

    async updateEvent(args) {
      const headers: Record<string, string> = { ...auth, 'Content-Type': 'application/json' };
      if (args.ifMatch) headers['If-Match'] = args.ifMatch;
      const body = {
        summary: args.title,
        start: toGoogleDate(args.start, !!args.allDay),
        end: toGoogleDate(args.end, !!args.allDay),
      };
      const res = await fetchImpl(`${CAL_BASE}/${calId}/events/${encodeURIComponent(args.id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
      if (res.status === 412) return fail('calendar_update_event', 412, 'etag conflict');
      if (!res.ok) return fail('calendar_update_event', res.status, await safeText(res));
      return ok(mapGoogleEvent((await res.json()) as GoogleEvent));
    },

    async deleteEvent(args) {
      const headers: Record<string, string> = { ...auth };
      if (args.ifMatch) headers['If-Match'] = args.ifMatch;
      const res = await fetchImpl(`${CAL_BASE}/${calId}/events/${encodeURIComponent(args.id)}`, {
        method: 'DELETE',
        headers,
      });
      if (res.status === 412) return fail('calendar_delete_event', 412, 'etag conflict');
      // ok (204) or already-gone (404/410) → idempotent success.
      if (res.ok || res.status === 404 || res.status === 410) return ok({ deleted: true });
      return fail('calendar_delete_event', res.status, await safeText(res));
    },
  };
}

/** Tool descriptors advertised on tools/list. inputSchema is permissive (CP validates). */
const TOOL_DESCRIPTORS = [
  {
    name: 'calendar_list_events',
    description:
      'List calendar events. Full window via timeMin/timeMax, or incremental via syncToken. Returns { events, nextSyncToken, expired }.',
  },
  {
    name: 'calendar_create_event',
    description:
      'Create an event. A client-supplied idempotencyKey becomes the deterministic event id; a duplicate id returns HTTP 409.',
  },
  {
    name: 'calendar_update_event',
    description:
      'Update an event with optimistic concurrency. ifMatch drives an If-Match header; an etag mismatch returns HTTP 412.',
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete an event. ifMatch drives an If-Match header; an already-deleted event resolves successfully.',
  },
] as const;

/**
 * Build the low-level MCP Server with the 4 calendar tools wired to `handlers`. Uses the
 * SDK's request schemas directly (no zod dependency of our own). Side-effect-free —
 * connecting a transport is the caller's job (the entry script).
 */
export function buildServer(handlers: CalendarHandlers): Server {
  const server = new Server(
    { name: 'companion-google-calendar', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object' as const },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    let result: ToolResult;
    switch (name) {
      case 'calendar_list_events':
        result = await handlers.listEvents({
          timeMin: a.timeMin as string | undefined,
          timeMax: a.timeMax as string | undefined,
          syncToken: a.syncToken as string | undefined,
        });
        break;
      case 'calendar_create_event':
        result = await handlers.createEvent({
          title: String(a.title ?? ''),
          start: String(a.start ?? ''),
          end: String(a.end ?? ''),
          allDay: a.allDay as boolean | undefined,
          idempotencyKey: a.idempotencyKey as string | undefined,
        });
        break;
      case 'calendar_update_event':
        result = await handlers.updateEvent({
          id: String(a.id ?? ''),
          title: String(a.title ?? ''),
          start: String(a.start ?? ''),
          end: String(a.end ?? ''),
          allDay: a.allDay as boolean | undefined,
          ifMatch: (a.ifMatch as string | null | undefined) ?? null,
        });
        break;
      case 'calendar_delete_event':
        result = await handlers.deleteEvent({
          id: String(a.id ?? ''),
          ifMatch: (a.ifMatch as string | null | undefined) ?? null,
        });
        break;
      default:
        result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return result as CallToolResult;
  });

  return server;
}
