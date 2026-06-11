# Companion Planning

A **private, local-first, MCP-native** day-planning and time-blocking application. Runs as a background service on your machine, stores everything in a local SQLite database via Drizzle ORM, exposes calendar & todo management to Claude and other agents via the Model Context Protocol (MCP), and lets you triage tasks with local LLMs (Ollama).

Accessible from your phone or secondary devices over Tailscale as a responsive dashboard.

> SQLite on the device is the source of truth.
> Local LLMs only — no cloud calls for your notes.

---

## Why

If you keep your todo lists and schedules scattered across different planning documents and calendars, you face two core problems:
1. There's no unified way to schedule and time-block tasks alongside real calendar commitments.
2. There's no good way to let AI agents collaborate on your todos — agents can read markdown or text files, but editing them is fragile with no atomicity, concurrency guards, or stable IDs.

Companion Planning provides a dedicated backend that merges your tasks, inbox, and calendar. It maintains a structured SQLite database of all records, supports drag-and-drop time-blocking, and exposes an embedded MCP server so you and your agent share a single data layer.

---

## What You Get

- **Intentional Planning Views**: Focus dashboards for *Today*, a weekly *Calendar*, an *Inbox* review queue, *All Tasks* filters, and *Tags* cloud.
- **Guided Ritual / Auto Modes**: Choose between *Auto* (AI schedules your day automatically) and *Ritual* (Sunsama-style guided morning routine).
- **Inline Markdown Editor**: Notes are displayed as rich Markdown. Click any description card to expand it into rendered markdown, and double-click or edit it inline using the built-in markdown notes editor.
- **Outbound & Inbound MCP**:
  - Connects to Google Calendar & Gmail MCP servers to ingest events and emails into task suggestions.
  - Exposes an embedded **MCP Server** over both `stdio` and `SSE` to let your agent (Claude Desktop, Cursor, Hermes) read/write tasks and schedule your day.
- **Calendar Integration Route (`POST /api/calendar/events`)**: Feed GCal events directly into the database. Stale events are automatically updated or pruned within your calendar window.
- **Local LLMs**: Seamlessly hooks into Ollama (`localhost:11434`) for task extraction, priority triaging, and daily briefings.

---

## Quick Start

Ensure you have [pnpm](https://pnpm.io/) and Node 20+ installed.

```bash
git clone https://github.com/mrhegemon/companion-planning.git
cd companion-planning
pnpm install

# Start development servers (frontend + backend concurrently)
pnpm dev
```

* Open the dashboard at `http://localhost:5173/` (or `http://localhost:5174/` if 5173 is occupied).
* Backend Koa API runs on `http://localhost:3848/`.

---

## Local LLM Setup (Optional)

Install Ollama to enable daily briefings and task extraction from emails/texts:

```bash
# Start Ollama
ollama serve

# Pull default models
ollama pull qwen2.5:0.5b     # Light model for extraction
ollama pull gemma4:e4b        # Medium model for summaries and triage
```

---

## Model Context Protocol (MCP) Integration

External agents can securely connect to your database using the built-in MCP server.

### Stdio Mode (Claude Desktop, Cursor, local CLI)
Add the server entrypoint to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "companion-planning": {
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "/Users/liam/devel/ci/Companion-Planning/server/src/mcp-server.ts",
        "--stdio"
      ]
    }
  }
}
```

### SSE Mode (Hermes, OpenClaw, remote servers)
Point your SSE MCP client to the running companion server:
- **SSE Endpoint**: `http://<Tailscale-IP>:3848/api/mcp`
- **Message Endpoint**: `http://<Tailscale-IP>:3848/api/mcp/message`

### Tools Available to Agents
- `list_tasks` — Search and fetch tasks.
- `create_task` — Create a new task or subtask.
- `update_task` — Edit tasks or toggle completion.
- `propose_task` — Suggest tasks to the user's Review Queue (`possible_tasks`) to maintain human-in-the-loop safety.
- `get_day_summary` — Fetch the daily briefings.
- `run_auto_schedule` — Recalculate calendar time blocks.

---

## Technical Stack

- **Backend**: Node.js + Koa.js + TypeScript
- **Database**: SQLite (`better-sqlite3`) in WAL mode
- **ORM & Migrations**: Drizzle ORM
- **Inference**: Ollama HTTP API
- **Protocols**: REST, SSE, and Model Context Protocol (MCP SDK v1.29)
- **Frontend**: SolidJS + Vite + Tailwind CSS 3 PWA (single UI at `/`)

---

## License

MIT.
