# Companion Planning

A **private, local-first, MCP-native** personal todo and planning app. Reads your
markdown files on disk, indexes them in SQLite, exposes everything to Claude and
agents via Model Context Protocol, and lets you triage with a local LLM. Runs as a
single Node process; accessible from your phone over Tailscale as an installable PWA.

> Markdown stays the source of truth. SQLite is a rebuildable derived index.
> Local LLMs only — no cloud calls for your notes.

## Why

If you keep planning docs as markdown (Obsidian-style, Foam-style, or just folders
of `.md`), you have two problems:

1. There's no good way to **slice across files** — Today, Overdue, by-tag, by-project — because nothing reads the structure.
2. There's no good way to **let agents act on your todos** — Claude can read the files, but every edit is a brittle string replace with no atomicity, no concurrency guard, no stable IDs.

Companion Planning fixes both. It maintains a SQLite index of every checkbox in
every watched directory, gives todos stable content-hash IDs, and exposes both
HTTP and MCP APIs so the web UI and an agent share one data layer.

## What you get

- **Four views**: Today / All Todos / Files / Search — with FTS5 search across every note
- **Local LLM triage** via Ollama (qwen3.6:35b / gemma4:31b / nemotron3:33b — auto-detected)
- **MCP server with 14 tools** for Claude / agents (`list_todos`, `add_todo`, `complete_todo`, `search`, `triage_inbox`, `summarize_day`, …)
- **PWA** — installable on iPhone & Android home screens via Tailscale
- **Atomic writes** with optimistic concurrency (sha256 guards) and content-hash todo IDs (no line-drift bugs)
- **Hourly git auto-commit** of your markdown root via launchd
- **Live reload** when you edit a file in Obsidian / vim / iA Writer — SSE pushes change to the web UI

## Quick start

```bash
git clone https://github.com/mrhegemon/companion-planning.git
cd companion-planning
npm install

# Point it at your planning markdown root(s)
cp config.example.json config.json
$EDITOR config.json

# Start
HOST=0.0.0.0 npm start
# Open http://localhost:3847 or http://<your-tailnet-ip>:3847
```

Optional but recommended:

```bash
# Local LLM for triage + briefing
brew install ollama && ollama serve &
ollama pull qwen2.5:7b-instruct   # ~4.7 GB, good baseline

# Register as MCP server for Claude Code
claude mcp add companion-planning -- node "$(pwd)/mcp-stdio.js"

# Hourly auto-commit backup of your markdown directory
bash ops/scripts/install-autocommit.sh
```

## Configuration

```json
{
  "directories": ["~/Documents/Liam_Plan"],
  "excludeDirs": ["archive", "_archive", "planning_archive", "node_modules", ".git"],
  "port": 3847,
  "title": "Companion Planning"
}
```

## Markdown conventions

These are optional — files without them still work, they just won't surface in filters.

| Convention | Example |
|---|---|
| Todo | `- [ ] file taxes` |
| Done | `- [x] file taxes (done: 2026-04-15)` |
| Due date | `- [ ] file taxes (due: 2026-04-15)` |
| Tag | `- [ ] file taxes #tax #urgent` |
| Priority | `- [ ] file taxes !!!` or `p1` |
| Frontmatter | `due:`, `tags: [tax, urgent]`, `project: name` |

Todos are addressable by a **stable content hash** (sha256 of `path + heading + text`)
— so an edit doesn't break agent references the way line numbers do.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/files` | List indexed files with todo counts |
| GET | `/api/file?path=` | Read a file (returns content, sha256, parsed todos & headings) |
| PATCH | `/api/file` | Toggle a checkbox by `hash` |
| PUT | `/api/file` | Replace file content with optimistic `expected_sha256` |
| POST | `/api/todo` | Add a `- [ ]` line under a heading |
| GET | `/api/todos?open=true&due=today&tag=fundraising` | Filtered query |
| GET | `/api/search?q=` | BM25-ranked FTS5 search |
| GET | `/api/stats` | Aggregate counts |
| POST | `/api/llm/triage` | LLM triage of open todos; returns suggestions |
| POST | `/api/llm/summary` | LLM daily briefing |
| GET | `/api/llm/status` | Is Ollama reachable? Which models? |
| GET | `/api/events` | SSE stream of file-change events |

## MCP tool surface

14 tools, all running over stdio for Claude Code:

`list_files`, `read_file`, `write_file`, `append_section`, `list_todos`, `add_todo`,
`complete_todo`, `uncomplete_todo`, `search`, `stats`, `triage_inbox`, `summarize_day`,
`rescan`, `llm_status`.

Add to Claude Code:

```bash
claude mcp add companion-planning -- node /path/to/mcp-stdio.js
```

## Security model

- **Trust boundary: Tailscale.** No per-request auth in v2; the server is reachable
  only via your tailnet (or `127.0.0.1` if you don't pass `--host 0.0.0.0`).
- **Path sandbox**: every read and write is checked against the configured roots
  (`isPathInRoots` in `lib/util.js`).
- **Atomic writes**: write to `<file>.tmp.<pid>.<ts>` then `rename()`.
- **Concurrency guard**: `PUT /api/file` requires `expected_sha256`; toggles use
  content-hash todo IDs that survive reflows.
- **LLM input stays local**: prompts include note content; Ollama runs on-device.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) and [PLANNING.md](PLANNING.md) on the
[planning branch](https://github.com/mrhegemon/companion-planning/tree/companion/happy-mcnulty-4c28e9)
for the full design.

Stack:
- Node 22 + Express + chokidar
- better-sqlite3 (WAL mode, FTS5)
- @modelcontextprotocol/sdk (stdio transport)
- gray-matter for frontmatter parsing
- marked (vendored) for rendering
- Ollama HTTP client (zero-dep)
- Vanilla JS frontend (Stage-1 PWA); Svelte 5 rewrite in `ui/` (Stage 2)

## Tests

```bash
npm test
```

## License

MIT.

## Author

Liam Broza ([@mrhegemon](https://github.com/mrhegemon))
