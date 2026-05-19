# Planning — Private Markdown Todo App (v2)

Companion to [ARCHITECTURE.md](ARCHITECTURE.md). This is the "how we get there"
document: current state, decisions, phases, risks.

---

## 1. Current state inventory

Two variants of the prototype exist in this repo (see [memory note](../../../../../../.claude/projects/-Users-liam-devel-personal-companion-planning/memory/project_ai_todo_static_branches.md)
if revisiting later):

### What works today (newer `companion/musing-austin-4dd678` branch)
- Node 22 + Express, single process, ~270 LOC server.
- Watches configured roots with chokidar; warm in-memory cache of parsed files.
- `lib/util.js` has hardened `isPathInRoots` and an `applyToggle` that already does
  ±N-line search around `expectedText` — the line-drift problem is partially solved.
- HTTP API: `/api/files`, `/api/file` (GET/PATCH), `/api/search`, `/api/config`,
  `/api/events` (SSE).
- Vanilla JS frontend (~600 LOC `app.js`, ~720 LOC CSS): file tree, search box,
  markdown render, mobile drawer.
- `node --test` test for the toggle logic.
- `--host 0.0.0.0` flag works; binds correctly for Tailscale.
- Indexes 164 .md files from `~/Documents/Liam_Plan` (verified live this session).

### What's missing or broken
- **No MCP server.** The whole point of v2.
- **No SQLite / no FTS index.** `/api/search` is a linear scan of every file on
  every keystroke. Fine at 164 files; will crawl at 5,000+.
- **No LLM integration.** No triage, no dedupe, no summarization.
- **No structured todo model.** Todos exist only as "lines that match a regex" —
  no stable IDs, no due dates, no tag index, no project rollup.
- **No backups.** Manual git commits only. No auto-commit, no DB replication.
- **UI is brittle.** 600-line ad-hoc JS; state management is a pile of globals.
  Mobile usable but not pleasant.
- **No HTTPS / no auth.** Trust boundary is implicit ("only on Tailscale") and
  undocumented.
- **Two worktrees + stale stashes.** Codebase confusion: `main` is the old version,
  the running code is on a different branch, and a third (`codex/companion-planning-rewrite`)
  exists only in stashes. Needs cleanup before v2 lands on a real branch.

---

## 2. Decision log

### Locked in
| # | Decision | Why |
|---|----------|-----|
| 1 | **Evolve current code; don't fork SilverBullet** | Existing 270-line server is small enough to grow. SilverBullet is great but forking it inverts the work direction: we'd spend time conforming our markdown to its model, not adding our features. Reconsider only if Phase 3 (UI rewrite) overruns badly. |
| 2 | **Markdown = truth, SQLite = derived index** | Matches user's "flexible markdown" goal. Dropping the DB and rebuilding is a feature, not a fear. |
| 3 | **Single process, no Docker** | This is one user on one Mac. Compose / k8s is overhead. `launchctl` is the orchestrator. |
| 4 | **Ollama as the LLM stack** | Easiest install on Mac, swappable for native MLX later via the gateway abstraction. |
| 5 | **Tailscale-only trust boundary, no auth** | Matches the user's current model. Adding auth later is straightforward (signed cookies + login page). |
| 6 | **MCP via official TypeScript SDK** | Stay close to the ecosystem; SDK handles transport, schema, errors. |
| 7 | **Stable todo IDs via content-hash, not line number** | Resolves the line-drift class of bugs once and for all. |

### Considered & rejected
| Alternative | Why rejected |
|-------------|--------------|
| Fork SilverBullet | See #1. Also: their Lua scripting layer is not where we want to invest. |
| Use Vikunja + write an MCP shim | DB-backed, not markdown-on-disk. Loses the "edit any file in vim" property. |
| Build native Mac app (Swift) | Phone-over-Tailscale forces a web client anyway. Doing both is 2x work. |
| Postgres / DuckDB instead of SQLite | Single user, single host. SQLite is the right size; FTS5 ships in the binary. |
| Build our own embed server (transformers.js) | Ollama already does this. Don't reinvent. |
| LangChain / LlamaIndex orchestration | Overkill. We have ~5 LLM prompts. A 30-line client beats a framework. |
| Real-time sync (CRDT) | Single device for now. Add only if multi-device write is ever requested. |

---

## 3. Phased roadmap

Each phase is shippable on its own. The current app keeps working through every
phase — no "big bang rewrite."

