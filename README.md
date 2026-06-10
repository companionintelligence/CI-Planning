# Companion Planning

A **private, local-first** personal todo and planning app. Tasks, time blocks,
tags, and an automation pipeline live in a single SQLite file on your machine;
an optional local LLM (Ollama) adds AI briefings, email/calendar triage, and
auto-scheduling. No cloud calls — your plans never leave your node.

- **Server**: Koa + TypeScript (`server/`), SQLite via better-sqlite3 + Drizzle, cron jobs via croner
- **Client**: SolidJS + Tailwind PWA (`client/`), built by Vite into `server/public/`
- **One process, one port**: the server serves both the API and the UI on **3848**

Full v0.2 design: [ARCHITECTURE.md](ARCHITECTURE.md)

## Screenshots

| Today | Settings |
|---|---|
| ![Today view](docs/screenshots/today.png) | ![Settings view](docs/screenshots/settings.png) |
| Day briefing, next blocks, open tasks | Planning mode, work hours, integration status |

## What you get

- **Seven views** — Today / Calendar / Inbox / Tasks / Tags / Jobs / Settings
- **Full task CRUD** — priorities P1–P5, due date + time, estimates, notes, tags, subtasks
- **Auto-scheduler** — packs open tasks into time blocks around your work hours and breaks
- **Inbox (review queue)** — ingestion jobs propose "possible tasks" from email/calendar
  fixtures; nothing becomes a task until you promote it
- **Background jobs** — gmail/gcal ingestion, possible-task promotion, nightly grooming
  (embedding-based dedupe), auto-schedule; all visible and manually runnable from the Jobs view
- **AI day briefing** — Ollama-authored when available, deterministic template otherwise;
  the UI labels it honestly ("AI Briefing" vs "Day Overview")
- **Live updates** — SSE pushes task/block/job events to every open client
- **Installable PWA** — manifest + standalone display, usable from a phone over your tailnet

## Run with Docker (CI Hub)

The published image is public and multi-arch (amd64 + arm64):

```bash
docker run -d --name ci-planning \
  -p 3848:3848 \
  -v ci-planning-data:/data \
  ghcr.io/companionintelligence/ci-planning:latest
# open http://localhost:3848
```

On a CI Hub appliance, install **Companion Planning** from the marketplace — the
Hub mounts `${APP_DATA_DIR}/data` at `/data` and wires `OLLAMA_URL` automatically.

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
| `GOOGLE_MODE` | `fixture` | `fixture` (committed sample data) or `live` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

**Persistence**: everything lives in the single SQLite file at `DB_PATH`. Mount a
volume at `/data` (as above) and your tasks survive container recreation.

## Local development

```bash
corepack enable
pnpm install
pnpm dev          # server :3848 + Vite client :5173 (proxies /api)
```

Production-style run (build client into `server/public`, serve everything on 3848):

```bash
pnpm build && pnpm --filter server start
```

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks?status=&tag=&q=&priority=&due_before=` | List/filter tasks (with tags) |
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
