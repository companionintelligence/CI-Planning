# Phase AA — Memory-Aware Agentic Layer (CI-Server companion-memory, pull-first)

Status: IN BUILD (go-live target: 2026-07-06)
Owner decisions (2026-07-06): pull-only is the go-live bar; dual auth (API key + SSO bearer,
CI-Import-Tools pattern); suggestions surface in the Inbox and become agentically scheduled
tasks on accept (with reflow); appliance-ready multi-tenant.

## Goal

Make the planner memory-aware: pull the owner's knowledge graph from the CI-Server
`companion-memory` appliance and feed it into the existing agentic surfaces (inbox
suggestions, daily brief, autoplan). Push (the old Phase I/J stub in `services/memory.ts`)
becomes AA4 — not today's gate.

## Context (verified 2026-07-06)

- CP already has the seam: `services/memory.ts` + `routes/memory.ts` + Settings UI + prefs
  columns (mig 0012). `memoryConnectorAvailable()` hard-returns false — that is the stub.
- CI-Server memory API (NestJS, `backend/apps/api/src/domains/memory/`):
  - `GET /graph/context` — LLM context snapshot of the owner's entity universe
  - `GET /graph/search?query=…` — semantic + structured search
  - `GET /graph/data?from=&to=&includeTypes=…` — nodes + relationships, date-filterable
  - `POST /v1/events` — idempotent capture ingest on `(user_id, source_system, source_id)` (AA4)
  - Auth: `JwtOrApiKeyAuthGuard` — `x-api-key` and/or `Authorization: Bearer <OIDC id_token>`;
    both headers may coexist. `user_id` is extracted server-side from the credential — CP stays
    stateless about CI-Server user mapping.
- CI-Import-Tools is the reference client (`backend/src/ci-server/http.ts`,
  `backend/src/server.ts:223 resolveCiServerCreds`): creds chain request → settings → env →
  OIDC session bearer; typed `HttpStatusError`; keep-alive fetch wrapper.
- CP inbox pipeline is source-extensible with zero schema change: `possible_tasks.source_kind`
  is open text; `upsertPossible()` (agents/ingest.ts:58) is idempotent on
  `(source_kind, source_ref)`; promote (routes/possibles.ts:45) carries source to the task and
  calls `autoScheduleOnIngest()` (trust-dial gated, TM-5) → `placeFlightPlan()` → B2 reflow.

## Slices

### AA0 — Memory connector (go-live gate)

`server/src/connectors/memory.ts`:

- `memoryCreds(owner)` per-owner resolution: `connection_tokens` row
  (`provider='ci_memory'`, KEK-encrypted JSON `{ url, apiKey?, bearer? }`) → env defaults
  `CI_SERVER_URL` / `CI_SERVER_API_KEY` (dev/single-tenant convenience only).
- `graphContext(owner)`, `graphSearch(owner, query, opts)`, `graphData(owner, filters)`.
- Headers built CI-Import-Tools style: `x-api-key` and `Authorization: Bearer` coexist.
- Throws `MemoryUnavailable` on transport/4xx-5xx; every caller degrades deterministically
  (same contract as `McpUnavailable` / `OllamaUnavailable`).
- `memoryConnectorAvailable(owner)` in `services/memory.ts` becomes real: true iff creds resolve.
- Fixture mode: `MEMORY_MODE=fixture` (default in dev/test) reads
  `fixtures/memory/graph.json` — same pattern as the Google fixture connector. Tests never
  hit the network.
- Settings (client): existing memory card gains Connect = CI-Server URL + API key
  (stored per-owner, KEK-encrypted → multi-tenant by construction). Status shows
  connected/available for real.

AA0b (fast-follow, not today): "Use CI-Portal sign-in" — requires `offline_access` refresh
tokens persisted at OIDC login (CP sessions are stateless cookies; id_tokens expire ~1h).
The connector already accepts `bearer`, so this lands without touching callers.

### AA1 — Memory suggestion agent → inbox → auto-scheduled tasks

`server/src/agents/memory-suggest.ts`:

