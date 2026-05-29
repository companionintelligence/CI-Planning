# Architecture — Companion Planning (V4.1)

Status: shipped, 2026-05-29. Supersedes the V3 design.
A **TypeScript, MCP-native, local-first** planning system that any agent harness can
attach to. Markdown is the source of truth; SQLite is a rebuildable index; Google
Calendar is the time-commitment layer; local LLMs (Ollama) author summaries and
extract tasks.

> **Three sources of truth, kept consistent:**
> 1. **Markdown files** on disk — narrative, structure, checkboxes (what you wrote)
> 2. **SQLite index** — queryable, rebuildable from markdown alone (what the computer sees)
> 3. **Google Calendar** — time blocks and committed hours (what you've agreed to)
>
> The system's job is to keep all three aligned and surface conflicts — e.g.
> "8 hours of meetings Thursday but 14 hours of open tasks due."

---

## 1. System overview

```
                ┌──────────────────────────────────────────┐
                │  ~/Documents/Liam_Plan/**/*.md            │  ← source of truth
                │  + Summaries/{Daily,Weekly,Monthly}/*.md  │
                └──────────────────────────────────────────┘
                       ▲                    │ chokidar watch
            atomic     │ writes             ▼ (+ optional auto-extract)
            (.tmp+rename)         ┌───────────────────────────────┐
                       │          │  Node 22 ESM TS server (1 proc)│
   ┌───────────────────┴──────────┤                                │
   │  HTTP API (Express)          │   indexer · markdown · db      │
   │  MCP stdio  (mcp-stdio.js)   │   summary · calendar bridge    │
   │  MCP HTTP   (POST /mcp)  ◄────┼── remote agents on Tailscale   │
   │  SSE        (/api/events)    │   llm gateway (Ollama)         │
   └───────────────────┬──────────┴───────────────┬────────────────┘
                       ▼                           ▼
                ┌────────────┐            ┌──────────────────┐
                │ index.db   │            │ Ollama :11434    │
                │ FTS5       │            │ (summaries,      │
                │ + V4 tables│            │  extraction)     │
                └────────────┘            └──────────────────┘
                       ▲
        scheduled routines wake on a timer and call the API:
        launchd plists (StartCalendarInterval)  ── or ──  hermes cron
                       │
            POST /api/summary/{daily,weekly,monthly} + POST /api/reconcile
```

One process. No workers, no Docker. The scheduling layer is *external* and pluggable
(see §6) — the server just exposes idempotent endpoints that any scheduler can hit.

---

## 2. Data model (SQLite, all additive over V3)

Markdown is truth; every table below is rebuildable by re-reading the `.md` files,
**except** the rows that record state markdown can't hold (calendar links, event
history, agent memory, the review queue).

| Table | Holds | Rebuildable from markdown? |
|---|---|---|
| `files` | one row per `.md` file (mtime, sha256, frontmatter) | yes |
| `todos` | one row per checkbox; **V4 cols**: `source_type`, `status`, `created_at`, `completed_at`, `estimated_minutes`, `calendar_event_id`, `confidence`, `source_quote` | yes |
| `notes_fts` | FTS5 index over headings + body | yes |
| `task_events` | audit trail: created / completed / rewritten / estimated / calendar_linked … | no — derived history |
| `calendar_links` | mirror of calendar events, with `todo_hash` linkage + active/completed/deleted lifecycle | no — external source |
| `memory` | persistent key/value facts for agents | no |
| `suggested_tasks` | the Review queue (suggested / maybe_done / duplicate) | no — pending decisions |
| `meta` | misc, incl. `last_summary_{period}` | no |

### Durability rule for task fields
Anything that should survive a full reindex lives **in the markdown line**, not just
in a DB column. The canonical inline format (built by `composeTodoText`, parsed back
by `parseFile`) is:

```
- [ ] !!! Write the spec #work #writing (est: 90m) (due: 2099-01-15)
        │   │             │              │           └ due date
        │   │             │              └ time estimate (V4.1)
        │   │             └ tags
        │   └ body
        └ priority (!!! / !! / !)
```

`(est: Nm)` is V4.1's addition — estimates used to live only in the DB and were wiped
on rescan; now they round-trip through markdown. `composeTodoText` ⇄ `parseFile` is
the contract that keeps create/edit stable.

---

## 3. The editor (V4.1)

`POST /api/todo` and `PATCH /api/todo` both compose the canonical line via
`composeTodoText`, so a todo created in the UI is byte-identical to one an agent adds.

