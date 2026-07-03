# Attaching Companion Planning to Claude Cowork

> **⚠️ ARCHIVED / STALE — describes a deleted architecture. Do not follow.**
> This guide documents the **pre-rebuild** app: a markdown-file-backed MCP tool
> *server* exposing ~36 planning tools (`list_todos`, `find_slot`, `stats`, …)
> over stdio (`server/dist/mcp-stdio.js`) and HTTP/Tailscale (`/mcp`). That entire
> backend was replaced on 2026-05-30 by the Koa + SolidJS + Drizzle rebuild
> (commit `1510cd8`). **None of it exists today:** there is no `build` script, no
> `server/dist/mcp-stdio.js`, no `/mcp` HTTP route, and none of the 36 tool names
> appear in `server/src`. The smoke script this doc cited (`ops/scripts/mcp-smoke.mjs`)
> was removed alongside this archival because it could only spawn that dead entry.
>
> **What actually exists:** Companion Planning is an MCP *client*, not a server —
> it spawns a Google Calendar/Gmail connector over stdio and drives 7 tools
> (`calendar_*` × 4, `gmail_*` × 3). See `server/src/mcp/client.ts` +
> `server/src/mcp/google-server.ts`, and the Phase X audit (`docs/x-audit.md`) for
> the full reconciliation. If a Cowork-facing planning-tool server is ever wanted
> again, it is **new work** against the current schema, not a resurrection of this.
>
> Kept only as historical record of the original Cowork-attach intent.

Companion Planning speaks MCP over two transports. Claude Cowork (and Claude
Desktop / Claude Code) can attach to either. Verified with
`node ops/scripts/mcp-smoke.mjs` — **36 tools**, real-data round-trip.

## Option A — stdio (local, recommended)

The classic attachment. Cowork spawns the server as a child process.

```bash
claude mcp add companion-planning -- node /ABSOLUTE/PATH/server/dist/mcp-stdio.js
```

or in the Cowork / Claude Desktop MCP config JSON:

```json
{
  "mcpServers": {
    "companion-planning": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/server/dist/mcp-stdio.js"]
    }
  }
}
```

> Build first: `npm run build`. The compiled entrypoint is
> `server/dist/mcp-stdio.js` — **not** the legacy `mcp-stdio.js` at the repo root
> (that's the pre-V3 JS shim; pointing at it gives you the old, smaller toolset).

## Option B — HTTP / Streamable (remote, over Tailscale)

When the server already runs as a daemon (it does, via the launchd plist), any
Cowork instance on the tailnet attaches without spawning a process:

```json
{
  "mcpServers": {
    "companion-planning": { "url": "http://100.x.x.x:3847/mcp" }
  }
}
```

Verified: `POST /mcp` returns the `initialize` response with an `mcp-session-id`.

## What Cowork can do once attached

A planning-aware Cowork session opener:

```
lookahead(weeks=3)          → next 3 weeks: events, due tasks, over-capacity days
list_todos(status="open", due="today")
capacity_report(start_date, end_date)   → am I over-committed?
find_slot(duration_minutes) → open time; schedule_task(hash, date, time, mins)
generate_summary(period)    → write a review;  reconcile_past → close stale blocks
memory_get / memory_set     → carry context across sessions
extract_from_source(path)   → pull tasks from a doc into the Review queue
accept_suggestion(id)       → the only path from LLM output to disk
```

Full tool list (36): `list_files, read_file, write_file, append_section,
list_todos, add_todo, complete_todo, uncomplete_todo, search, stats, triage_inbox,
summarize_day, rescan, extract_todos_from_text, project_rollup, propose_archive,
apply_suggestion, llm_status, extract_from_source, list_suggestions,
accept_suggestion, dismiss_suggestion, task_history, set_estimate, capacity_report,
lookahead, list_calendar, memory_set, memory_get, memory_list, sync_calendar,
schedule_task, generate_summary, reconcile_past, last_summaries, find_slot`.

## Companion Intelligence ecosystem fit

This is the **planning brain** other agents read from and write to:

- **hermes** (already a daemon + MCP client) runs the scheduled summary/calendar
  routines — see `ops/scripts/install-hermes-routines.sh`.
- **Cowork** attaches for interactive planning: triage, scheduling, briefings.
- **The calendar bridge** lets any calendar-capable agent push events in
  (`POST /api/calendar/events`) — see `ops/scripts/sync-google-calendar.md`.
- Markdown stays the substrate, so Obsidian / git / other tools keep working.

One server, one source of truth, many agents.
