# owner-plan.md — Daily Google ingestion + todo triage

A plan to scrape and process Liam's Google accounts (email, calendar, files)
every day, turn them into actionable tasks in Companion Planning, and triage the
todo list automatically — without anything writing to disk unreviewed.

> Status: **design**. Updated 2026-05-29.
> Grounded in what's actually wired today (see §1) — not aspirational.

---

## 0. Goal

Each morning, an agent should:
1. Pull **new email, calendar events, and recently-changed files** from all of
   Liam's Google accounts.
2. Extract **action items** from them into the Companion **Review queue** (never
   auto-written to markdown).
3. **Triage** the existing todo list — flag stale/duplicate/done items.
4. **Sync calendar** so the Capacity view reflects real commitments.
5. Produce a **daily briefing**: what's due, what's overdue, what's new, what to
   focus on.

The output Liam sees: one Review queue to accept/dismiss, an up-to-date Capacity
view, and a 3-paragraph briefing. Target: < 2 minutes to process each morning.

---

## 1. Current state (what's actually wired, 2026-05-29)

| Source | MCP | Status | Accounts reachable |
|---|---|---|---|
| **Calendar** | Google Calendar MCP | ✅ **live** | `owner@example.com`, `REDACTED-DEV-EMAIL@example.invalid` |
| **Gmail** | Gmail MCP | ❌ `net::ERR_FAILED` — not connected/authed | none right now |
| **Drive** | Drive MCP | ❌ `net::ERR_FAILED` — not connected/authed | none right now |

Companion Planning side (done):
- `POST /api/calendar/events` ingests timed events → `calendar_links` → Capacity.
- A **Claude scheduled task** `companion-calendar-sync` runs daily 06:36 and does
  the calendar half already.
- `extract_from_source` / `POST /api/extract` turns prose → suggested tasks
  (Review queue). `triage_inbox`, `generate_summary`, `reconcile_past` exist.
- Two-tier LLM: `gemma4:e4b` (light) for extraction/triage, `nemotron3:33b`
  (heavy) for summaries.

**So the calendar leg is built; email + files + the extra accounts are the work.**

---

## 2. The five accounts

| # | Account | Likely role | Connect via |
|---|---|---|---|
| 1 | `REDACTED-DEV-EMAIL@example.invalid` | personal | Google MCP (calendar already authed) |
| 2 | `owner@example.com` | LifeScope / work | Google MCP (calendar already authed) |
| 3 | `alias1@example.com` | project / alias | needs Google MCP OAuth |
| 4 | `alias2@example.com` | project / alias | needs Google MCP OAuth |
| 5 | `owner@vendor.example` | BitScoop / work | needs Google MCP OAuth |

