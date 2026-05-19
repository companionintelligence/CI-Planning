# Architecture — Private Markdown Todo App (v2)

Status: design draft, 2026-05-18. Supersedes the ad-hoc shape of the current `server.js`.
Goal: turn the working-but-rough prototype into a private, local-first, MCP-native todo
and planning system that runs entirely on one Mac, reachable from phone over Tailscale.

---

## 1. Goals & non-goals

### Goals
- **Markdown on disk is the source of truth.** Files stay human-readable and editable
  in any text editor (Obsidian, vim, VS Code, iA Writer) with or without this app running.
- **SQLite is the *derived* index** for fast list/search/filter — never the truth.
  Deleting the DB and rebuilding from `.md` files is a supported, tested operation.
- **MCP server is a first-class entry point**, not bolted on. Claude/agents read and
  edit todos via the same primitives the web UI uses.
- **Local LLMs only.** Cleanup, triage, summarization run on-device through Ollama.
  No third-party API calls in any path that touches note content.
- **Mobile-usable.** Phone-over-Tailscale should not feel like a desktop port — PWA,
  responsive, large tap targets, offline cache for read.
- **Versioned backups** without operator action: hourly git auto-commit + Litestream
  on the index DB + optional Syncthing mirror of the markdown root.
- **Full-text search** across every watched file, fast (<100ms) even at thousands of files.
- **Fully open-source dependencies.** MIT / Apache / AGPL only; no commercial SDKs.

### Non-goals (for v2)
- Multi-user / collaboration. Single user, single machine.
- Cloud sync as a built-in. Syncthing/iCloud/git handles "another device" if desired.
- Rich block editor (Notion-style). Markdown stays markdown; we render, we don't replace.
- Mobile *native* app. PWA over Tailscale is enough.
- CRDT / offline-write conflict resolution. Read offline, write online.

---

## 2. Truth model & data flow

```
                ┌─────────────────────────────────────────┐
                │  ~/Documents/Owner_Plan/**/*.md          │ ← source of truth
                │  (and any other configured roots)       │
                └─────────────────────────────────────────┘
                          ▲                  │
                          │ atomic writes    │ chokidar watch
                          │ (tmp + rename)   ▼
   ┌──────────────────────┴──────────────────────────────┐
   │              Node server (single process)            │
   │                                                       │
   │   ┌────────────┐  ┌──────────────┐  ┌─────────────┐  │
   │   │ HTTP API   │  │ MCP server   │  │ Indexer     │  │
   │   │ (Express)  │  │ (stdio + sse)│  │ (chokidar → │  │
   │   │            │  │              │  │  SQLite)    │  │
   │   └─────┬──────┘  └──────┬───────┘  └──────┬──────┘  │
   │         │                │                  │         │
   │         └──────┬─────────┴────────┬─────────┘         │
   │                ▼                  ▼                   │
   │         ┌────────────┐    ┌──────────────────┐        │
   │         │ data layer │    │ LLM gateway      │        │
   │         │ (markdown  │    │ (Ollama client,  │        │
   │         │  + sqlite) │    │  JSON-mode)      │        │
   │         └─────┬──────┘    └────────┬─────────┘        │
   └───────────────┼────────────────────┼──────────────────┘
                   ▼                    ▼
            ┌─────────────┐      ┌────────────────┐
            │ index.db    │      │ Ollama         │
            │ (FTS5 +     │      │ :11434         │
            │  vec)       │      │ qwen2.5:7b     │
            └─────────────┘      └────────────────┘
                   │
                   │ Litestream → ~/Backups/index.db.replicas/
                   ▼
            (continuous replication)

   git auto-commit hourly (launchd) → versioned markdown history
   Syncthing (optional) → off-Mac mirror of markdown root
```

**Rule:** anything stored only in SQLite and not derivable from the markdown is a bug.
The DB caches: parsed todo list per file (with line numbers, text, mark, indent,
checked state), modification times, content hashes (SHA-256 per file), and the FTS
index. Everything else (tags, due dates, projects) is parsed from markdown on each
index pass — markdown frontmatter and inline conventions stay authoritative.

---

## 3. Components

### 3.1 Node server (single process, ESM)
- **Express HTTP API** for the web UI (REST + SSE for live reload).
- **MCP server** mounted in the same process. Exposes both stdio transport (for
  Claude Code on the same Mac) and SSE transport at `/mcp` (for remote agents over
  Tailscale). Uses `@modelcontextprotocol/sdk`.
- **Indexer**: chokidar watches the configured roots; on `add`/`change`/`unlink`
  events the affected file is re-parsed and the DB rows replaced inside a single
  transaction. Initial scan is parallel (worker pool) and content-hash-skipped on
  restart so warm starts are near-instant.
- **LLM gateway**: thin client over the Ollama HTTP API (`:11434`). Always uses
  `format: "json"` for structured tasks. Streaming responses pass through to the UI
  via SSE.

Reasoning for one process: deployment is `node server.js` and `launchctl load`. No
docker, no compose, no separate workers. The whole thing should fit in <2500 LOC.

### 3.2 MCP tool surface
Designed so an agent can do every meaningful action a human can, atomically:

