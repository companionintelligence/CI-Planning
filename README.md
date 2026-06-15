# Companion Planning

A **private, local-first** personal todo and planning app. Tasks, time blocks,
tags, and an automation pipeline live in a single SQLite file on your machine; an
optional local LLM (Ollama) adds AI briefings, task extraction, grooming, and
auto-scheduling. No cloud, no account, no telemetry — everything runs on your
hardware and stays there.

Companion Planning is currently in **v0.2 active development**. The core app is
fully local and usable today; Google ingestion currently defaults to fixture data
unless explicitly switched to `GOOGLE_MODE=live` (the live-mode contract exists but
still falls back to fixtures until MCP wiring is finished).

- **Server** — Koa + TypeScript (`server/`), SQLite via better-sqlite3 + Drizzle, cron jobs via croner
- **Client** — SolidJS + Tailwind PWA (`client/`), built by Vite into `server/public/`
- **One process, one port** — the server serves both the API and the UI on **3848**

Full v0.2 design: [ARCHITECTURE.md](ARCHITECTURE.md)

## See it in action

From an empty day to a planned one: capture a task, pick a priority, and let the
planner place it on your calendar — no cloud round-trip, all on-device.

![Companion Planning — first-run walkthrough: create a task and auto-schedule it](docs/ftue.gif)

## Walkthrough video

> 📹 A full video walkthrough is coming soon.

<!--
  Video placeholder. To embed a walkthrough, drag an .mp4/.mov into a GitHub issue
  or release to get a hosted URL, then replace this block with the rendered link,
  e.g.:

  https://github.com/companionintelligence/Companion-Planning/assets/<id>/walkthrough.mp4
-->

## Screenshots

| Today | Calendar |
|---|---|
| [![Today view](docs/screenshots/today.png)](docs/screenshots/today.png) | [![Calendar view](docs/screenshots/calendar.png)](docs/screenshots/calendar.png) |
| AI briefing, next blocks, open tasks, and overdue count at a glance | Week strip over a time-blocked day — locked meetings and auto-placed task blocks |

| Inbox | Tasks |
|---|---|
| [![Inbox view](docs/screenshots/inbox.png)](docs/screenshots/inbox.png) | [![Tasks view](docs/screenshots/tasks.png)](docs/screenshots/tasks.png) |
| Review queue of AI-proposed tasks with source + confidence; promote or dismiss | The full backlog with priorities, tags, and notes — filter by status, tag, or text |

| Tags | Jobs |
|---|---|
| [![Tags view](docs/screenshots/tags.png)](docs/screenshots/tags.png) | [![Jobs view](docs/screenshots/jobs.png)](docs/screenshots/jobs.png) |
| Tag cloud sized by use, with a ranked usage breakdown | Background automations with their cron schedules — run any one on demand |

| Settings |
|---|
| [![Settings view](docs/screenshots/settings.png)](docs/screenshots/settings.png) |
| Planning mode, work hours, focus/break preferences, and live integration health |

## What you get

- **Seven views** — Today · Calendar · Inbox · Tasks · Tags · Jobs · Settings
- **Full task CRUD** — priorities P1–P5, due date + time, estimates, notes, tags, and subtasks
- **Deterministic auto-scheduler** — packs open tasks into time blocks around your work
  hours, locked meetings, and break preferences; reflows when you change the day
- **Inbox / review queue** — ingestion jobs propose "possible tasks" from email and
  calendar; each shows its source and a confidence score, and nothing becomes a real
  task until you promote it (one keystroke: `P` to add, `D` to dismiss)
- **Background jobs** — Gmail / Calendar ingest, possible-task promotion, nightly
  grooming (embedding-based dedupe), and auto-schedule; all visible and manually
  runnable from the Jobs view
- **AI day briefing** — Ollama-authored when available, deterministic template
  otherwise; the UI labels it honestly ("AI Briefing" vs. "Day Overview")
- **Live updates** — Server-Sent Events push task / block / job changes to every open
  client, so the UI stays in sync without polling
- **Installable PWA** — manifest + standalone display; usable from a phone over your tailnet

## How it works

Companion Planning is a small pipeline that turns raw inputs into a planned day,
with you in the loop at the one step that matters — what actually becomes a task.

1. **Ingest** — scheduled jobs read your sources (Gmail + Calendar; fixtures by
   default). Unstructured email/event text is mined by a local LLM for action items,
   with a deterministic fallback if Ollama is down. Calendar events are mirrored as
   locked meeting blocks.
2. **Review** — extracted items land in the **Inbox** as *possible tasks*, each
   tagged with its source and a confidence score. You promote the good ones and
   dismiss the noise. Nothing reaches your task list without your say-so.
3. **Plan** — the **auto-scheduler** packs open tasks into the open gaps of your
   workday, honoring work hours, locked meetings, focus-block limits, and minimum
   breaks. It's deterministic — same inputs, same plan — and re-runnable any time.
