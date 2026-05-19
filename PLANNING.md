# Planning — Companion Planning (V3)

Companion to [ARCHITECTURE.md](ARCHITECTURE.md). This is the "how we get there"
document: current inventory, decision log, phased roadmap, risks, day-1 next steps.

> Today: **2026-05-18**. Target V3 ship: **2026-06-22** (5 weeks).
> Hard constraint: the current app keeps working through every phase. No big-bang rewrite.

---

## 1. Current state inventory (2026-05-18)

Three branches, one product. The plan is to consolidate to **one branch on `main`** with V3.

### What's live & working
The running build is `companion/musing-austin-4dd678` (this worktree). Verified live this
session against `~/Documents/Owner_Plan`:

- **Server (JS, ~1.4k LOC across `lib/`)**: Express, chokidar watcher, better-sqlite3
  with FTS5, ESM, `--host 0.0.0.0` flag working over Tailscale.
- **Indexer**: 118 files / 1014 todos / 909 open / 405 overdue / 10 due today.
- **MCP server**: 14 tools registered, stdio transport, wired into Claude Code.
- **LLM gateway**: `lib/llm.js` Ollama client (140 LOC, clean). `triage_inbox` and
  `summarize_day` tools wired.
- **Tests**: `node --test` units for `util` and `markdown` only.
- **Backups**: `ops/scripts/install-autocommit.sh` exists but not auto-installed.
- **PWA**: Stage-1 vanilla PWA (V1) served at `/`. Stage-2 Svelte 5 + Vite + Tailwind
  v4 scaffold served at `/v2/`. Four views ported in V2: Today / Todos / Files / Search.
  Bundle ~55 KB JS / 20 KB gzipped.

### What's rough or missing
- **No TypeScript anywhere.** All `.js`, no shared types, no strict-mode compiler.
- **Dual UI** (`/` vanilla V1 + `/v2/` Svelte V2) — confusing, two SWs, two
  PWA manifests, doubled maintenance.
- **V2 is a half-port.** Command palette, triage modal accept/dismiss, theme toggle,
  briefing/LLM views — all live in V1's `public/app.js`; V2 doesn't have them yet.
- **No E2E tests.** A markdown-app with concurrent writes and atomic-write logic
  needs Playwright; unit tests alone don't catch UI-side race conditions.
- **LLM surface is thin.** Only triage + day-summary. No briefing variants
  (morning/evening/weekly), no project rollup, no extract-from-text, no archive
  proposals, no semantic search.
- **No Litestream.** `index.db` durability is "manually backed up" (i.e. not).
- **Two stashes (`codex/companion-planning-rewrite`)** still exist with WIP from the
  PWA + Ollama work that landed elsewhere. Should be GC'd.
- **Memory file is stale**: `project_companion_planning_branches.md` still calls
  `musing-austin-4dd678` "the newer rewrite" — accurate for now, but post-V3 it
  should point at `main`.

### Branch landscape
| Branch | Tip | Role |
|---|---|---|
| `main` | `2ad19dc` | OLD — pre-V2 vanilla JS, merged from `happy-mcnulty-4c28e9` |
| `companion/happy-mcnulty-4c28e9` | `b86b93e` | OLD — duplicate of main + rebrand commit. Holds the original V2 design docs we just superseded. |
| `companion/musing-austin-4dd678` | `4fbde2e` | **CURRENT** — V2 codebase + Stage-1 PWA + Stage-2 Svelte scaffold |
| `companion/charming-spence-63ae3a` | `2ad19dc` | This worktree (planning-only, no code) |

---

## 2. Decision log

