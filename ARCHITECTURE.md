# Architecture — Companion Planning (V3)

Status: design, 2026-05-18. Supersedes the V2 draft on `companion/happy-mcnulty-4c28e9`.
Consolidates V1 (plain-JS Express + vanilla PWA) and V2 (SQLite + MCP + Ollama + Svelte 5
scaffold) into a single **TypeScript, MCP-native, local-first** planning system.

> **Source of truth**: markdown files on disk in `~/Documents/Liam_Plan` (or any
> configured root). SQLite is a rebuildable derived index; everything in it can be
> reconstructed from the `.md` files alone. Local LLMs only — Ollama on-device, no
> cloud calls touch note content.

---

## 1. Goals

### Hard requirements
- **Markdown stays editable in any editor** (Obsidian, vim, iA Writer, VS Code) with or without the server running.
- **One UI**, served from `/`, not the current dual `/` (vanilla V1) + `/v2/` (Svelte V2) split.
- **TypeScript everywhere** — server, UI, MCP server, scripts — with strict mode and shared types.
- **One process** (`node dist/server.js`) — no separate workers, no docker, no compose.
- **MCP is a first-class entry**: every action a human can take, an agent can take atomically.
- **Local LLMs only.** Ollama HTTP client, JSON-mode output, prompts versioned as files.
- **Mobile-pleasant.** PWA installable over Tailscale on iPhone/Android. Read works offline.
- **Atomic, hash-guarded writes.** Stable content-hash todo IDs so line drift never bites.
- **Tested.** Playwright E2E for the UI, Vitest for unit, integration suite against a temp markdown root.
- **Versioned automatically.** Hourly git auto-commit on the markdown root; Litestream on `index.db`.

### Non-goals
- Multi-user / collaboration. Single user, single Mac.
- Cloud sync built in. Syncthing/iCloud/git handle "another device" if desired.
- Notion-style block editor. Markdown stays markdown.
- Native mobile app. PWA over Tailscale is enough.
- CRDT / multi-writer conflict resolution. Single device for now.

---

## 2. V1 + V2 → V3 consolidation

What we keep, replace, and retire:

| Layer | V1 (`main` / vanilla PWA) | V2 (`musing-austin` / Svelte scaffold) | V3 (this design) |
|---|---|---|---|
| Server | Plain JS Express, ~270 LOC, file-scan search | JS Express + SQLite/FTS5 + MCP + Ollama | **TypeScript Express + SQLite + MCP + Ollama** (port V2 forward) |
| MCP | None | 14 tools, stdio | **Same 14 + 8 new tools**, stdio + SSE transport |
| UI | Vanilla JS PWA, 600-LOC `app.js`, command palette, triage modal, theme cycle, View Transitions | Svelte 5 + Vite + Tailwind v4 + vite-plugin-pwa scaffold (4 views ported) | **One Svelte 5 + TS + Tailwind v4 + PWA app at `/`**, port V1's polish (palette, triage, theme) into Svelte components |
| Build | Static, no build step | `vite build` → `public/v2/` | **`vite build` → `public/`** (Express serves the built UI from `public/`) |
| Tests | None | `node --test` units (2 files) | **Vitest** units + **Playwright** E2E + integration suite |
| Backups | None | `ops/scripts/install-autocommit.sh` (manual) | **launchd plist** auto-installed + **Litestream** for `index.db` |
| LLM | None | `triage_inbox`, `summarize_day` | **+ briefing_morning, briefing_evening, dedupe_proposals, weekly_review, project_rollup, extract_todos_from_text, propose_archive, semantic_search** |

Retired:
- `main` branch's plain-JS server and `public/app.js` 600-LOC vanilla frontend.
- `public/v2/` route — the Svelte build moves to `/`.
- `dedup.mjs` one-off script — becomes the `dedupe_proposals` MCP tool.

Kept verbatim (no rewrite needed, just port to TS):
- `lib/util.ts` path sandbox + `applyToggle` ±N line search.
- `lib/markdown.ts` parser (todos, headings, frontmatter, due dates, tags, priorities).
- `lib/db.ts` SQLite schema + migrations.
- `lib/indexer.ts` chokidar → DB pipeline.
- `lib/llm.ts` Ollama client (already a clean 140 LOC).

