> # ⚠️ STALE / SUPERSEDED
>
> **This document describes the OLD agent-bridge model** (an external agent POSTs events
> to `/api/calendar/events`; **no OAuth in the server**). That model is **replaced** by a
> native **standalone Google OAuth 2.1** flow built into the app, with tokens encrypted in
> the `connection_tokens` store and a single canonical inbound calendar reconciler. The
> `POST /api/calendar/events` and `POST /api/reconcile` endpoints described below no longer
> exist.
>
> **Current docs:**
> - Setup runbook → [docs/google-cloud-setup.md](../../docs/google-cloud-setup.md)
> - Architecture → [ARCHITECTURE.md §10 — Google connector](../../ARCHITECTURE.md#10-google-connector)
>
> The original text is kept below for historical reference only — do not follow it.

---

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
    { "calendar_id": "owner@example.com", "event_id": "abc123",
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

## Scheduled sync (automated)

A **Claude scheduled task** runs this recipe automatically every morning at 06:36
local. It lives at `~/.claude/scheduled-tasks/companion-calendar-sync/SKILL.md`
(taskId `companion-calendar-sync`) and:

1. lists the user's calendars (skips Holidays),
2. pulls the next 3 weeks of timed events from each,
3. POSTs them to `/api/calendar/events` with `prune_missing: true` (so cancelled
   events drop out),
4. calls `/api/reconcile`,
5. reports synced-count + over-capacity days.

Manage it from the **Scheduled** sidebar (Run now to pre-approve calendar access).
Scheduled tasks run while the Claude app is open; if it was closed when due, the
task runs on next launch.

Alternative drivers (if you prefer not to depend on the Claude app being open):
- **hermes cron** — if hermes has the Google Calendar MCP, register the same
  recipe via `hermes cron`.
- **launchd + agent step** — wrap the recipe in a script your agent runtime invokes.

## Why not OAuth in the server?

- No secret storage / token refresh to maintain in a single-user local app.
- The calendar bridge stays provider-agnostic (`CalendarProvider` interface) — a
  native Google adapter can still be dropped in later without changing any routes.
- Whatever agent is already authorized (Cowork, Claude, hermes) becomes the bridge.