- Scheduled job (W12 `scheduled_jobs` infra) per owner with memory pull enabled.
- Pull `graphData` for the next 48h (events, participants) + recent high-signal nodes.
- Draft candidate tasks: deterministic templates (e.g. event → "Prep for <title>") with
  optional Ollama `generateJson` polish; Ollama down ⇒ templates only (never blocks).
  Templates carry a default 30m prep estimate, persisted as
  `possible_tasks.proposed_estimated_minutes` (mig 0114) and copied to
  `tasks.estimated_minutes` on promote — without it the hands-off auto-schedule
  (`requireEstimate`) could never place an accepted suggestion.
- Stage via existing `upsertPossible()` with `source_kind='memory'`,
  `source_ref='ci:<node-id>'`, `source_payload={...node}`, confidence from the drafter.
  Dedup key is owner-scoped (mig 0114 rebuilt possible_tasks:
  `UNIQUE(proposed_owner_id, source_kind, source_ref)`, was global since 0001) — in
  fixture mode all owners read the same graph.json, so refs collide across owners.
- Guards: skip possibles previously dismissed (status='dismissed' is terminal for a
  source_ref, per owner); cap pending memory possibles per owner (default 5);
  idempotent re-runs; event nodes with a blank/missing id are skipped (logged) —
  they'd all collapse onto source_ref 'ci:'.
- Inbox renders the `memory` source badge automatically (PossibleCard shows source_kind).
- Accept = existing promote route: task created with source + estimate carried →
  `autoScheduleOnIngest` (trust dial) → placement → B2 reflow. Zero new scheduling code.
  Hands-off ⇒ accept auto-schedules a block; balanced/cautious ⇒ accept creates the
  task and placement waits for the user's next Auto run (intended — suggest-only).

### AA2 — Memory-informed Daily Brief

- Morning brief + EOD alignment fold in a `graphContext` excerpt ("today you have X with Y").
- Rendered through the Z-phase voice loop (`renderCopy`); `MemoryUnavailable` ⇒ brief is
  byte-identical to today.

### AA3 — Smarter autoplan/estimates (v-next)

- `graphSearch` hints into `plan.ts` placement scoring; memory actuals into Z0 estimate
  calibration pins.

### AA4 — Background push sync (v-next)

- Fills the original stub: scheduled job pushes completed/habits/reflections (existing scope
  checkboxes) as `POST /v1/events` envelopes, `source_system='companion-planning'`,
  `source_id=<entity-id>`; sets `memory_last_synced_at`. Connector method exists from AA0.

## Flags & safety

- Master flag `memory_pull_enabled` (scheduling_prefs, default 0; migration next free head —
  0113 provisional, renumber at merge if W-close #286's 0112 shifts). Mig 0114 rebuilds
  possible_tasks (owner-scoped uniqueness + `proposed_estimated_minutes`).
- Flag off ⇒ byte-identical behavior (Z-phase discipline). One deliberate exception: the
  `memory_suggest` cron still runs its job-runner bookkeeping (a job_runs row logging the
  no-op) with the flag off — same as the ingest_gmail precedent; accepted in review.
- All creds owner-scoped in `connection_tokens`; no global credential in the prod path.
- Suggestion volume is suggest-only by default; hands-off auto-promotion inherits the
  existing trust dial — no new autonomy surface.

## Tests (TDD per slice, repo convention)

- AA0: creds resolution chain; header coexistence; MemoryUnavailable degradation; fixture
  graph round-trip; status endpoint reflects real availability; flag round-trip via
  PATCH /api/prefs (Z-phase lesson: don't test flags with raw SQL only).
- AA1: idempotent staging; dismissed-is-terminal; cap; promote→auto-schedule integration
  (fixture graph → possible → promote → block placed).
- AA2: brief with/without memory identical-when-unavailable.

## Go-live checklist

- [ ] migrations head bumped, `.env.example` documents CI_SERVER_URL/CI_SERVER_API_KEY/MEMORY_MODE (Y-phase invariant)
- [ ] server suite + client suite + tsc green
- [ ] fixture-mode e2e: memory chip in Inbox → accept → block on calendar (hands-off trust
      mode; chips carry the default 30m estimate. Balanced/cautious: accept creates the
      task, placement happens on the user's next Auto run — intended)
- [ ] live smoke vs local CI-Server (`make dev`, port 3000) with API key
- [ ] PR off this worktree branch; flag-off byte-identical diff review