---

## 3. System diagram

```
                ┌─────────────────────────────────────────┐
                │  ~/Documents/Liam_Plan/**/*.md          │ ← source of truth
                │  (configurable roots, excludeDirs)      │
                └─────────────────────────────────────────┘
                          ▲                  │
                          │ atomic writes    │ chokidar watch
                          │ (.tmp + rename)  ▼
   ┌──────────────────────┴───────────────────────────────┐
   │       Node 22 ESM TypeScript server (one process)     │
   │                                                        │
   │   ┌────────────┐  ┌──────────────┐  ┌──────────────┐  │
   │   │ HTTP API   │  │ MCP server   │  │ Indexer      │  │
   │   │ (Express)  │  │ (stdio + SSE)│  │ (chokidar +  │  │
   │   │            │  │              │  │  worker pool)│  │
   │   └─────┬──────┘  └──────┬───────┘  └──────┬───────┘  │
   │         │                │                  │         │
   │         └────────┬───────┴────────┬─────────┘         │
   │                  ▼                ▼                    │
   │           ┌────────────┐   ┌──────────────────┐        │
   │           │ data layer │   │ LLM gateway      │        │
   │           │ (markdown  │   │ (Ollama client + │        │
   │           │  + sqlite) │   │  prompt loader)  │        │
   │           └─────┬──────┘   └────────┬─────────┘        │
   └─────────────────┼───────────────────┼──────────────────┘
                     ▼                   ▼
              ┌──────────────┐    ┌────────────────────┐
              │ index.db     │    │ Ollama :11434      │
              │ FTS5 + vec0  │    │ qwen2.5:7b-instruct│
              │ (sqlite-vec) │    │ + nomic-embed-text │
              └──────────────┘    └────────────────────┘
                     │
                     ▼
              Litestream → ~/Backups/index-replicas/   (continuous)
              git auto-commit hourly → markdown history (launchd)
              Syncthing (optional, off-Mac) → markdown root mirror
```

---

## 4. Source tree (target)