### Locked in for V3
| # | Decision | Why |
|---|---|---|
| 1 | **TypeScript everywhere, strict mode** | Shared types between server and UI eliminate a whole class of bugs (already several mismatches between V1's `app.js` and V2's `store.svelte.js`). |
| 2 | **One UI: Svelte 5 + TS at `/`, retire `/v2/` and vanilla `app.js`** | The dual-UI was a transitional artifact. Time to pick one. |
| 3 | **pnpm workspaces** | Server + UI share types; pnpm hoisting is strict so version drift surfaces fast. |
| 4 | **Vitest for units + integration** | TS-native, faster than `node --test`, runs the same test files in CI without a separate runner config. |
| 5 | **Playwright for E2E** | Real WebKit + Chromium = catches the actual PWA install + iOS quirks. |
| 6 | **Ollama stays the LLM stack** | Already integrated, MLX swap stays a Phase-D option via the gateway abstraction. |
| 7 | **Zod schemas at every LLM boundary** | JSON-mode is necessary but not sufficient; schema-validate or retry-once. |
| 8 | **No LLM auto-write** | All LLM output is a `Suggestion[]`; only `apply_suggestion` writes. |
| 9 | **MCP gets 8 new tools, total 22** | See ARCHITECTURE §8. Every new LLM feature also surfaces over MCP. |
| 10 | **Markdown stays truth; SQLite is rebuildable** | Same V2 invariant, made explicit in tests. |

### Considered & rejected (or deferred)
| Alternative | Verdict |
|---|---|
| SolidStart / Qwik / React | Svelte 5 + runes is already scaffolded and small. No reason to switch. |
| tRPC | Overkill for ~20 endpoints; typed `api.ts` client + shared types is enough. |
| Drizzle / Prisma | `better-sqlite3` + raw SQL is 30 LOC of `db.ts`. ORMs don't pay off at this scale. |
| LangChain / LlamaIndex | Same as V2 — overkill for ~8 prompts. |
| Real-time CRDT sync | Out of scope; single device. Re-open if/when multi-device write lands. |
| Replace Express with Hono / Fastify | Express works. Don't migrate twice (TS + framework) in one cycle. |

---

## 3. Phased roadmap to V3 (5 weeks)

Each phase is shippable on its own. Current app keeps working until Phase B flips
the default UI; even then `/v1/` stays available for one release.

### Phase A — TypeScript migration (week 1)
**Goal:** strict-mode TS server passes `tsc --noEmit` with the same behavior. No
feature work.

- [ ] Add root `tsconfig.json` + `tsconfig.node.json` + `tsconfig.ui.json`. Strict mode, ESM, `module: NodeNext`. (due: 2026-05-21)
- [ ] Set up `pnpm-workspace.yaml`; split into `server/` and `ui/` packages. (due: 2026-05-21)
- [ ] Port `lib/*.js` → `server/src/*.ts` file-by-file, smallest first: `util` → `markdown` → `db` → `indexer` → `llm` → `mcp`. Each file lands in its own commit with green tests. (due: 2026-05-23)
- [ ] Port `server.js` → `server/src/index.ts` + `server/src/http.ts`. Express route handlers typed via shared `types.ts`. (due: 2026-05-23)
- [ ] Port `mcp-stdio.js` → `server/src/mcp.ts` Zod schemas; re-register tools via SDK. (due: 2026-05-24)
- [ ] Port the 2 existing `node --test` files to Vitest. (due: 2026-05-24)
- [ ] CI workflow: typecheck + vitest. (due: 2026-05-24)

**Done when:** `pnpm typecheck && pnpm test && pnpm start` works on the TS server, all
HTTP + MCP endpoints behave identically (validated by the same V2 test scenarios), and
no `.js` files remain in `lib/` (except a one-line `mcp-stdio.js` shim if Claude Code
needs it).

### Phase B — UI consolidation (week 2)
**Goal:** one UI at `/`, in TS-Svelte, with V1's polish ported. Kill `/v2/`.