- **Create** (`POST /api/todo`): `{ path, heading, text, due, tags[], priority, estimate_minutes }`
- **Edit** (`PATCH /api/todo`): `{ hash, …any subset }` — omitted fields keep their
  current value (read back from the indexed row). Returns the new content-hash plus
  `previous_hash`, since rewriting the text necessarily changes the ID.

UI: `TodoEditor.svelte` is a single modal used for both create and edit — textarea,
file + section selects (with heading autocomplete from the target file), native
`<input type="date">` + `<input type="time">` pickers, due-date presets, priority,
estimate, tags, and an optional "schedule a calendar block after saving" checkbox.
Opened by the floating **+** button, the `n` shortcut, or the **✎** on any todo.

---

## 4. Calendar bridge (V4)

`server/src/calendar.ts` is **provider-agnostic**. The server never imports a calendar
SDK directly; a `CalendarProvider` is injected by the runtime.

```ts
interface CalendarProvider {
  listEvents(startMs, endMs): Promise<CalendarEvent[]>
  createEvent({calendar_id, title, start_at, end_at}): Promise<CalendarEvent>
  deleteEvent(calendarId, eventId): Promise<void>
}
```

- **`ManualProvider`** (default): always available, zero deps — events created via the
  API/UI ("block this time"). Used in tests and when no Google adapter is wired.
- **Google adapter** (future): a thin wrapper over the Google Calendar MCP that
  implements the three methods. Drop-in — no server changes.

Bridge operations: `syncIncoming(weeks)` pulls events into `calendar_links` (soft-
deleting ones that vanished); `scheduleTask()` creates an event **and** stamps
`calendar_event_id` on the todo + logs a `calendar_linked` event; `findSlots()` does
busy-aware slot search within a workday window.

**Capacity** is computed from `calendar_links`: `dailyCapacity()` sums committed
minutes per day and joins task due-counts. `GET /api/lookahead?weeks=3` returns the
day-by-day view the Capacity tab renders as green/amber/red load bars.

Sync direction is deliberate: **calendar → DB is a read-only mirror; DB → calendar
happens only on an explicit `scheduleTask` call.** Nothing is auto-pushed.

---

## 5. LLM gateway + ingestion (V4)

`server/src/llm.ts` is a thin Ollama HTTP client; every call degrades gracefully if
Ollama is down. Two ingestion modes:

1. **Checkbox parse** (always, free): `- [ ]` / `- [x]` lines → todos.
2. **Prose extraction** (LLM, selective): `extract_from_source` / auto-extract on file
   change reads a document's full body and proposes `suggested_tasks`. These land in
   the **Review queue** as `status='suggested'` — *never auto-applied*.

`implied_done` detection: prose like "shipped the prototype yesterday" produces a
`maybe_done` suggestion against the matching open todo. The user taps to confirm.

**The no-auto-write rule holds everywhere:** triage, extraction, summaries, archive
proposals all return plans; only an explicit `accept_suggestion` / `apply_suggestion`
/ direct mutating call touches a file.

---

## 6. Scheduled routines (V4.1) — the agentic layer

The recurring "read everything, summarize, reconcile" loop is driven by an **external
scheduler** calling idempotent endpoints. Two drivers are supported; pick one.

### The endpoints (driver-independent)
| Endpoint | Effect |
|---|---|
| `POST /api/summary/daily` | Review of today: completed, overdue, next-7-days → `Summaries/Daily/YYYY-MM-DD.md` |
| `POST /api/summary/weekly` | ISO-week review → `Summaries/Weekly/YYYY-Www.md` |
| `POST /api/summary/monthly` | Calendar-month review → `Summaries/Monthly/YYYY-MM.md` |
| `POST /api/reconcile` | Close past `calendar_links` whose todo is done; report overdue count |

Each summary is **LLM-authored when Ollama is up, deterministic template otherwise** —
so a 9pm cron never fails because the model is busy. Output is a markdown file with
frontmatter (`period`, `key`, `range`, `model`), which the indexer then picks up so
summaries are themselves searchable todos-and-notes.

### Driver A — launchd (default: robust, templated/local)
Three plists using `StartCalendarInterval` run `ops/scripts/summary.sh <period>`,
which waits for `/api/health` then POSTs the summary + reconcile. This matches the
app's existing autocommit/server launchd pipeline; `install.sh` registers them.

```
daily   → 21:00 every day
weekly  → 19:00 Sundays
monthly → 08:00 on the 1st (anchored to the prior day, covering the month that ended)
```