```
companion-planning/
├── ARCHITECTURE.md
├── PLANNING.md
├── README.md
├── AUDIT.md
├── config.json                  roots, excludes, port, model, backup paths
├── config.example.json
├── tsconfig.json                strict, ESM, node 22, bundler resolution
├── tsconfig.node.json           server-only
├── tsconfig.ui.json             ui-only, dom lib
├── package.json                 workspaces: server + ui
├── pnpm-workspace.yaml
├── playwright.config.ts
├── vitest.config.ts
│
├── server/
│   ├── src/
│   │   ├── index.ts             entrypoint (Express + MCP + indexer)
│   │   ├── http.ts              HTTP routes
│   │   ├── mcp.ts               MCP tools (stdio + SSE)
│   │   ├── indexer.ts           chokidar → SQLite
│   │   ├── db.ts                better-sqlite3 + migrations + FTS5 + vec0
│   │   ├── llm/
│   │   │   ├── client.ts        Ollama HTTP client
│   │   │   ├── prompts.ts       prompt loader (markdown files)
│   │   │   ├── triage.ts        per-file cleanup
│   │   │   ├── briefing.ts      morning + evening narrative
│   │   │   ├── weekly.ts        weekly review generator
│   │   │   ├── rollup.ts        project / tag rollup
│   │   │   ├── extract.ts       text → structured todos
│   │   │   ├── archive.ts       propose archive candidates
│   │   │   └── embed.ts         semantic search (nomic-embed-text + vec0)
│   │   ├── markdown.ts          parser (todos/headings/frontmatter)
│   │   ├── backup.ts            litestream + git auto-commit supervision
│   │   ├── util.ts              path sandbox + applyToggle
│   │   └── types.ts             shared types (Todo, File, etc.)
│   ├── prompts/                 versioned LLM prompts (markdown)
│   │   ├── triage.md
│   │   ├── briefing-morning.md
│   │   ├── briefing-evening.md
│   │   ├── weekly-review.md
│   │   ├── project-rollup.md
│   │   ├── extract-todos.md
│   │   ├── propose-archive.md
│   │   └── dedupe.md
│   └── tests/
│       ├── unit/                vitest
│       │   ├── markdown.test.ts
│       │   ├── util.test.ts
│       │   ├── db.test.ts
│       │   └── llm.test.ts      (mocked Ollama responses)
│       └── integration/         vitest, runs against a tmp markdown root
│           ├── http.test.ts
│           ├── mcp.test.ts
│           └── indexer.test.ts
│
├── ui/
│   ├── src/
│   │   ├── main.ts
│   │   ├── App.svelte
│   │   ├── app.css              Tailwind v4
│   │   ├── lib/
│   │   │   ├── api.ts           typed HTTP client (shares server/types.ts)
│   │   │   ├── store.svelte.ts  runes-based stores
│   │   │   ├── shortcuts.ts     keyboard handler
│   │   │   └── sse.ts           live-reload subscriber
│   │   ├── components/
│   │   │   ├── Topbar.svelte
│   │   │   ├── CommandPalette.svelte    ← port from V1
│   │   │   ├── TodoItem.svelte
│   │   │   ├── TriageModal.svelte       ← port from V1 + LLM accept/dismiss
│   │   │   ├── Toast.svelte
│   │   │   ├── MarkdownView.svelte      ← marked + DOMPurify
│   │   │   ├── MarkdownEditor.svelte    ← CodeMirror 6
│   │   │   └── ThemeToggle.svelte
│   │   ├── views/
│   │   │   ├── Today.svelte
│   │   │   ├── Todos.svelte
│   │   │   ├── Files.svelte
│   │   │   ├── Search.svelte
│   │   │   ├── File.svelte              ← single-file view with edit toggle
│   │   │   ├── Briefing.svelte          ← LLM daily/weekly briefing
│   │   │   └── Settings.svelte
│   │   └── types.ts             re-exports server/types.ts
│   ├── index.html
│   ├── vite.config.ts
│   ├── svelte.config.js
│   └── tests/                   playwright
│       ├── smoke.spec.ts
│       ├── todo-flow.spec.ts    add/toggle/move/complete a todo end-to-end
│       ├── triage-flow.spec.ts  open file → run triage → accept item
│       ├── briefing.spec.ts     load briefing view, mock LLM, accept actions
│       └── pwa.spec.ts          install prompt, offline read
│
├── public/                       built UI output (gitignored)
├── ops/
│   ├── launchd/
│   │   ├── com.local.cp-server.plist
│   │   ├── com.local.cp-autocommit.plist
│   │   └── com.local.cp-litestream.plist
│   ├── litestream.yml
│   └── scripts/
│       ├── install.sh           pnpm install + build + register MCP + load plists
│       ├── install-autocommit.sh
│       └── restore.sh           litestream restore helper
└── .github/workflows/
    └── ci.yml                   typecheck + vitest + playwright + build
```

---

## 5. TypeScript model — shared types

Single source for both server and UI (`server/src/types.ts`, re-exported from `ui/src/types.ts`):

```typescript
export type ISODate = string;            // "2026-05-18"
export type ISODateTime = string;        // "2026-05-18T17:30:00Z"
export type Sha256 = string;             // 64-char hex

export interface FileRow {
  path: string;                          // absolute
  root: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
  sha256: Sha256;
  frontmatter: Record<string, unknown>;
}

export interface Todo {
  id: number;                            // DB row id
  hash: Sha256;                          // stable: sha256(path + heading + text)
  filePath: string;
  line: number;                          // best-effort; do not trust over time
  indent: string;
  text: string;
  checked: boolean;
  heading: string | null;
  tags: string[];
  due: ISODate | null;
  priority: 1 | 2 | 3 | null;
  doneOn: ISODate | null;
}

export interface TodoFilter {
  status?: 'open' | 'done' | 'all';      // default 'open'
  due?: 'today' | 'overdue' | 'this_week' | 'no_due';
  tag?: string;
  file?: string;                         // substring
  q?: string;                            // free text
  project?: string;                      // heading-derived
  limit?: number;                        // default 100, max 500
}

export interface Suggestion {
  kind: 'keep' | 'archive' | 'merge' | 'move' | 'rewrite' | 'mark_done' | 'set_due' | 'add_tag';
  todoHash: Sha256;
  rationale: string;
  // kind-specific payload
  target?: { path: string; heading: string };
  newText?: string;
  mergeWithHash?: Sha256;
  due?: ISODate;
  tag?: string;
}

export interface TriageResult {
  filePath: string;
  modelUsed: string;
  suggestions: Suggestion[];
  runtimeMs: number;
}

export interface BriefingResult {
  date: ISODate;
  kind: 'morning' | 'evening' | 'weekly';
  modelUsed: string;
  narrative: string;                     // 2-4 paragraphs
  highlights: { dueToday: Todo[]; overdue: Todo[]; recentlyDone: Todo[] };
  proposedActions: Suggestion[];
  runtimeMs: number;
}
```

