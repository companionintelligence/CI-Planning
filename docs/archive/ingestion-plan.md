# Ingestion plan — daily Google → review queue

How Companion Planning turns Liam's Google accounts (mail, calendar, files) into
reviewable tasks each morning, without anything writing to the task list
unreviewed.

> Status: **design**, salvaged 2026-06-19 from the original owner's planning notes.
> Corrected to the **current job-based architecture** (the old draft assumed a
> push API — `/api/calendar/events`, `/api/extract`, `/api/suggestions` — that
> this codebase never shipped). This doc is the product framing for the
> back half of **Phase J** ([J-calendar-sync.md](J-calendar-sync.md)) plus the
> live-MCP wiring tracked in [ARCHITECTURE.md](../ARCHITECTURE.md) §12.

---

## 0. Goal

Each morning the system should, on its own schedule:

1. Pull **new email, calendar events, and recently-changed files** from Liam's
   Google accounts.
2. Extract **action items** into the **Review queue** (`possible_tasks`) — never
   auto-promoted to real tasks.
3. **Groom** the queue and backlog — flag stale / duplicate / likely-done items.
4. **Mirror calendar** events as locked meeting blocks so the scheduler plans
   around real commitments.
5. Produce a **daily briefing**: due, overdue, new, and where to focus.

What Liam sees: one Review queue to accept/dismiss, a calendar that reflects real
meetings, and a short briefing. Target: < 2 minutes each morning.

---

## 1. How ingestion actually works today

Ingestion is **server-side and pull-based**, not an external agent POSTing
candidates. The pipeline already exists; only the data *source* is stubbed.

| Piece | Where | State |
|---|---|---|
| Job runner (croner) | [jobs/index.ts](../server/src/jobs/index.ts) | ✅ real |
| `ingest_gmail` job | mail → `extractTasks` → `possible_tasks` | ✅ real (fixture source) |
| `ingest_gcal` job | events → locked meeting blocks + extraction | ✅ real (fixture source) |
| `promote_possibles` / `nightly_grooming` | confidence promote, dedupe, surface overdue | ✅ real |
| LLM extraction | [agents/extract.ts](../server/src/agents/extract.ts) via Ollama, deterministic fallback | ✅ real |
| Google client | [mcp/google.ts](../server/src/mcp/google.ts) | ⚠️ **fixture only** — `createLiveGoogleClient()` is a placeholder that falls back to `emails.json` / `calendar.json` |

**So the whole ingest→extract→review loop runs on fixture data today.** The work
is replacing the fixture client with a live, OAuth-backed Google MCP client and
making it multi-account — *not* building new ingestion plumbing.

### Real API surface (for reference)

The endpoints the UI and tests actually use — match these, don't invent new ones:

- Tasks: `GET/POST /api/tasks`, `POST /api/tasks/quick`, `PATCH/DELETE /api/tasks/:id`,
  `GET /api/tasks/:id/subtasks`, timer `POST /api/tasks/:id/timer/start|stop`, `GET /api/timer`
- Review queue: `GET /api/possible-tasks`, `POST /api/possible-tasks/:id/promote|dismiss`
- Calendar blocks: `GET/POST /api/blocks`, `PATCH/DELETE /api/blocks/:id`
- Planning: `POST /api/schedule/run`, `GET/PATCH /api/prefs`
- Jobs: `GET /api/jobs`, `POST /api/jobs/:id/run`
- Briefing / health: `GET /api/summary?date=`, `GET /api/llm/status`, `GET /api/integrations`
- Live updates: `GET /api/events` (SSE)

Ingestion runs **inside** the server as jobs; it does not call these routes.

---

## 2. The accounts

| # | Account | Role | Connect via |
|---|---|---|---|
| 1 | `owner@example.com` | personal | Google MCP (calendar already authed) |
| 2 | `owner@workdomain.example` | work | Google MCP (calendar already authed) |
| 3 | `alias1@example.com` | project / alias | needs Google MCP OAuth |
| 4 | `alias2@example.com` | project / alias | needs Google MCP OAuth |
| 5 | `owner@vendor.example` | vendor / work | needs Google MCP OAuth |

**Multi-account is the central challenge.** A single Google MCP connection
authenticates one identity at a time (calendar currently sees 1 & 2 via
delegation). Options, in order of preference:

- **A. One connection per account** — register the Google MCP (Gmail + Calendar +
  Drive scopes) once per account as distinct named clients; the live client layer
  iterates whichever are connected. Cleanest isolation.
- **B. Delegation** — works for read where calendars/drives are shared, but Gmail
  rarely delegates; mail almost certainly needs per-account auth.
- **C. App passwords / IMAP** for mail only, last resort.

**Decision needed:** which accounts hold *actionable* mail/files vs. archives.
Don't scrape five inboxes daily if only two matter.

---

## 3. What to pull from each source

### Calendar (per account)
- Next ~3 weeks of **timed** events (skip all-day = holidays/deadlines).
- → mirrored as locked `meeting` blocks (the `ingest_gcal` path), namespaced per
  account in `source_ref` so pruning scopes correctly.