### Phase 0 — Cleanup (½ day)
**Goal:** stop the branch-soup; one clear place to build v2.

- [ ] Merge `companion/musing-austin-4dd678` into `main` (or delete `main`'s old code
      and replace). Tag the pre-merge `main` as `legacy-plain-js`.
- [ ] Delete `companion/happy-mcnulty-4c28e9` worktree after migrating these two docs.
- [ ] Garbage-collect the `codex/companion-planning-rewrite` stashes once any wanted
      bits (PWA scaffolding?) are cherry-picked.
- [ ] Update README.md with the new direction and a "quick start" that actually
      reflects what's running.
- [ ] Move both docs (`ARCHITECTURE.md`, `PLANNING.md`) to repo root on `main`.

**Done when:** `git branch` shows one active branch besides `main`, and the running
code is on `main`.

### Phase 1 — Indexer & SQLite (1–2 days)
**Goal:** kill the per-request file scans. Stable todo IDs.

- [ ] Add `better-sqlite3` dependency.
- [ ] `server/db.js`: schema from ARCHITECTURE §3.4; migration runner.
- [ ] `server/markdown.js`: parse a file into `{ frontmatter, headings[], todos[] }`.
      Todos get hashes: `sha256(path + heading + text)`.
- [ ] `server/indexer.js`: chokidar → upsert into SQLite inside a transaction per file.
      Initial scan parallelized with a worker pool (4 workers).
- [ ] Replace `/api/files` and `/api/search` to query SQLite + FTS5 instead of scanning.
- [ ] Replace `/api/file` PATCH to look up todo by **hash**, not line index. (Keep
      line-search fallback for back-compat.)
- [ ] Tests: indexer correctness (`node --test`), FTS query, atomic write.

**Done when:** `/api/search?q=...` returns in <50ms with 5,000 files, and todo
checkbox toggles never drift even with concurrent edits.

### Phase 2 — MCP server (1–2 days)
**Goal:** Claude/agents can do everything the UI can.

- [ ] Add `@modelcontextprotocol/sdk`.
- [ ] `server/mcp.js`: register the 13 tools from ARCHITECTURE §3.2.
- [ ] Mount on stdio (for local Claude Code) AND `/mcp` SSE (for remote agents).
- [ ] Internal: every tool delegates to the same functions the HTTP API uses (one
      data layer, two transports).
- [ ] Document the tool surface in `README.md` with one example per tool.

**Done when:** `claude mcp add plan-mcp -- node server.js --mcp` works, and Claude
can `list_todos filter=today`, complete a real todo, and the change appears in the
markdown file.

### Phase 3 — UI rewrite (3–5 days)
**Goal:** mobile-pleasant, fast, PWA.

- [ ] Decide SvelteKit vs. Vite+Svelte at start of phase (lean SvelteKit for routing).
- [ ] Scaffold `ui/`; static adapter; Express serves `ui/build/` in production.
- [ ] Routes: `/`, `/today`, `/file/[path]`, `/search`.
- [ ] Components: file tree, todo list (filterable), markdown view, CodeMirror edit
      mode with a toggle.
- [ ] PWA manifest + service worker (read API cache, last-viewed file offline).
- [ ] Keyboard shortcuts: `/` focus search, `j/k` move, `x` toggle, `e` edit.
- [ ] Live updates via existing SSE.

**Done when:** Phone-installed PWA loads offline (read-only), and the desktop UI
feels at least as fast as Obsidian for our workflow.

### Phase 4 — Local LLM cleanup (1–2 days)
**Goal:** the user can hit "triage" and have a messy file proposed for cleanup.

- [ ] Install Ollama; pull `qwen2.5:7b-instruct` and a small fallback (`llama3.2:3b`).
- [ ] `server/llm.js`: thin HTTP client; JSON-mode wrapper; streaming pass-through.
- [ ] `prompts/triage.md`, `prompts/summarize_day.md`, `prompts/dedupe.md`.
- [ ] HTTP routes: `/api/llm/triage`, `/api/llm/summary`.
- [ ] MCP tools: `triage_inbox`, `summarize_day`.
- [ ] UI: triage panel showing proposed moves/dedupes per-item, approve to apply.
- [ ] **Approval rule**: no LLM output ever writes to disk without an explicit user
      or agent action that calls the corresponding mutating tool.

**Done when:** the user can run "triage today" on a messy `TOMORROW_TODO.md` and
get a proposed reorganization they can review and accept item by item.