| Tool | Purpose |
|------|---------|
| `list_files(glob?, tag?)` | List indexed files with todo counts and tags |
| `read_file(path)` | Return raw markdown + parsed frontmatter |
| `write_file(path, content, expected_hash?)` | Atomic write; reject if hash mismatch |
| `append_section(path, heading, content)` | Append under a heading, creating if missing |
| `list_todos(filter)` | Query: open/done, project, tag, due, file, free-text |
| `add_todo(path, heading, text, due?, tags?)` | Append a `- [ ]` line under a heading |
| `complete_todo(id)` | Mark `[x]`, optionally add `(done: 2026-05-18)` stamp |
| `uncomplete_todo(id)` | Reverse |
| `move_todo(id, dest_path, dest_heading)` | Cut from one file, paste to another |
| `search(q, mode)` | `fts` \| `semantic` \| `hybrid`; returns ranked snippets |
| `triage_inbox(path?)` | LLM pass: categorize, dedupe, suggest moves, return a plan |
| `summarize_day(date?)` | LLM pass: today's open todos + a brief narrative |
| `archive_completed(path?, older_than?)` | Move `[x]` lines into `archive/` subtree |

Every mutating tool returns `{ ok, new_hash, diff }` so agents can verify and chain.

### 3.3 Web UI
- **SvelteKit** (vanilla `npm` build, no SSR — static adapter; Express serves the
  built `index.html`). Chosen over React because: smaller bundle, less ceremony,
  better suited to a one-person project. Chosen over keeping vanilla JS because the
  current 600-line `app.js` is past the point where ad-hoc state management pays.
- **Tailwind v4** for styling. No component library; the surface area is small.
- **PWA** via vite-plugin-pwa: installable, service worker caches read API responses
  and last-viewed files for offline.
- Three-pane layout collapsing to single-pane drawer on mobile:
  1. Roots & files (tree)
  2. Filtered todo list (today / overdue / by project / by tag)
  3. Markdown preview + edit (CodeMirror 6 for edit mode)
- "Triage" button on any file opens a side panel with the LLM's suggested moves,
  which the user approves per-item (no auto-apply).

### 3.4 Data layer — SQLite schema (sketch)
```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,           -- absolute
  root TEXT NOT NULL,              -- which configured root
  relative_path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  frontmatter_json TEXT            -- parsed yaml frontmatter
);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  indent TEXT NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL,        -- 0/1
  heading TEXT,                    -- nearest preceding heading
  tags_json TEXT,                  -- ["work","p1"]
  due_date TEXT,                   -- ISO date if parsed
  hash TEXT NOT NULL               -- stable id: sha256(file_path + text + heading)
);

CREATE INDEX todos_open ON todos(checked, due_date);
CREATE INDEX todos_file ON todos(file_path);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  path UNINDEXED,
  heading,
  body,
  tokenize = 'porter unicode61'
);

-- Optional, only if sqlite-vec is installed:
-- CREATE VIRTUAL TABLE notes_vec USING vec0(path TEXT, chunk INTEGER, embedding FLOAT[384]);
```

`todos.hash` is the stable id used by MCP tools — line numbers are volatile, hashes
survive reflows. Atomic writes resolve line drift the same way `lib/util.js#applyToggle`
already does (search ±N lines for matching text), but the canonical reference is the
hash, not the line.

### 3.5 LLM gateway
- Ollama running as a `launchd` service, default model `qwen2.5:7b-instruct` (good
  instruction following at this size, JSON-mode reliable). Fallback for low memory:
  `llama3.2:3b`. MLX backend if/when Ollama's MLX preview stabilizes.
- All prompts are versioned in `prompts/*.md` files under the repo, not hard-coded.
- The gateway exposes one internal HTTP route: `POST /api/llm/triage` etc., used by
  the UI. MCP tools call the gateway functions directly.
- **No model output is auto-applied to disk.** Triage returns a plan; the user (or
  agent) explicitly invokes the corresponding mutating tools.

### 3.6 Backups (layered, each handles a different failure mode)
- **Git** (versioning): a `launchd` job runs `git -C <markdown-root> add -A && git
  commit -m "auto: $(date -Iseconds)"` hourly when there are changes. Recovers from
  "I deleted the wrong line."
- **Litestream** (DB durability): continuous replication of `index.db` to a separate
  disk path. Recovers from "the DB file corrupted."
- **Syncthing** (off-Mac mirror, optional): markdown root only — never the live SQLite
  file (Syncthing+SQLite is famously dangerous). Recovers from "the Mac died."
- **restic** (encrypted off-site, optional): weekly snapshot to a remote endpoint of
  the user's choice. Recovers from "the house burned down."

---