- [ ] Convert `ui/` to TypeScript: `vite.config.ts`, `App.svelte` with `<script lang="ts">`, `store.svelte.ts`. (due: 2026-05-26)
- [ ] Generate a typed API client (`ui/src/lib/api.ts`) from `server/src/types.ts`. No hand-written `fetch` calls in views. (due: 2026-05-27)
- [ ] Port V1 polish into Svelte components:
  - [ ] `CommandPalette.svelte` (⌘K: commands + files + todos, ↑↓ Enter Esc). (due: 2026-05-28)
  - [ ] `TriageModal.svelte` (accept/dismiss/rewrite with hash-guarded `PATCH /api/file` + `PUT /api/file`). (due: 2026-05-29)
  - [ ] `ThemeToggle.svelte` (auto/light/dark cycle, persisted, theme-color meta sync). (due: 2026-05-29)
  - [ ] Keyboard shortcuts (`/` search, `g+t/a/f/s` views, `?` help). (due: 2026-05-29)
- [ ] `File.svelte` view: read markdown with `marked` + `DOMPurify`; toggle to CodeMirror 6 edit mode (lazy-loaded). (due: 2026-05-30)
- [ ] Vite PWA: one manifest, one SW, scoped to `/`. Workbox runtime cache for `/api/file` and `/api/files`. (due: 2026-05-30)
- [ ] Express now serves the built UI from `public/` at `/`. Old `public/app.js` + `public/v2/` removed. Add a 301 from `/v2/*` → `/` for one release. (due: 2026-05-30)

**Done when:** the iPhone PWA installed at the Tailscale URL shows the new Svelte UI
with everything V1 could do, plus typed-end-to-end safety.

### Phase C — Testing (week 3)
**Goal:** every release builds green or doesn't ship.

- [ ] `vitest.config.ts` with separate `unit/` and `integration/` projects. (due: 2026-06-02)
- [ ] Integration suite: spawn server against a tmp markdown root with `tmp-promise` fixtures. (due: 2026-06-04)
  - [ ] `http.test.ts` — every route, including PUT concurrency rejection, PATCH hash-drift recovery, SSE event delivery.
  - [ ] `mcp.test.ts` — spawn the stdio child, send tool calls, assert results + side-effects on disk.
  - [ ] `indexer.test.ts` — fire chokidar events on the temp dir, assert DB convergence.
- [ ] `playwright.config.ts` with WebKit + Chromium projects; `webServer` config spawns the built server. (due: 2026-06-05)
- [ ] E2E suite (see ARCHITECTURE §10):
  - [ ] `smoke.spec.ts` — basic navigation. (due: 2026-06-05)
  - [ ] `todo-flow.spec.ts` — checkbox click → markdown file on disk updates. (due: 2026-06-05)
  - [ ] `triage-flow.spec.ts` — mock Ollama with `page.route()`, accept a suggestion. (due: 2026-06-06)
  - [ ] `pwa.spec.ts` — manifest present, SW registers, offline read works. (due: 2026-06-06)
- [ ] CI: full pipeline (typecheck + vitest + playwright + build), <4 min. (due: 2026-06-07)
- [ ] Add `pre-commit` hook (lefthook or simple shell): typecheck + vitest unit. (due: 2026-06-07)

**Done when:** opening a PR runs the full pipeline; main branch is green; flaky-test
budget is zero.

### Phase D — LLM expansion (week 4)
**Goal:** the briefing/triage/rollup loop is good enough that the user opens the
app first-thing in the morning instead of email.

Each item below = one prompt file in `server/prompts/`, one route, one MCP tool, one
UI surface, and tests in all three layers.

- [ ] **`briefing` (morning/evening/weekly)** — narrative + highlights + proposed actions. Streams the narrative paragraph through SSE; actions returned as `Suggestion[]`. (due: 2026-06-09)
  - Morning: "what's due today, what's overdue, what's notable on the calendar (read-only from the user's calendar if MCP calendar tool is registered)."
  - Evening: "what got done, what carried over, what to set up for tomorrow."
  - Weekly: "what shipped, what slipped, top 5 for next week" — uses the larger `qwen2.5:14b` model.
