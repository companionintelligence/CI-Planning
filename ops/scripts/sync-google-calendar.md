# Connecting Google Calendar

Companion Planning's server runs as a standalone local process with **no Google
OAuth baked in** — by design. Instead, any agent that *already* has Google Calendar
access (Claude with the Calendar MCP, Claude Cowork, or hermes) pulls events and
pushes a minimal batch into the app. This keeps credentials out of the server and
makes "connect my calendar" a one-line ingest.

## The ingest endpoint

```
POST /api/calendar/events
{
  "events": [
    { "calendar_id": "liam@lifescope.io", "event_id": "abc123",
      "title": "CI Standup", "start": "2026-05-29T09:00:00-07:00",
      "end": "2026-05-29T09:30:00-07:00" }
  ],
  "prune_missing": false          // true + window_start/end to drop vanished events
}
→ { ok, new_events, updated_events, removed_events }
```

`start`/`end` accept ISO 8601 or epoch millis. Re-ingesting the same
`calendar_id:event_id` updates in place (no duplicates). Manual task blocks
(`calendar_id: "manual"`) are never pruned.

Only **timed** events should be ingested for capacity — skip all-day events
(deadlines, multi-day holds), which would distort committed-hours math. They're
better surfaced as todos.

## Agent recipe (Claude with the Calendar MCP)

```
1. list_calendars()
2. for each work calendar:
     list_events(calendarId, startTime=now, endTime=+3 weeks, orderBy=startTime)
3. keep events with start.dateTime (drop all-day start.date events)
4. POST /api/calendar/events  with the minimal {calendar_id, event_id, title, start, end}
5. (optional) POST /api/reconcile  to close past blocks whose task is done
```

## Scheduled sync

Run this on the same cadence as the summary routines. Two options:

- **hermes cron** (it has Calendar + companion MCP): add a job that runs the recipe
  above every morning — see `install-hermes-routines.sh`.
- **launchd + a small agent step**: wrap the recipe in a script your agent runtime
  can invoke; the templated summary routine already calls `/api/reconcile`.

## Why not OAuth in the server?

- No secret storage / token refresh to maintain in a single-user local app.
- The calendar bridge stays provider-agnostic (`CalendarProvider` interface) — a
  native Google adapter can still be dropped in later without changing any routes.
- Whatever agent is already authorized (Cowork, Claude, hermes) becomes the bridge.