**Multi-account is the central challenge.** The connected Google MCP authenticates
**one Google identity at a time** (the calendar MCP currently sees accounts 1 & 2
because they're delegated/shared to the authed identity). Options, in order of
preference:

- **A. One MCP connection per account.** Register the Google MCP (Gmail+Calendar+
  Drive scopes) five times, once per account, as distinct named servers
  (`google-owner-personal`, `google-owner-work`, `google-alias1`, …). The daily
  agent iterates over whichever are connected. Cleanest isolation; explicit.
- **B. Account delegation.** If the accounts already share calendars/drives with
  one primary identity, a single connection can read across them (this is why
  calendar already sees 2). Works for read, but Gmail rarely delegates — email
  almost certainly needs per-account auth.
- **C. Per-account app passwords / IMAP** for mail only, if the MCP can't hold
  five Google OAuth grants. Heavier; last resort.

**Decision needed from Liam:** which accounts hold *actionable* mail/files vs.
which are just archives. Don't scrape five inboxes daily if only two matter.

---

## 3. What we pull from each source

### Calendar (per account)
- Next 3 weeks of **timed** events (skip all-day = deadlines/holidays).
- → `POST /api/calendar/events` with `calendar_id` namespaced per account
  (`owner@example.com`, `bill@…`) so `prune_missing` scopes correctly.
- Feeds Capacity + `find_slot` + reminders.

### Gmail (per account)
- Query: `is:unread -in:draft newer_than:1d` (plus `is:starred`/`is:important`
  for anything flagged). Pull thread snippets, not full bodies, first.
- For threads that look actionable (heuristics: addressed *to* Liam, contains a
  request/question/deadline), fetch the body and run `extract_from_source`-style
  extraction → **suggested tasks** with `source_quote` = the sentence + a
  `gmail:<threadId>` provenance link.
- **Implied-done detection**: "sent you the deck", "paid the invoice" → propose
  `maybe_done` against matching open todos.
- Never send, archive, or label without an explicit accept. Read-only by default.

### Drive (per account)
- `list_recent_files` (lastModified, last 1–2 days) + a standing query for
  planning-ish docs (`title contains 'plan' or 'roadmap' or 'todo' or 'notes'`).
- For changed docs: `read_file_content` → extract action items → Review queue
  with `drive:<fileId>` provenance.
- Skip large/binary/media; cap body at ~8 KB like the markdown extractor.

---

## 4. Daily pipeline (the scheduled agent)

Runs once each morning (≈06:30, before the workday). Self-contained prompt, like
the existing `companion-calendar-sync` task. Pseudocode:

```
0. GET /api/health — bail if the server is down.
1. CALENDAR  (all connected accounts)
     for acct in accounts:
       events = listEvents(acct, now, +21d, timed only)
       POST /api/calendar/events { events, prune_missing, window, calendar_id: acct }
2. EMAIL  (all connected accounts)
     for acct in accounts:
       threads = searchThreads(acct, "is:unread OR is:starred newer_than:1d")
       for actionable thread:
         body = getThread(thread)
         POST /api/extract { text: body, source: "gmail:<acct>:<threadId>" }
3. DRIVE  (all connected accounts)
     for acct in accounts:
       files = listRecentFiles(acct, lastModified, since=yesterday)
       for planning-ish file:
         POST /api/extract { text: readFileContent(file), source: "drive:<acct>:<fileId>" }
4. DEDUP
     POST /api/suggestions  → review the queue
     (merge near-duplicates across sources before they reach Liam — see §5)
5. TRIAGE
     POST /api/llm/triage { limit: 80 }   → stale/duplicate/rewrite suggestions
6. RECONCILE
     POST /api/reconcile   → close past calendar blocks whose task is done
7. BRIEFING
     POST /api/summary/daily   → narrative + counts, written to Summaries/Daily/
8. REPORT
     Deliver: "N new suggestions, M due today, K overdue, top 3 priorities."
     (local notification + the briefing file; optionally a Slack/email digest)
```

Everything in steps 2–3 lands as **`suggested`** in the Review queue. Liam opens
the app, taps Accept/Dismiss. Step 5's triage results are also suggestions.
**No file is modified without an explicit accept** (the standing rule).

---

## 5. Dedup & merge (so the queue isn't noise)

New items arrive from 5 accounts × 3 sources — high duplication ("AMD follow-up"
in mail *and* a calendar invite *and* an existing todo). Before surfacing:

1. **Exact hash** match against existing todos → skip.
2. **Fuzzy text** match (FTS/trigram) within a file/heading → flag duplicate.
3. **Cross-source semantic** match (optional, embeddings) → merge candidates with
   a single provenance list (`gmail:…`, `cal:…`, `drive:…`).

Implement as a `compare_and_merge` step (server-side, fast fuzzy first; LLM only
for the ambiguous middle). Goal: **one** Review item per real-world action, with
links to every place it showed up.

---

## 6. Companion API surface needed

Already exist: `/api/calendar/events`, `/api/extract`, `/api/suggestions`,
`/api/suggestion/:id/accept|dismiss`, `/api/llm/triage`, `/api/summary/:period`,
`/api/reconcile`, `/api/reminders`.

To add for this plan:
- **`POST /api/extract` → accept a `source` string** (provenance) and store it on
  the suggestion (today it stores `source_quote` but not an external link). Small.
- **`POST /api/ingest/batch`** — one call that takes `{ source, items[] }` of
  pre-extracted candidates (so the agent can extract with the LLM *or* push raw
  text). Optional; `/api/extract` per-item works to start.
- **`compare_and_merge`** MCP tool + route (dedup across the queue). New.
- **Per-account calendar namespacing** — already supported via `calendar_id`.
- **`account` field** on `suggested_tasks` so the UI can filter by source account.

---

## 7. Safety & privacy

- **Read-only by default.** No send/archive/label/delete on any account without an
  explicit, per-action accept. The agent's scheduled prompt forbids mutations.
- **No-auto-write rule holds.** Mail/Drive content → `suggested` only.
- **Local LLM for content.** Extraction runs on Ollama (on-device); email/file
  bodies don't leave the machine for the model step.
- **Account isolation.** Each source tagged with its origin account; Liam can
  dismiss a whole account's noise. Secrets/tokens never written to the repo.
- **Scope minimization.** Gmail read scope only; Drive `readonly`; Calendar
  read + the one event-create scope already used for `schedule_task`.
- **Volume caps.** `newer_than:1d`, recent-files-only, body truncation — so a
  daily run touches tens of items, not the whole archive. A separate one-time
  **backfill** can sweep history on demand, gated behind an explicit run.

---

## 8. Phased rollout

| Phase | Scope | Done when |
|---|---|---|
| **0 (done)** | Calendar sync, 2 accounts, daily scheduled task | Capacity reflects real events ✅ |
| **1** | Gmail for accounts 1–2: connect MCP, daily unread→Review | Morning queue shows real email tasks |
| **2** | Drive for accounts 1–2: recent planning docs → Review | Changed docs surface action items |
| **3** | `compare_and_merge` dedup + `account` tagging + provenance links | One queue item per real action, with source links |
| **4** | Add accounts 3–3 (owner, alias1, alias2) | All three accounts in the daily run |
| **5** | One-time historical backfill (opt-in) + Slack/email digest delivery | Past commitments captured; briefing delivered off-device |

Each phase is useful alone. Start with Gmail on the two already-authed accounts.

---

## 9. Scheduling

Reuse the proven pattern: a **Claude scheduled task** (like
`companion-calendar-sync`) whose self-contained prompt runs §4. One task, daily,
06:30. As accounts/sources are added, extend that prompt.

Alternative drivers if the Claude app isn't always open:
- **hermes cron** — if hermes holds the Google MCP grants, run §4 as a hermes job.
- **launchd + agent step** — a script that invokes an agent runtime headless.

The companion server itself stays credential-free; the *agent* is the bridge
(same architecture as calendar today).

---

## 10. Open questions for Liam

1. **Which accounts hold actionable mail/files?** (Don't scrape archives daily.)
2. **Connect all five Google identities to the MCP, or just the two work ones?**
3. **Delivery:** local notification only, or also a Slack/email morning digest?
4. **Backfill:** do a one-time historical sweep of mail/files, or only go forward?
5. **Auto-schedule:** should accepted tasks with estimates auto-get a calendar
   block via `schedule_task`, or stay manual?

---

*Next action: connect the Gmail MCP for `REDACTED-DEV-EMAIL@example.invalid` + `owner@example.com`
and extend the daily scheduled task with the email step (Phase 1).*