- [ ] **`project_rollup`** — given a tag/heading/project, generate a status update suitable for pasting into Slack/email. (due: 2026-06-10)
- [ ] **`extract_todos_from_text`** — paste an email or meeting notes; get back `Suggestion[]` of new todos with inferred due dates and tags. (due: 2026-06-10)
- [ ] **`propose_archive`** — sweep for: completed-30d-ago todos still in active files, open todos with no movement for >60d, headings whose contents are 100% checked. Returns `archive_proposals` rows. (due: 2026-06-11)
- [ ] **`dedupe_proposals`** — port `dedup.mjs` into the LLM pass; merge near-duplicate todos across files with rationale. (due: 2026-06-11)
- [ ] **`semantic_search`** — optional. `notes_vec` (vec0) with `nomic-embed-text` embeddings, 384-dim, chunked at headings. Off by default; flag in `config.json`. (due: 2026-06-12)
- [ ] **`apply_suggestion`** — the only path from LLM output to disk. Atomic, hash-guarded, idempotent. Logs to `llm_runs` and `archive_proposals`. (due: 2026-06-12)
- [ ] UI: `Briefing.svelte` view with morning/evening/weekly tabs; accept/dismiss per-action; "last run" stamp from `llm_runs`. (due: 2026-06-13)

**Done when:** the user opens `/` in the morning, hits "Briefing", reads 3 paragraphs,
accepts 3 actions, and closes the app — and that flow takes < 60 seconds end-to-end.

### Phase E — Polish, backups, ship (week 5)
- [ ] launchd plists for: server (auto-start), git auto-commit (hourly), Litestream (continuous). `ops/scripts/install.sh` registers all three. (due: 2026-06-16)
- [ ] Settings view: model selection, root management, backup status, embedding-feature toggle. (due: 2026-06-17)
- [ ] Health endpoint `/api/health` + simple status dashboard tile on the homepage. (due: 2026-06-17)
- [ ] HTTPS via `tailscale serve` documented in README; cert is automatic. (due: 2026-06-18)
- [ ] **Phase 0-style cleanup**: merge `companion/musing-austin-4dd678` → `main`. Tag pre-merge `main` as `legacy-v1`. Delete `companion/happy-mcnulty-4c28e9` worktree + branch. GC `codex/companion-planning-rewrite` stashes after harvesting any wanted bits. (due: 2026-06-20)
- [ ] Update `~/.claude/projects/.../memory/project_companion_planning_branches.md` to point at `main`. (due: 2026-06-20)
- [ ] Cut **v3.0.0** tag. Update README quick-start. (due: 2026-06-22)

**Done when:** `git checkout main && pnpm install && pnpm build && pnpm start` from a
fresh clone gets you a fully-working app, all tests green, with one MCP registration
command and one launchd install command.

---

## 4. Day-1 next steps (do these first)

Before Phase A even starts, do these housekeeping tasks. Each is < 30 minutes:

1. **Lock the current running build** — tag `companion/musing-austin-4dd678@4fbde2e`
   as `v2.0.0-pre-typescript` so we have a known-good fallback.
2. **Restart the running server** with the post-edits config (already done this
   session); verify `/api/stats` returns the expected `1014 / 909 / 405 / 10`.
3. **Restart the MCP** so the localtime + frontmatter-Date fixes land (already
   instructed; verify by checking `due_today` in `mcp__companion-planning__stats`
   matches the HTTP `/api/stats` value).
4. **Create an issue tracker** — even a single `ISSUES.md` in the repo, one section
   per phase, one checkbox per item from this file. The MCP server itself can be the
   tracker (eat your own dogfood) — point the indexer at the repo's `ISSUES.md`.
5. **Decide pnpm vs npm now.** If pnpm, run `corepack enable && corepack prepare pnpm@latest --activate`.
6. **Spike the TS conversion of `lib/util.js`** (smallest file, 76 LOC) end-to-end —
   tsconfig, build, test, commit. This validates the whole Phase A pipeline in one
   afternoon before committing to the file-by-file march.