### Gmail (per account)
- Query: `is:unread -in:draft newer_than:1d` (+ `is:starred`/`is:important`).
  Thread snippets first; fetch bodies only for actionable threads.
- Actionable → `extractTasks` → `possible_tasks` with `source_kind='gmail'` and a
  `source_ref` provenance link (`gmail:<acct>:<threadId>`).
- **Implied-done detection**: "sent the deck", "paid the invoice" → propose
  matching open tasks as likely-done during grooming.
- Read-only: never send/archive/label without an explicit accept.

### Drive (per account)
- `list_recent_files` (last 1–2 days) + a standing planning-doc query
  (`title contains 'plan'|'roadmap'|'todo'|'notes'`).
- Changed docs → extract action items → queue with `drive:<acct>:<fileId>`
  provenance. Skip binaries/media; cap body ~8 KB.

---

## 4. Daily pipeline

Runs once each morning (≈06:30). Implemented as **scheduled jobs** the server
already owns (extend `ingest_gmail` / `ingest_gcal` to loop accounts; add a
`ingest_drive` kind):

1. **Calendar** — for each connected account, mirror timed events → meeting blocks.
2. **Email** — for each account, unread/starred → extract → `possible_tasks`.
3. **Drive** — for each account, recent planning docs → extract → `possible_tasks`.
4. **Dedup / merge** — collapse near-duplicates across sources before they surface
   (see §5).
5. **Groom** — `nightly_grooming`: stale/duplicate/likely-done flags.
6. **Schedule** — `auto_schedule` re-plans the day around the new meeting blocks.
7. **Brief** — `GET /api/summary` narrative + counts.

Everything in 2–3 lands as **`pending`** in the queue. Nothing becomes a task
without an explicit promote. (The standing no-auto-write rule.)

---

## 5. Dedup & merge (so the queue isn't noise)

Items arrive from up to 5 accounts × 3 sources — heavy duplication. Before
surfacing:

1. **Exact match** on `(source_kind, source_ref)` → already deduped by the upsert's
   unique constraint.
2. **Fuzzy text** match within a window → flag duplicate.
3. **Cross-source semantic** match (embeddings, optional) → merge into one queue
   item carrying a provenance list (`gmail:…`, `gcal:…`, `drive:…`).

Lives in the grooming agent (fast fuzzy first; LLM only for the ambiguous middle).
Goal: **one** review item per real-world action, linking every place it appeared.

---

## 6. What needs building

- **Live Google MCP client** — replace `createLiveGoogleClient()`'s fixture
  fallback with real OAuth-backed Gmail + Calendar + Drive reads. *(The single
  biggest unlock; everything else already works on fixtures.)*
- **Multi-account loop** — iterate connected accounts inside the ingest jobs;
  namespace `source_ref` per account.
- **`account` provenance** on `possible_tasks` so the UI can filter/dismiss by
  source account.
- **`ingest_drive` job kind** — mirror the Gmail path for Drive docs.
- **`compare_and_merge`** grooming step — cross-source dedup (§5).

---

## 7. Safety & privacy

- **Read-only by default.** No send/archive/label/delete without an explicit,
  per-action accept.
- **No-auto-write rule holds.** Mail/Drive content → `pending` only.
- **Local LLM for content.** Extraction runs on Ollama on-device; bodies don't
  leave the host for the model step.
- **Account isolation.** Each item tagged with its origin account.
- **Scope minimization.** Gmail read scope; Drive `readonly`; Calendar read (+ the
  one event-write scope if/when two-way sync lands in Phase J).
- **Volume caps.** `newer_than:1d`, recent-files-only, body truncation. A separate
  opt-in **backfill** can sweep history on demand.

---

## 8. Phased rollout

| Phase | Scope | Done when |
|---|---|---|
| **0 (done)** | Fixture ingest loop: extract → review → groom → schedule | Queue fills from fixtures; tests green ✅ |
| **1** | Live Google MCP for accounts 1–2 (calendar + Gmail) | Morning queue shows real email/meeting items |
| **2** | Live Drive for accounts 1–2 (`ingest_drive`) | Changed docs surface action items |
| **3** | `compare_and_merge` dedup + `account` provenance | One queue item per real action, with source links |
| **4** | Accounts 3–5 | All five accounts in the daily run |
| **5** | Opt-in historical backfill + off-device digest delivery | Past commitments captured; briefing delivered |

Each phase is useful alone. Start with live Gmail on the two already-authed
accounts.

---

## 9. Open questions

1. Which accounts hold *actionable* mail/files vs. archives?
2. Connect all five Google identities, or just the two work ones?
3. Delivery: in-app/briefing only, or also a Slack/email morning digest?
4. Backfill: one-time historical sweep, or forward-only?
5. Auto-schedule: should accepted tasks with estimates auto-get a calendar block,
   or stay manual?

*Next action: wire `createLiveGoogleClient()` to a real Gmail + Calendar MCP for
`owner@example.com` + `owner@workdomain.example`, behind `GOOGLE_MODE=live` (Phase 1).*