## 4. Stack summary

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node 22 ESM | Already in use; no need to switch |
| HTTP | Express | Already in use; small surface |
| MCP | `@modelcontextprotocol/sdk` (TS) | Official, stdio + SSE in one package |
| Watcher | `chokidar` | Already in use; works |
| DB | `better-sqlite3` | Synchronous, fast, no callback noise |
| Search | SQLite FTS5 (built-in) | Zero deps; "good enough" semantic via sqlite-vec optional |
| LLM | Ollama (HTTP) | Easiest local stack on Mac; swappable for MLX later |
| UI build | SvelteKit + Tailwind v4 + vite-plugin-pwa | Small, modern, PWA-friendly |
| Editor | CodeMirror 6 | Best markdown editor library; embeds cleanly |
| Markdown render | `marked` (already vendored) + `markdown-it-task-lists` | Working |
| Backup (versioning) | git + launchd | Free, ubiquitous |
| Backup (DB) | Litestream | Designed exactly for this |
| Backup (off-host) | Syncthing | Optional, user's call |

---

## 5. Directory layout (target)

```
companion-planning/             (or rename to e.g. "plan/")
├── ARCHITECTURE.md         this file
├── PLANNING.md             phased roadmap
├── README.md
├── config.json             roots, excludes, port, model, backup paths
├── package.json
├── server/
│   ├── index.js            entrypoint
│   ├── http.js             Express routes
│   ├── mcp.js              MCP server + tool definitions
│   ├── indexer.js          chokidar → SQLite
│   ├── db.js               better-sqlite3 setup, migrations
│   ├── llm.js              Ollama client
│   ├── markdown.js         parsing: todos, headings, frontmatter
│   └── backup.js           git auto-commit trigger, litestream supervisor
├── prompts/
│   ├── triage.md
│   ├── summarize_day.md
│   └── dedupe.md
├── ui/                     SvelteKit app
│   ├── src/
│   ├── static/
│   └── vite.config.js
├── public/                 built UI lands here (gitignored)
├── test/                   node --test
└── ops/
    ├── launchd/            *.plist for git-autocommit, ollama, server
    └── litestream.yml
```

---

## 6. Data formats (markdown conventions)

These are conventions, not enforcement — files without them still work, they just
won't surface in filters.

- **Todos**: standard GFM `- [ ] text` and `- [x] text`. Nested indent preserved.
- **Tags**: inline `#tag` anywhere in a todo line; also `tags:` array in frontmatter.
- **Due dates**: `due: 2026-05-20` in frontmatter (file-level) or inline `(due: 2026-05-20)`
  in a todo (todo-level wins).
- **Projects**: implied by nearest preceding `##` heading; explicit override via
  `project: name` in frontmatter.
- **Done stamps**: optional `(done: 2026-05-18)` appended when completing via the UI/MCP.

---

## 7. API surface (HTTP)

Kept stable for the UI. The MCP server wraps the same internal functions.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/files` | List files with todo counts |
| GET | `/api/file?path=` | Read a file |
| PATCH | `/api/file` | Toggle a checkbox (`path`, `hash`, `checked`) |
| PUT | `/api/file` | Replace file content (`path`, `content`, `expected_hash`) |
| GET | `/api/todos?filter=` | Query todos |
| POST | `/api/todos` | Add a todo |
| GET | `/api/search?q=&mode=` | FTS / semantic / hybrid |
| POST | `/api/llm/triage` | Triage a file, returns plan |
| POST | `/api/llm/summary` | Daily summary |
| GET | `/api/events` | SSE: fileChange / indexProgress / llmStream |
| GET | `/api/config` | Roots, title, model, version |

---

## 8. Trust & security

- **Trust boundary = Tailscale.** Server binds to `0.0.0.0`; reachable only via the
  user's tailnet. No auth on the HTTP API for v2.
- **MCP over SSE** is also behind Tailscale; same boundary. (If we ever want to
  share access with another tailnet user, we add a token then — not now.)
- **Path sandbox**: every read/write resolves through `lib/util.js#isPathInRoots`
  and rejects paths outside the configured roots. Already implemented in the newer
  branch.
- **Atomic writes**: write to `<file>.tmp.<pid>` then `rename()`. Reject writes when
  `expected_hash` doesn't match current content (concurrent-edit guard).
- **LLM input**: prompts include note content; this stays on-device (Ollama).
- **Backups**: git history is local; Litestream targets local or user-chosen remote;
  Syncthing peers under the user's control.

---

## 9. Open questions (decide during build)

1. **SvelteKit vs. plain Vite+Svelte vs. evolve vanilla JS.** SvelteKit gives routing
   and a build pipeline; plain Vite+Svelte is even smaller. Decision deferred to start
   of Phase 3 — depends on whether we want URL routes per file.
2. **Embeddings yes/no.** FTS5 alone covers the user's stated "full text search."
   sqlite-vec adds semantic search for "things like this" queries but adds a model
   (e.g. `nomic-embed-text` via Ollama) and ~50ms/query. Default: ship without; add
   in Phase 5 if missed.
3. **Where to host this repo's docs/screenshots.** Out of scope until v2 ships.
4. **MCP transport for phone.** Phone Claude clients don't speak MCP yet; the phone
   uses the web UI. MCP-over-SSE is only for desktop agents. Reconsider when iOS
   MCP clients exist.
5. **Should "archive" be a directory move or a frontmatter flag?** Lean toward
   directory move (`archive/` subtree) — keeps the active list small and aligns with
   how the user already organizes (`planning_archive/` already exists).