4. **Brief** — the **Today** view opens with an AI briefing that summarizes what's
   overdue, what's scheduled, and where to focus, generated on-device.
5. **Groom** — a nightly job dedupes near-identical tasks using text embeddings and
   tidies the backlog.

Every step runs locally. The single SQLite file is the whole system of record — copy
it to back up, delete it to start over.

## Project status (v0.2, 2026-06)

**Working today:**

- Koa + TypeScript backend serving both the API and the built client on port 3848
- SQLite schema for tasks, subtasks, time blocks, tags, possible tasks, scheduling
  preferences, and job runs
- All seven SolidJS views, with full task CRUD (tags, notes, priorities, due
  date/time, subtasks)
- Deterministic auto-scheduler (`/api/schedule/run`) honoring work hours, locked
  meetings, and break preferences
- Croner jobs: Gmail ingest, Calendar ingest, possible-task promotion, nightly
  grooming/dedupe, and auto-schedule
- Ollama-backed extraction/summarization with deterministic fallbacks
- SSE events for real-time UI updates across open clients

**Intentionally partial:**

- Google `live` mode is scaffolded but not yet connected to real MCP OAuth sessions
  (currently fixture-backed)
- No auth layer yet — the expected deployment model is a private network / Tailscale
- Some roadmap items in [PLANNING.md](PLANNING.md) and `liam-plan.md` remain design-phase

## Run with Docker (CI Hub)

The published image is public and multi-arch (amd64 + arm64):

```bash
docker run -d --name ci-planning \
  -p 3848:3848 \
  -v ci-planning-data:/data \
  ghcr.io/companionintelligence/ci-planning:latest
# open http://localhost:3848
```

On a CI Hub appliance, install **Companion Planning** from the marketplace — the Hub
mounts `${APP_DATA_DIR}/data` at `/data` and wires `OLLAMA_URL` automatically.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3848` | HTTP port (API + UI) |
| `DB_PATH` | `/data/companion.db` in the image; `~/Library/Application Support/CompanionPlanning/companion.db` in local dev | SQLite file. The containing directory is created automatically. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint. Unreachable ⇒ AI features degrade gracefully (template briefings, dedupe off). |
| `OLLAMA_SMALL` | `qwen2.5:0.5b` | Fast model for extraction/triage |
| `OLLAMA_MEDIUM` | `gemma4:e4b` | Better model for briefings |
| `OLLAMA_EMBED` | `nomic-embed-text` | Embedding model for dedupe |
| `TZ` | UTC | Container timezone — set it so "today" and cron schedules match your day |
| `GOOGLE_MODE` | `fixture` | `fixture` (committed sample data) or `live` (currently placeholder path; falls back to fixtures) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

**Persistence**: everything lives in the single SQLite file at `DB_PATH`. Mount a
volume at `/data` (as above) and your tasks survive container recreation.

## Local development

Runtime requirements:

- Node.js `>=26 <27`
- pnpm `>=11 <12`

```bash
corepack enable
pnpm install
pnpm dev          # server :3848 + Vite client :5173 (proxies /api)
```

Production-style run (build client into `server/public`, serve everything on 3848):

```bash
pnpm build && pnpm --filter server start
```

Want a populated app to explore? Seed ~100 tasks from the bundled fixtures:

```bash
pnpm seed         # uses Ollama extraction when available, deterministic otherwise
```

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks?status=&tag=&q=&priority=&due_before=&owner_id=` | List/filter tasks (with tags) |
| POST | `/api/tasks` | Create a task (`title` required) |
| PATCH | `/api/tasks/:id` | Update fields; `{"completed": true}` marks done |
| DELETE | `/api/tasks/:id` | Soft delete (status → `cancelled`) |
| GET | `/api/tasks/:id/subtasks` | List subtasks |
| GET/POST/PATCH/DELETE | `/api/blocks` | Time blocks for a date range |
| GET/POST | `/api/tags` | Tags with usage counts |
| GET | `/api/possible-tasks` | Review queue |
| POST | `/api/possible-tasks/:id/promote` \| `/dismiss` | Accept/reject a proposal |
| GET | `/api/summary?date=YYYY-MM-DD` | Day briefing (LLM or deterministic) |
| POST | `/api/schedule/run` | Run the auto-scheduler for a date |
| GET | `/api/jobs` · POST `/api/jobs/:id/run` | List / manually run background jobs |
| GET/PATCH | `/api/prefs` | Scheduling preferences |
| GET | `/api/llm/status` · `/api/integrations` | Ollama & integration health |
| GET | `/api/events` | SSE stream (task/block/job/possible events) |

## Tests

```bash
pnpm test                      # server vitest suite (Ollama-dependent tests degrade/skip)
cd tests/container && npm i && APP_URL=http://localhost:3848 npx playwright test   # container smoke
```

## License

MIT.

## Author

Liam Broza ([@mrhegemon](https://github.com/mrhegemon))