The HTTP layer JSON-serializes these directly; the MCP layer wraps the same types in
the SDK's tool-call envelope. No translation layer.

---

## 6. SQLite schema (V3, additive over V2)

V2 already has `files`, `todos`, `headings`, `notes_fts`. V3 adds:

```sql
-- semantic search: 384-dim embeddings from nomic-embed-text
CREATE VIRTUAL TABLE notes_vec USING vec0(
  rowid INTEGER PRIMARY KEY,
  path TEXT,
  chunk INTEGER,
  embedding FLOAT[384]
);

-- LLM run history (so the UI can show "last triaged on X")
CREATE TABLE llm_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                    -- triage | briefing | rollup | ...
  scope TEXT,                            -- e.g. file_path or 'all'
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_hash TEXT NOT NULL,              -- so identical inputs can be cached
  result_json TEXT NOT NULL
);
CREATE INDEX llm_runs_kind_started ON llm_runs(kind, started_at DESC);

-- archive ledger: track LLM-proposed archive moves, accepted ones, etc.
CREATE TABLE archive_proposals (
  id INTEGER PRIMARY KEY,
  todo_hash TEXT NOT NULL,
  proposed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed
  decided_at INTEGER,
  llm_run_id INTEGER REFERENCES llm_runs(id)
);
```

`notes_vec` is optional — the build runs without `sqlite-vec` installed; semantic
search just returns `405 Not Configured` until the user opts in via `config.json`.

---

## 7. HTTP API (V3, additive over V2)