### Phase 5 — Backups (½ day)
**Goal:** versioned history and DB durability without thinking about it.

- [ ] `ops/launchd/com.local.plan-autocommit.plist`: hourly git auto-commit job on
      the markdown root (only if changes exist).
- [ ] Install Litestream; `ops/litestream.yml` replicates `index.db` to
      `~/Backups/index-replicas/`. Add as launchd-managed service.
- [ ] Documented restore procedure in README (`litestream restore`).
- [ ] **Optional**: Syncthing setup notes for off-Mac mirror; document the rule
      "Syncthing covers `.md` files, never `.db` files."

**Done when:** deleting `index.db` and `markdown-root/somefile.md` both have a
documented one-command recovery path.

### Phase 6 — Polish & open up (1 day)
- [ ] HTTPS via Tailscale's `tailscale serve` (handles cert automatically).
- [ ] Settings page in the UI: model selection, root management, backup status.
- [ ] `health` endpoint and a simple status dashboard.
- [ ] Move repo public on GitHub if user wants; pick a license (default: MIT).

**Done when:** the user is comfortable running this as their daily driver.

---

## 4. Day-1 next steps (do these first)

Concrete tasks for the very next session, in order:

1. **Stop the running server** from this session (`kill 63722`) — config got pointed
   at `~/Documents/Liam_Plan`; user may want to revert to old config or keep it.
   Decide explicitly and commit `config.json` to the chosen state.
2. **Run Phase 0 cleanup.** Merge the newer branch into main, tag the legacy one,
   move these two docs to repo root.
3. **Start Phase 1 with the schema and indexer.** First measurable win: replace the
   file-scan search with FTS, observe latency drop.

Phases 1 and 2 are the load-bearing ones — they unlock everything else. Phase 3 (UI)
is the longest single phase; do it only after MCP works, so the UI can be a thin
client over the same primitives.

---

## 5. Risks & mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Scope creep in UI phase | High | High | Defer aesthetic polish; ship plain-but-fast first. Re-skin in Phase 6 if there's time. |
| Ollama model output unreliable (bad JSON, hallucinated paths) | Medium | Medium | JSON-mode + schema validation; treat LLM output as suggestion not action. Have a "discard" button on every triage suggestion. |
| Indexer hits OS file-watch limits with deep roots | Low | Medium | chokidar already supports `usePolling`; document the `ulimit -n` workaround. |
| SQLite + Syncthing data corruption | Medium | High | **Never** sync the `.db` file via Syncthing. Litestream handles DB; Syncthing handles `.md` only. Make this an explicit warning in README. |
| MCP SDK breaking changes | Medium | Low | Pin the SDK version; track upstream releases monthly. |
| Apple Silicon perf with 7B model (M1/M2 8GB) | Low | Medium | Document the 3B fallback; surface model choice in UI settings. |
| User abandons before Phase 4 | n/a | High to the goal | Phases 1–3 must each be useful standalone. Don't gate "value" on the LLM phase. |

---

## 6. Out-of-scope reminders

These are tempting but not v2:
- Calendar / iCal integration.
- Email-to-todo capture.
- Browser extension for "save this page as a todo."
- Team mode / sharing.
- Cloud LLM fallback (defeats the goal).
- Native Mac/iOS app.
- Plugin system.

Re-open these conversations only after v2 ships and is in daily use for ≥ 4 weeks.

---

## 7. References

External inspiration informing this plan (from the v2 research pass):
- [SilverBullet](https://github.com/silverbulletmd/silverbullet) — closest existing
  shape; reference for what "good" looks like in this niche.
- [usememos/memos](https://github.com/usememos/memos) — REST/gRPC API ergonomics.
- [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) —
  surgical-edit MCP tool design.
- [aleksakarac/obsidian-mcp](https://github.com/aleksakarac/obsidian-mcp) — broadest
  filesystem-native MCP tool surface; mine for tool-shape ideas.
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) —
  official reference servers (filesystem, todoist).
- [benbjohnson/litestream](https://github.com/benbjohnson/litestream) — DB backups.
- [sqliteai/sqlite-memory](https://github.com/sqliteai/sqlite-memory) — markdown +
  SQLite + FTS5 + sqlite-vec pattern.
- [Ollama](https://ollama.com/) and [MLX-LM](https://github.com/ml-explore/mlx-lm) —
  local model runtimes.