### Driver B — hermes cron (LLM-authored, agentic)
`hermes` is already running as a persistent daemon on this machine and is an MCP
client. `ops/scripts/install-hermes-routines.sh` registers the companion MCP
(`http://127.0.0.1:3847/mcp`) with hermes and creates cron jobs whose prompts call
`generate_summary` + `reconcile_past` as a full agent turn, then deliver a short
narrative. Use this when you want the *agent* to write and react to the summary, not
just file it.

> Audit of schedulers on this machine (2026-05-29): **hermes** (LLM cron, daemon
> running), **openclaw** (LLM cron, gateway idle), **Claude `scheduled-tasks` MCP**
> (runs while the app is open), **launchd** (process scheduler, app pipeline exists),
> crontab (unused). Recommendation: launchd for robust templated runs; hermes when you
> want LLM-authored, agent-reactive summaries. Both hit the same endpoints.

---

## 7. Agent-attachability

Every human action is an agent action. The server speaks MCP three ways:

- **stdio** — `node server/dist/mcp-stdio.js`; the classic Claude Code attachment.
- **HTTP (Streamable)** — `POST /mcp` with stateful `mcp-session-id`; any agent on the
  tailnet attaches with `{ "url": "http://100.x.x.x:3847/mcp" }`, no SSH/stdio.
- **SSE** — `GET /api/events` for live file-change + `suggestionsUpdated` pushes.

A planning-aware agent's session opener:
```
lookahead(weeks=3)        → next 3 weeks: events, due tasks, over-capacity days
list_todos(due=today)     → today's work
capacity_report(range)    → am I over-committed?
schedule_task / find_slot → block time for priorities
generate_summary          → write a review;   reconcile_past → close stale blocks
memory_get / memory_set   → persistent context across sessions
```

~38 MCP tools total. Mutating tools return `{ ok, hash/sha256 }` so agents can verify
and chain.

---

## 8. Source tree (V4.1)

```
server/src/
  index.ts        entrypoint: Express + watcher + MCP-over-HTTP + auto-extract
  http.ts         all HTTP routes
  mcp.ts          MCP tool registrations (stdio + HTTP share this)
  mcp-stdio.ts    stdio entrypoint shim
  db.ts           schema + migrations + queries (todos, events, calendar, memory, suggestions)
  indexer.ts      chokidar → SQLite
  markdown.ts     parser + composeTodoText (the canonical-line contract)
  calendar.ts     CalendarBridge + provider interface  (V4)
  summary.ts      period summaries + reconcile          (V4.1)
  llm.ts          Ollama client + triage/extract/rollup/archive
  util.ts         path sandbox + atomic write
  types.ts        shared types
ui/src/
  views/          Today, Capacity, Review, Todos, Files, Search, Settings
  components/      TodoEditor (V4.1), TodoItem, Topbar, modals
  lib/store.svelte.js   runes store + API client
ops/
  launchd/        server, autocommit, summary.{daily,weekly,monthly} plists
  scripts/        install.sh, summary.sh, install-hermes-routines.sh, autocommit.sh
server/test/
  unit/           markdown, util
  integration/    http, indexer, v4-capacity, v4-calendar, v4-editor, v4-summary, v4-mcp-http
```

---

## 9. Security model (unchanged, made explicit)

- **Trust boundary = Tailscale.** Binds `0.0.0.0` for tailnet reach; no per-request auth.
- **Path sandbox.** Every read/write resolves through `isPathInRoots`; the summary file
  reader is sandboxed too.
- **Atomic, hash-guarded writes.** tmp+rename; `PUT` requires `expected_sha256`;
  content-hash todo IDs survive reflow.
- **LLM stays local.** Ollama on-device; no note content leaves the machine.
- **No LLM auto-writes.** Review queue + `apply_suggestion` are the only paths from
  model output to disk.
- **MCP-over-HTTP** is behind the same Tailscale boundary as everything else.

---

## 10. Testing

99 tests, all green: Vitest unit (`markdown`, `util`) + integration against a temp
markdown root with real SQLite (`http`, `indexer`, `v4-capacity`, `v4-calendar`,
`v4-editor`, `v4-summary`, `v4-mcp-http`), plus Playwright E2E. Ollama and Google
Calendar are stubbed in tests so CI needs neither. `npm test` runs unit+integration;
`npm run test:e2e` runs Playwright.

---

*V4.1 shipped 2026-05-29. Prior designs: see git tags `v3.0.0`, `v4.0.0`.*