Existing V2 endpoints stay stable. V3 adds:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/llm/briefing` | `{ kind: morning\|evening\|weekly, date?: ISODate }` → `BriefingResult` |
| POST | `/api/llm/rollup` | `{ scope: { tag?: string; heading?: string; project?: string } }` → narrative + todo list |
| POST | `/api/llm/extract` | `{ text: string, defaultFile?: string }` → `{ todos: PartialTodo[] }` |
| POST | `/api/llm/archive` | `{ olderThanDays?: number, file?: string }` → archive proposals |
| GET | `/api/llm/runs?kind=&limit=` | History of past LLM runs |
| GET | `/api/semantic?q=&k=10` | Vector search (404 if `notes_vec` not enabled) |
| POST | `/api/todo/move` | `{ hash, destPath, destHeading }` — atomic cut/paste across files |
| POST | `/api/proposal/:id/accept` | Apply a stored proposal |
| POST | `/api/proposal/:id/dismiss` | Mark dismissed |

Existing endpoints (unchanged contract): `/api/files`, `/api/file` (GET/PATCH/PUT),
`/api/todos`, `/api/search`, `/api/stats`, `/api/llm/triage`, `/api/llm/summary`,
`/api/llm/status`, `/api/events` (SSE), `/api/config`.

---

## 8. MCP tool surface (V3)

V2 has 14 tools. V3 adds 8, totaling **22**. Every tool is typed via Zod schemas in
`server/src/mcp.ts` so the SDK can generate JSON schemas automatically.

### Inherited from V2
`list_files`, `read_file`, `write_file`, `append_section`, `list_todos`, `add_todo`,
`complete_todo`, `uncomplete_todo`, `search`, `stats`, `triage_inbox`, `summarize_day`,
`rescan`, `llm_status`.

### New in V3
| Tool | Purpose |
|---|---|
| `move_todo` | Atomic cut from `(srcPath, srcHash)` → append under `(destPath, destHeading)`. Updates index in same txn. |
| `briefing` | `{ kind: 'morning'\|'evening'\|'weekly', date?: ISODate }` → narrative + actions. |
| `project_rollup` | Generate a status update for a tag / heading / project. |
| `extract_todos_from_text` | Paste email/meeting notes/chat → structured `Suggestion[]` to insert. |
| `propose_archive` | Find old completed or stale-open items, return proposals. |
| `semantic_search` | Vector search via `notes_vec`. |
| `dedupe_proposals` | Cross-file dedup pass; returns merge suggestions. |
| `apply_suggestion` | Apply a `Suggestion` returned from any LLM tool (atomic, hash-guarded). |

Every mutating tool returns `{ ok, newSha256, diff }` so agents can verify and chain.
**No LLM output is auto-applied to disk** — `apply_suggestion` is the only path,
and it requires an explicit caller invocation.

---

## 9. LLM gateway

### Architecture
- Single `OllamaClient` (`server/src/llm/client.ts`) — typed wrapper over Ollama's
  `/api/generate`, `/api/chat`, `/api/embeddings`. Always `stream: false` for tool
  outputs; streaming pass-through only for the briefing's narrative paragraph (UX).
- All prompts live in `server/prompts/*.md` and are loaded via `prompts.ts` (caches
  on first read; re-reads on file change in dev mode).
- All tool outputs use Ollama's `format: "json"` + a Zod schema validator. On schema
  failure the gateway retries once with a corrective system message, then errors out
  to the caller. Never partial-apply garbled output.
- Every run is logged to `llm_runs` with `input_hash`; identical inputs within the
  same hour return the cached result (cheap idempotency).

### Models
| Role | Default | Memory | Fallback |
|---|---|---|---|
| Reasoning (triage, briefing, rollup, extract) | `qwen2.5:7b-instruct` | ~5 GB | `llama3.2:3b` |
| Embeddings (semantic search) | `nomic-embed-text` | ~270 MB | none — feature off |
| Large reasoning (weekly review, opt-in) | `qwen2.5:14b-instruct` | ~9 GB | reasoning default |

Selection is per-tool in `config.json`, e.g.:
```json
{
  "llm": {
    "host": "http://127.0.0.1:11434",
    "models": {
      "reasoning": "qwen2.5:7b-instruct",
      "embed": "nomic-embed-text",
      "weekly": "qwen2.5:14b-instruct"
    },
    "timeoutMs": 120000
  }
}
```

### Approval rule
> **No model output is ever written to disk without an explicit user (or agent)
> action that calls `apply_suggestion` (or a direct mutating tool).** Triage,
> briefing, archive proposals — all return plans; the UI shows them; the user
> clicks accept; *then* the file changes.

---

## 10. Testing strategy

Three layers, all green in CI before a release tag:

### Layer 1 — Unit (Vitest)
Fast, in-process, no I/O. ~50ms per file target.
- `markdown.test.ts` — todo parsing, frontmatter, due-date inference, edge cases (CRLF, nested checkboxes, escaped `[`).
- `util.test.ts` — `isPathInRoots`, symlink rejection, `applyToggle` ±N drift.
- `db.test.ts` — schema migration, FTS5 query, vec0 conditional skip.
- `llm.test.ts` — Ollama client with `fetch` mocked; schema validation, retry-once behavior, cache hit.

### Layer 2 — Integration (Vitest, slower)
Spawns a real `node dist/server.js` against a temp markdown root with seeded fixtures.
- `http.test.ts` — every route, end-to-end, with real SQLite.
- `mcp.test.ts` — start MCP stdio child, send tool calls, assert results.
- `indexer.test.ts` — chokidar events on a real temp dir; assert DB reflects them.

### Layer 3 — E2E (Playwright)
Spawns the server + opens the built UI in WebKit + Chromium.
- `smoke.spec.ts` — open `/`, see 4 nav buttons, hit each view, no console errors.
- `todo-flow.spec.ts` — click a todo checkbox → markdown file on disk has `[x]`.
- `triage-flow.spec.ts` — open a file → click Triage → mock the Ollama HTTP response → accept one suggestion → file content reflects the change.
- `briefing.spec.ts` — Briefing view loads with mocked LLM response; accept-action button calls the right API.
- `pwa.spec.ts` — manifest present, service worker registers, offline reload serves cached `/` and `/api/file` for last-viewed file.

### Mocking Ollama in tests
- Unit/integration: `vi.mock('../llm/client.ts')` with deterministic JSON responses.
- E2E: Playwright intercepts `/api/llm/*` and returns canned `BriefingResult` / `TriageResult` JSON. No real Ollama needed in CI.

### CI (`.github/workflows/ci.yml`)
```
typecheck → vitest (unit + integration) → playwright (chromium + webkit) → vite build
```
Total target: < 90s for the typecheck+unit+build path; full suite < 4 min.

---

## 11. Build & dev workflow

```
pnpm install                       # workspaces: server + ui
pnpm dev                           # parallel: tsx watch server/src/index.ts  +  vite dev (UI on :5173 proxy to :3847)
pnpm build                         # tsc -p server  +  vite build → public/
pnpm start                         # node dist/server.js --host 0.0.0.0
pnpm test                          # vitest run (unit + integration)
pnpm test:e2e                      # playwright test
pnpm typecheck                     # tsc --noEmit across both packages
```

Dev mode runs the UI on Vite's dev server with HMR; the API is proxied to the running
server. Build produces a single `public/` dir that the production server serves.

---

## 12. Security model (unchanged from V2, made explicit)

- **Trust boundary = Tailscale.** The server binds to `0.0.0.0` for tailnet access;
  reachable only via the user's tailnet. No per-request auth.
- **Path sandbox.** Every read/write resolves through `util.isPathInRoots` and rejects
  paths outside `config.directories[]` (after symlink resolution).
- **Atomic writes.** Write to `<file>.tmp.<pid>.<ts>` then `rename()`. PUT requires
  `expected_sha256`; PATCH uses content-hash todo IDs that survive line reflow.
- **LLM input stays local.** Ollama runs on-device. No network egress for LLM calls.
- **No LLM auto-writes.** See §9 approval rule.
- **MCP over SSE** is also behind Tailscale (`/mcp` endpoint, same trust boundary).
- **Headers.** `Content-Security-Policy: default-src 'self'`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: same-origin`. No third-party scripts.

---

## 13. Backups (layered, each handles a different failure mode)

| Layer | Tool | Recovers from |
|---|---|---|
| Versioning | `git` via launchd hourly auto-commit | "I deleted the wrong line." Restore via `git log` + `git checkout`. |
| DB durability | Litestream → `~/Backups/index-replicas/` | "The DB file corrupted." Restore via `litestream restore`. |
| Off-Mac mirror (optional) | Syncthing — markdown only, **never** `.db` | "The Mac died." |
| Off-site encrypted (optional) | restic weekly snapshot | "The house burned down." |

The auto-commit and Litestream plists are installed by `ops/scripts/install.sh`.
Syncthing and restic are documented but opt-in (each adds surface area the user
should choose deliberately).

---

## 14. Open questions for the V3 build

1. **pnpm vs npm.** Workspaces work cleanly in both. Default: pnpm for speed + strict
   hoisting. Revisit if the user has a preference.
2. **CodeMirror 6 bundle size.** ~150 KB gzipped. Worth it for edit mode? Yes — but
   lazy-load it so first paint stays fast.
3. **Should the briefing email itself?** Tempting (calendar integration is "in the
   air"). Out of scope for V3; revisit in V4.
4. **iOS PWA "install" prompt UX.** Apple still doesn't auto-prompt. Document the
   Share → Add to Home Screen flow on the Settings page.
5. **Where to keep `.data/` (SQLite DB).** Currently next to repo. Move to
   `~/Library/Application Support/CompanionPlanning/` for cleaner uninstall?
   Default: keep next to repo for dev simplicity; document the env var override.

See [PLANNING.md](PLANNING.md) for the phased path to ship V3.
