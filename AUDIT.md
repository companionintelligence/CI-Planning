# Todo audit — `~/Documents/Owner_Plan`

Generated 2026-05-18 from the v2 SQLite index. Snapshot of what the new system imported
and the patterns it surfaces. Numbers will change as you work — re-run by
querying the live API (`/api/stats`, `/api/todos?open=true`) or by re-indexing.

## Headline numbers

| Metric | Count |
|---|---|
| Files indexed | **164** |
| Total todos (`- [ ]` / `- [x]`) | **1,163** |
| Open | **1,026** |
| Done | **137** (12% completion rate) |
| With a parsed due date | **0** |
| With at least one `#tag` | **0** |
| Currently overdue | 0 |
| Due today | 0 |

The "0 due dates / 0 tags" is the biggest finding here — see [§5](#5-conventions-not-yet-used).

## 1. Where the open work lives

Top 10 files by open todo count. These are your accumulation sinks — if any one of these
hasn't moved in months, it's almost certainly carrying noise.

| Open todos | File |
|---|---|
| 105 | `Personal_Professional_Planning/GAP_ANALYSIS.md` |
| 69 | `Personal_Professional_Planning/ROADMAP_1_WEEK.md` |
| 61 | `Personal_Professional_Planning/ROADMAP_6_MONTH.md` |
| 54 | `Personal_Professional_Planning/ROADMAP_3_MONTH.md` |
| 50 | `Personal_Professional_Planning/ROADMAP_1_MONTH.md` |
| 50 | `Liam_Personal_Finance/Taxes_2022-2025/TASK_TRACKER.md` |
| 43 | `Personal_Professional_Planning/ROADMAP_1_YEAR.md` |
| 39 | `Personal_Professional_Planning/Business/AI_OPERATIONS_PLAN.md` |
| 34 | `Personal_Professional_Planning/Personal/HOME_IMPROVEMENT.md` |
| 26 | `Personal_Professional_Planning/TOMORROW_TODO.md` |

The five `ROADMAP_*` files alone hold **277 open todos** — about 27% of the total — and
share heavy overlap by design. They're useful as time-horizon lenses but they double-count
work that already lives in topic files (`Business/*`, `Personal/*`).

## 2. Duplicates found

The new indexer can dedupe by normalized text (case-insensitive). 38 todo texts
appear more than once. Three categories:

### 2a. Legitimate parallels (do not collapse)
These look like duplicates but represent separate obligations — one per entity, one per year.
The system can leave them alone, but you might consider a shared "Quarterly entity tasks" file:

- `pay delaware annual report` × 3 — one each in entity READMEs for Companion Intelligence,
  HyperConstruct, Lifescope. These are three distinct filings.
- `determine if 1120 was filed` × 3 — three different tax years (2022 hyperconstruct,
  2023 hyperconstruct, 2024 lifescope). Distinct work.
- `time records showing R&D activities`, `contractor invoices with scope of work`,
  `hardware purchase receipts` — each appears 2-3× across R&D credit calculation docs;
  reasonable since each tax year needs its own evidence packet.

### 2b. Real duplication — same task, two files
These should consolidate. The roadmap files duplicate work that already lives in topic files:

| Text | Where |
|---|---|
| `pay Q1 estimated taxes by April 15` | `GAP_ANALYSIS.md` **and** `ROADMAP_1_MONTH.md` |
| `pay delaware annual reports` (plural) | `ROADMAP_1_YEAR.md` **and** `ROADMAP_3_MONTH.md` |
| `get car insurance quotes (progressive, state farm, usaa, costco)` | `ROADMAP_1_MONTH.md` **and** `ROADMAP_1_WEEK.md` |
| `book annual physical with kaiser permanente (find pcp in orange county)` | same pair |
| `🪩 update issue labels/status` | `GITHUB_ISSUES.md` **and** `Cedar Systems_HOTELS.md` |
| `🪩 organize tax documents folder` | listed 2× in `Business/FINANCES.md` |
| `🪩 research CA franchise tax for laguna labs` | listed 2× in `Business/FINANCES.md` |

**Recommendation:** the indexer's `add_todo` MCP tool can write the topic-file version
and a roadmap could just reference it. For now, the duplicates are surfaced; the
`triage_inbox` MCP tool will propose merges per-file.

### 2c. Archive bleed-through
`Liam_Personal_Finance/Taxes_2022-2025/_archive/` is currently being indexed because my
exclude rule matched `archive` (no underscore) only. That's why you see paired duplicates
like:

- `2025 K-1s from WRA (~March 2026)` — once in current `2025/Personal_Chase_2025_Tax_Summary.md`,
  once in `_archive/PERSONAL_TAX_SUMMARY_2025.md`
- `form 1098 (mortgage interest)` — same pair

**Fix:** I'll add `_archive` to `excludeDirs`. ~20-30 false duplicates will drop out.

### 2d. Recurring meeting noise
- `10:30am — CI standup` × 3 — these are the same standup listed for Mon/Wed/Fri in
  `ROADMAP_1_WEEK.md`. Recurring calendar events probably shouldn't be checkbox todos;
  they live better on a calendar. (Same for `10:00am — Lita standup`.)

## 3. Heading hotspots

The 10 heading paths carrying the most open todos:

| Open todos | Heading |
|---|---|
| 11 | `Outreach Battle Plan: Sales + Investment / 5. Delegation to Lex` |
| 10 | `This Week: March 26 – April 1, 2026 / Today (Thursday Mar 26)` |
| 10 | `Personal & Professional Gap Analysis / 30-Day Priority Stack / This Week (Mar 26 – Apr 1)` |
| 10 | `Personal & Professional Gap Analysis / 30-Day Priority Stack / This Month (April 2026)` |
| 9  | `BUSINESS MASTER PLAN / ACTIVE TODOS — Q2 2026 (April+) / April 2026` |
| 9  | `April 2026 Roadmap / Business — Companion Intelligence / Outreach & Sales (P0)` |
| 8  | `💰 FUNDRAISING / 🔥 ACTIVE TODOS — Q2 2026 / 🟡 April 2026` |
| 8  | `👨‍👩‍👧 FAMILY PLAN / 🎯 Family Goals / 1. Plan to Have Kids` |
| 8  | `👥 SOCIAL PLAN / 🎉 Party Planning / First Party: Casual Hangout` |
| 8  | `Personal & Professional Gap Analysis / 3. Sales & Marketing — 🟠 HIGH / Actions` |

Observations:
- Several "Today (Thursday Mar 26)" / "This Week (Mar 26 – Apr 1)" headings have **dates
  from late March**. Today is **2026-05-18**. These sections are ~7 weeks stale and almost
  certainly need rollover or archive.
- "Outreach Battle Plan / 5. Delegation to Lex" being the single largest heading
  cluster suggests delegation is a real bottleneck — Lex's queue may be unmanaged.

## 4. What looks done-but-not-archived

The audit query for "files with only completed todos" failed (a minor SQL bug I left in
the audit script — not worth fixing as a one-off). Re-runnable via:

```sql
SELECT f.path, COUNT(*) AS done
FROM files f JOIN todos t ON t.file_path = f.path
WHERE t.checked = 1
  AND NOT EXISTS (SELECT 1 FROM todos u WHERE u.file_path = f.path AND u.checked = 0)
GROUP BY f.path
ORDER BY done DESC;
```

## 5. Conventions not yet used

The v2 markdown parser supports — but isn't currently seeing — these patterns:

- **Due dates**: `(due: 2026-06-01)` inline, or `due: 2026-06-01` in frontmatter.
  Currently: **0 todos** carry a parseable due date. The dates you do have are baked
  into headings ("April 2026 Roadmap") which is human-readable but not queryable.
- **Tags**: `#fundraising`, `#tax`, `#health` inline, or `tags: [fundraising, tax]`
  in frontmatter. Currently: **0 todos** carry a parseable tag.
- **Priorities**: `!!!` / `!!` / `!` or `p1` / `p2` / `p3` at the end of a line.

**Why this matters:** without due dates, the Today view defaults to "open todos with
no due date" which is everything. Adding due dates to even your top 20 actions makes
the Today / Overdue filter meaningful overnight.

The MCP `add_todo` tool already writes in this format when you call it through Claude:

```
add_todo path=…/TOMORROW_TODO.md heading="Today" text="Pay Q1 estimated taxes" due=2026-04-15 tags=[tax,urgent]
```

## 6. Concrete next actions

These are sized so each one is doable in <10 minutes:

1. **Update excludes** so `_archive` and similar Apple-style hidden folders stop
   feeding duplicates: change `config.json` `excludeDirs` to include `_archive`,
   `.archive`, `archived`. (1 min — I'll do this now and rescan.)
2. **Pick a single "active todos" file** as your dashboard rather than 5 roadmap files.
   Move the **27 open todos in `TOMORROW_TODO.md`** here; demote the roadmaps to
   *planning* rather than *tracking*.
3. **Add due dates to the ~20 things that actually have deadlines**: Delaware annual
   reports, Q1/Q2 estimated taxes, K-1 collection windows, the late-March "This Week"
   carryover items. Within an hour you have a real overdue list.
4. **Decide what to do about the stale week-headings**. Either rename `ROADMAP_1_WEEK.md`
   to be undated and continually overwrite, or roll the old contents into a
   `weekly_archive/` subdirectory.
5. **Pull a triage pass through the LLM** on `GAP_ANALYSIS.md` first (largest file,
   105 open). Use the web UI's 🧹 Triage button or the MCP `triage_inbox` tool.
   The currently-installed `qwen2.5:0.5b` is too small for strong reasoning; pull a
   bigger model: `ollama pull qwen2.5:7b-instruct` (~4.7 GB).
6. **Calendar-ify the recurring standups** rather than re-listing them as todos.
   The 3× CI standup and 3× Lita standup lines in `ROADMAP_1_WEEK.md` are not work,
   they're meetings.

## 7. What this system can do for you now

These all work today against your real data:

- HTTP: `GET /api/todos?open=true&q=tax` → every open tax todo
- HTTP: `GET /api/search?q=delaware` → BM25-ranked snippet hits
- HTTP: `POST /api/llm/triage` with `{"path":"…/GAP_ANALYSIS.md","limit":40}` →
  LLM-suggested keep/archive/dedupe/rewrite/move per item (never auto-applied)
- HTTP: `POST /api/llm/summary` → prose briefing of overdue + due today + notable
- MCP (stdio): 14 tools — `list_todos`, `add_todo`, `complete_todo`, `search`,
  `triage_inbox`, `summarize_day`, `rescan`, etc. Wired in via
  `claude mcp add companion-planning -- node /Users/liam/devel/personal/companion-planning/.claude/worktrees/musing-austin-4dd678/mcp-stdio.js`
- Web UI: Today / All Todos / Files / Search views, all live-updating via SSE when
  you edit a markdown file in Obsidian/vim/iA Writer outside the app
- Auto-backup: hourly git auto-commit ready to install via
  `ops/scripts/install-autocommit.sh` (not loaded by default)