---

## 5. Risks & mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| TS port introduces subtle behavior changes (especially around `applyToggle` line-drift) | Medium | High | Port unit + integration tests *before* moving any production code; require behavior-identical green tests in each TS commit. Pin V2 as `v2.0.0-pre-typescript` for diffing. |
| Svelte component port leaves V1 features behind | High | Medium | Phase-B exit criterion is feature-parity diff vs V1's `app.js`. Don't merge Phase B without a side-by-side checklist. |
| Playwright flakes on PWA service-worker tests | High | Low | Use `page.route()` to deterministically mock `/api/llm/*`; pin WebKit + Chromium versions; allow `retries: 2` on E2E only. |
| Ollama prompt outputs invalid JSON | Medium | Medium | Zod-validate every response; auto-retry once with a corrective system message; if still bad, return `{ ok: false, error }` to the UI, never partial-apply. |
| Semantic search adds latency without enough value | Low | Low | Behind a config flag. If `notes_vec` is off, the route returns 404 and the UI hides the entry. |
| Litestream missetup corrupts `index.db` | Low | High | `index.db` is fully derivable from markdown. Document: if recovery is needed and Litestream replica is suspect, just delete `index.db` and run `pnpm start` — full reindex from disk. |
| User abandons before Phase D | n/a | High to the goal | Phases A, B, C are each useful standalone — TS-only app, polished single UI, real test coverage. Don't gate "value" on the LLM expansion. |
| Phone PWA cache pins old build | Medium | Low | Bump the SW version on every Phase boundary. Document `Settings → Reset cache` button on iOS. |

---

## 6. Out-of-scope for V3 (revisit only after ship)

- Calendar write-back (read-only via existing Google Calendar MCP is fine).
- Email-to-todo automatic capture (manual paste via `extract_todos_from_text` is enough).
- Multi-user / team mode.
- Cloud LLM fallback (defeats the goal).
- Native Mac/iOS app.
- Plugin system / third-party tool registration.
- Browser extension.
- Voice → todo (Whisper.cpp on-device is tempting, deferred).
- Mobile push notifications.

Re-open any of these after v3.0.0 has been in daily use for ≥ 4 weeks.

---

## 7. Where each piece of V3 lives in the repo at the end

| Deliverable | Lands in |
|---|---|
| TS server | `server/src/` |
| TS UI | `ui/src/` |
| Shared types | `server/src/types.ts` (re-exported from `ui/src/types.ts`) |
| Prompts | `server/prompts/*.md` |
| Tests | `server/tests/{unit,integration}/` + `ui/tests/` (Playwright) |
| Ops | `ops/launchd/*.plist`, `ops/litestream.yml`, `ops/scripts/install.sh` |
| Docs | `ARCHITECTURE.md`, `PLANNING.md`, `README.md`, `AUDIT.md` (this set) |
| CI | `.github/workflows/ci.yml` |
| Single config | `config.json` (with `config.example.json` as the template) |

---

## 8. References

External inspiration (informing Phase D especially):
- [SilverBullet](https://github.com/silverbulletmd/silverbullet) — reference for "good" in this niche.
- [Obsidian](https://obsidian.md) — UX baseline for what users expect.
- [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) — surgical-edit MCP tool design.
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) — official reference MCP servers.
- [Ollama](https://ollama.com/), [MLX-LM](https://github.com/ml-explore/mlx-lm) — local model runtimes.
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — semantic-search vector extension.
- [Litestream](https://litestream.io) — DB durability done right.
- [Vitest](https://vitest.dev), [Playwright](https://playwright.dev) — the test stack.

---

*Drafted 2026-05-18. Owner: Liam. Review checkpoints at each phase boundary
(2026-05-24, 05-30, 06-07, 06-13, 06-22).*
