# O — Gamified stars: the 5-star day (implementation spec)

**Status:** Spec'd · not started · **Migration head `0086`** (FU2 full-sync claims **`0087`**; Phase O migrations start at **`0088`**). **Depends on / builds on:** Phase N (`reflections`, `objectives`, `objective_tasks`, `daily_plan`), **PR #189 (merged)** — task lifecycle + strategic objectives (`open⇄scheduled` status derived from placement, Open/Scheduled/Routine grouping, `EightPointStar` objective deep-link, bottom-up leveling), the Categories axis (`tags.kind='category'`, `category_prefs.color_token`), and the nightly-job infra (`advance_objectives` 0082, `aggregate_plan_outcomes` 0083). Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), [N-life-planning.md](N-life-planning.md), [HANDOFF-objectives-followups.md](HANDOFF-objectives-followups.md).

> **⚠️ Reconciled against merged PR #189 (2026-07-01).** Three things changed under this plan and are corrected throughout:
> 1. **Migration head is `0086`, not `0084`.** `0085` (bottom-up levels + `milestone→objective` rename) and `0086` (`objectives.source_task_id`) are taken. **FU2 full objective-sync (owner-chosen option B) claims `0087`**, so Phase O now claims **`0088`/`0089`/`0090`**.
> 2. **Objective leveling is now height-from-bottom** (`levelFromHeight`: leaf `0`=**objective**, `1`=project, `2+`=goal). The old "goal→project→milestone" naming is dead — the **leaf is `objective`**. Task links attach only to **leaf** objectives; a *focus* link (below) may point at **any** node.
> 3. **A star already exists.** `client/src/components/EightPointStar.tsx` is the **objective deep-link** glyph on task cards (8-pointed, accent color). Phase O's day-score stars must stay visually distinct — see the star-disambiguation note below.

> **Why this phase.** Companion already *tracks* everything needed to know whether a day went well — the daily intention, habit instances, the frozen `daily_plan`, task completions, and (new here) a day note. What it lacks is a single, motivating readout that says *"today was a good day."* This phase adds one: a **five-star day score**, derived from signal that already exists, surfaced in the Today header and as a heatmap on the calendar. The goal is a gamified layer that rewards the work you were already doing — not a parallel to-do list.

> **Noun budget.** Zero new nouns. Stars are a **derived score** (a support table + a computed endpoint, same class as `daily_plan` / `plan_outcomes`). The day note is a new **kind** on the existing `reflections` support table, not a new entity.

> **Naming decision (owner-confirmed, 2026-07-01).** The Today intention card is **NOT** renamed to "Objectives" — that would collide with the long-term Objective hierarchy ([N1](N-life-planning.md)). It is renamed from "Goals" to **"FOCUS"**. ("FOCUS" is free because the standalone **Morning Briefing section is removed** — its content is *parked* in a **"Today's Brief"** pop-up opened from the FOCUS card; see O0/O3.) The card keeps a `Today | This week` **segmented toggle** that switches **only the focus shown** (today's one focus vs the three weekly goals). **Top tasks are not shown inline** — they live only in the Today's Brief pop-up, and **never include habits or routines**.

---

## The locked star model

Five independent stars per day. **Max = 5 = a perfect day.** All are *derived* — no star is a manual toggle you set directly; each reads existing completion signal, so the game rewards real work.

| # | Star | Earned when | Source (all exists after O0/O1) |
|---|------|-------------|-------------------------------|
| S1 | **Intention** | the "1 for today" intention is done | `reflections` (`today_goal`) `done_at IS NOT NULL` — auto-set when a *linked* task completes |
| S2 | **Habits** | **≥1** habit instance today **and all** are done | `tasks` where `subtype='habit'`, instance `occurrence_date = day`, `status='done'` |
| S3 | **Tasks** | **≥1** task planned today **and all** are done | `daily_plan(date)` ∩ `tasks.status='done'` |
| S4 | **Bonus** | ≥1 **unplanned** task completed today | a task with `completed_at` in the day whose id is **not** in `daily_plan(date)` |
| S5 | **Reflection** | ≥1 task done **and** a day note is saved | task completion + `reflections(kind='day_note', period_key=day)` non-empty |

**Habit/routine exclusion (consistent with O0 "top tasks"):** the **Tasks** (S3) and **Bonus** (S4) stars count **non-habit, non-routine Tasks only** — habits are already the **Habits** (S2) star, so they're never double-counted, and routine/pattern instances aren't "tasks." Same rule the Today's Brief top-tasks list uses.

**Empty-set rule (default; owner may flip):** S2 and S3 require **at least one** habit / planned task to exist. A day with no habits cannot earn the habits star; a day with no plan cannot earn the tasks star. This keeps "cleared all X" meaningful and makes a genuine 5-star day rare-but-real. (Alternative — vacuous-true on empty sets — is a one-line change in `engine/stars.ts` if the owner prefers it.)

**Permanence (owner-confirmed): freeze nightly.** Today's stars compute **live** (header updates as you check things off). At end of day a nightly job **snapshots** the five booleans into `day_stars`; a frozen day never recomputes, so editing a past task or note can't retroactively add or strip a star. `GET /api/stars` returns the frozen row when present, else computes live.

**Star disambiguation (vs PR #189's `EightPointStar`).** The app already has an **8-pointed, accent-colored** star on task cards ([EightPointStar.tsx](../client/src/components/EightPointStar.tsx)) meaning "this task belongs to an objective — click to deep-link." Phase O's day-score stars are a **different thing** and must read as such: **5-pointed, gold (`#f4d35e`)**, only ever appearing **clustered as the ⭐×5 day tally** (header day-type row) or as **calendar pips**. Rule: never use `EightPointStar` for the day score, and never put a gold 5-point star on a task card. Different shape + color + location = no user confusion.

---

## Slice map

| Slice | Name | Ships | Hard deps | Migrations |
|---|---|---|---|---|
| **O0** | FOCUS card: rename + `Today\|This week` toggle + linked typeaheads + "Today's Brief" pop-up | first | N0 (`reflections`), N1 (`objectives`) | `0088` |
| **O1** | Day note (one-per-day) + header/calendar affordance | after O0 | N0 (`reflections`) | — (kind only) |
| **O2** | Star engine: compute service + `day_stars` cache + nightly freeze + `GET /api/stars` | after O0/O1 | O0, O1, `daily_plan` | `0089`, `0090` |
| **O3** | Today-header rework (count **buttons**→task lists + capacity + small stars) · Brief relocated into FOCUS · calendar star heatmap · color polish | after O2 | O2 | — |

Recommended order: **O0 → O1 → O2 → O3.**

---

## Rollout — migration numbering & safe fan-out

This plan now runs alongside two merged-PR follow-ups from [HANDOFF-objectives-followups.md](HANDOFF-objectives-followups.md). Here's how to develop them concurrently without collisions.

**Migration ledger** (claim numbers up front — the #1 fan-out hazard is two branches both appending to [`db/migrations/index.ts`](../server/src/db/migrations/index.ts)):

**Owner decisions (2026-07-01):** FU2 = **option B (full objective sync)**; kick off **A + B + Phase O O0** now. This makes **B a migration-bearing lane**, so B and C must coordinate numbers.

| Number | Owner | Adds |
|---|---|---|
| `0087` | **FU2B** objective sync | `version`/`updated_at`/`field_ts` on `objectives` (+ `objective_tasks`), mirroring `0076_sync_versioning` |
| `0088` | Phase O · O0 | `reflections.(source_kind, source_ref)` |
| `0089` | Phase O · O2 | `day_stars` table |
| `0090` | Phase O · O2 | freeze-stars nightly job seed |
| — | FU1 parent-picker | none (payload flag is computed) |

**Three lanes, all branch from `origin/main`** (which has #188 + #189):

| Lane | Scope | Files | Mig | Risk |
|---|---|---|---|---|
| **A — Parent-picker** (FU1) | `has_tasks` on payload + client disables task-bearing parents + 422 message | `objectives.ts` (`buildTree`), `api.ts` (`Objective` type), `ObjectiveModal.tsx`, `objectives.test.ts` | none | low, isolated |
| **B — Full objective sync** (FU2B) | add `objective`+`objective_task` to `Op.entity`/allowlists/`stampRow`; version cols; emit ops from `ensureTaskPromoted`+objective routes; client op-log/IndexedDB entity; harden `scheduled` LWW | `sync/apply.ts`, `agents/sync.ts`, `objectives.ts`, `schema.ts`, `block-task-sync.ts`, client `lib/` op-log/outbox, `api.ts`, migration `0087` + sync tests | `0087` | **high** — the largest lane; touches sync internals + client persistence |
| **C — Phase O** | the 5-star day (O0→O3) | `DayGoals`/`Today`/`Calendar` + `reflections`/new `stars` routes + `engine/stars` + migs `0088–0090` | `0088–0090` | medium |

- **Shared-file hotspots to watch when the PRs land** (all trivial, different symbols, but sequence the merges to minimise rebasing): `objectives.ts` (A edits `buildTree`; B adds op-emission to the mutation routes) · `api.ts` (A adds a field to `Objective`; B adds a sync entity type; C adds `Reflection*` fields) · `db/migrations/index.ts` (B appends `0087`; C appends `0088–0090`).
- **Two migration lanes now** — pre-assigned above so there's no number reuse; the only real merge point is `index.ts` (append-only, mechanical). **Merge order recommendation:** A (no mig) → B (`0087`) → C (`0088+`), so C rebases last onto the final head.
- **Inside Lane C:** O0 (`0088`) and O1 (no mig) start together; O2 (`0089`/`0090`) depends on both; O3 depends on O2. O0's count buttons + Today's Brief reuse #189's shipped `status='scheduled'` + Open/Scheduled/Routine grouping + status-icon.

---

## O0 — FOCUS card (rename + scope toggle + top tasks + linked typeaheads + Brief)

**Goal:** the existing Goals card ([DayGoals.tsx](../client/src/components/DayGoals.tsx)) becomes the **FOCUS** card. It keeps the `Today | This week` segmented toggle (retained from the current DayGoals), which switches **only the focus shown** — today's one focus vs the three weekly goals. Both focus inputs gain a typeahead that can *link* to existing work — "1 for today" to a task, "3 for the week" to an objective — while still accepting **freeform** text that creates nothing. A **"Today's Brief"** button opens a **pop-up summary**.

**Rename + structure:**
- Header label at `DayGoals.tsx:111` `"Goals"` → `"FOCUS"`.
- **Top row:** the `FOCUS` label on the left; on the right, the **"Today's Brief"** button immediately to the **left of** the `[ Today | This week ]` toggle.
- **Today side:** the single today-focus input (typeahead) only.
- **This week side:** the three weekly-goal slots only.
- **No "top tasks" inline.** Top tasks appear **only inside the Today's Brief pop-up** (below).

**Today's Brief pop-up** (opened by the top-row button; a `.modal` per [index.css](../client/src/index.css)): the AI briefing prose + capacity line + a **Top tasks** list. **Top tasks exclude habits and routines** — a top task is a real, plannable Task (`subtype != 'habit'`, not a routine/pattern instance), ranked by the day's `daily_plan` / priority. Each item links to the task; a done-circle completes it via the existing PATCH. This is the only surface that shows top tasks.

**Weekly done-toggle:** each of the three weekly slots gets the same checkbox the today slot already has. The backend already supports it — `POST /api/reflections/weekly/:position/done` exists ([reflections.ts:138](../server/src/routes/reflections.ts)); only the UI toggle is missing.

**Linked typeaheads (the "select existing or type anything" behavior):**
- **1 for today** — the input offers matches from *today's scheduled tasks*. Client queries the existing tasks list filtered to the day (reuse `GET /api/tasks` with the day filter; add `?day=YYYY-MM-DD` convenience if not already supported). Selecting a task → link (`source_kind='task'`, `source_ref=task.id`) and copy its title into `body`. Typing free text and pressing Enter → `source_kind='manual'`, no task created.
- **3 for the week** — the input offers matches from the objective tree (`GET /api/objectives`, flattened). **Any node is linkable** (goal / project / leaf objective) — a *focus* link is not a *task* link, so the leaf-only containment rule does not apply here. Selecting → link (`source_kind='objective'`, `source_ref=objective.id`). Typing free text → `source_kind='manual'`, no objective created.
- A linked row shows a small chip (`ti-link` "scheduled task" / `ti-target` "objective"); a manual row shows none.

**Two-way completion (the payoff):**
- When a today-intention linked to a task is displayed and that task is `done`, the intention renders done. On the write side, completing the linked task **auto-stamps** `reflections.done_at` (so S1 lights up without a second click). Implement in the task-PATCH completion path ([tasks.ts](../server/src/routes/tasks.ts)): after marking a task done, if a `today_goal` reflection for the same owner+day has `source_kind='task'` and `source_ref=task.id`, stamp its `done_at`.
- Toggling the intention done by hand stays independent (does not complete the task).

**Data — migration `0088_reflections_source.ts`:**
```sql
ALTER TABLE reflections ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'; -- 'manual'|'task'|'objective'
ALTER TABLE reflections ADD COLUMN source_ref  TEXT;                            -- task.id | objectives.id | NULL
```
Mirrors the `flight_plan.(source_kind, source_ref)` pattern from [0081](../server/src/db/migrations/0081_objectives.ts). No FK (the ref is cross-table); a dangling ref just renders as plain text — the `body` is always the display source of truth.

**API:** extend the today/weekly upsert bodies (`PUT /api/reflections/today`, `/weekly/:position`) to accept optional `source_kind` + `source_ref`; default `'manual'`/`null`. `GET /api/reflections` returns them so the client can render the chip and resolve done-state.

**Tests:**
- Upsert a today intention with `source_kind='task'` + ref → `GET` returns them; empty-body save still deletes.
- Weekly done-toggle sets/clears `done_at` at each position 0–2; position 3 → 422 (unchanged).
- Completing a task that a today-intention links to auto-stamps the intention's `done_at`; completing an *unlinked* task does not.
- Freeform save (`source_kind='manual'`) creates no task and no objective row.

---

## O1 — Day note (one per day)

**Goal:** one free-text note per day, saved, never duplicated, linked from the Today header and every calendar date. Feeds S5 and (later) the [N3](N-life-planning.md) weekly-review prose.

**Storage — reuse `reflections`, new `kind='day_note'`.** No new table. The composite PK `(owner_id, kind, period_key, position)` makes "one note per day" **structurally impossible to violate**: `period_key = YYYY-MM-DD`, `position = 0`. Add `'day_note'` to the kind whitelist in [reflections.ts:9](../server/src/routes/reflections.ts). Empty-body save deletes (same rule as goals).

**API:** the existing reflections routes almost cover it. Add a `PUT /api/reflections/note` (period_key + body) or generalize the today-upsert to accept `kind`. `GET /api/reflections?period=` returns `note: {body, updated_at} | null` alongside `today`/`weekly`.

**Surfaces:**
- **Header:** a single `ti-note` affordance in the Day-Overview header (see [Today.tsx:84](../client/src/views/Today.tsx)). Outline when empty, accent-filled when a note exists; opens an inline editor (no modal — match the card's inline-edit idiom).
- **Calendar:** a small `ti-note` dot on any date that has a note ([CalendarGrid.tsx](../client/src/components/CalendarGrid.tsx)); click opens that day's note.

**Tests:**
- Two saves for the same day → one row (PK upsert), latest body wins.
- Empty-body save deletes the row.
- `GET` returns `note` for the day; distinct days are independent.

---

## O2 — Star engine (compute + freeze)

**Goal:** a single source of truth for the five stars per (owner, date): live for today, frozen for the past.

**Service — `server/src/engine/stars.ts`:** `computeStars(owner, date, { now? }): DayStars` returns `{ objective, habits, tasks, bonus, note, total }` (five booleans + count), reading `reflections`, `tasks`, `daily_plan` per the locked model. Pinned-clock `now` arg for testability (same pattern as `advanceObjectives`). Pure read; never writes.

**Cache — migration `0089_day_stars.ts`:**
```sql
CREATE TABLE IF NOT EXISTS day_stars (
  owner_id       TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,           -- local YYYY-MM-DD
  star_objective INTEGER NOT NULL DEFAULT 0,
  star_habits    INTEGER NOT NULL DEFAULT 0,
  star_tasks     INTEGER NOT NULL DEFAULT 0,
  star_bonus     INTEGER NOT NULL DEFAULT 0,
  star_note      INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  frozen_at      TEXT NOT NULL,
  PRIMARY KEY (owner_id, date)
);
```

**Freeze job — migration `0090_freeze_stars_job.ts`** seeds a nightly cron row (mirror the [0082](../server/src/db/migrations/0082_advance_objectives_job.ts) seed). Runs ~00:20 local per owner tz; for the day that just ended, `computeStars` → upsert `day_stars`. Idempotent (`ON CONFLICT DO UPDATE`); re-running is safe.

**API — `server/src/routes/stars.ts`:** `GET /api/stars?from=YYYY-MM-DD&to=YYYY-MM-DD` → `[{ date, objective, habits, tasks, bonus, note, total, frozen }]`. For each date in range: return the frozen `day_stars` row if present, else `computeStars` live (today and any not-yet-frozen day). One range query backs the whole calendar month.

**Tests:**
- Each star's boolean flips exactly on its condition; empty-set rule holds (no habits ⇒ S2 false; no plan ⇒ S3 false).
- Bonus star: completing a planned task does **not** earn it; completing a task absent from `daily_plan` does.
- Reflection star needs both a completed task and a note.
- Freeze job snapshots today's live value; a later edit to that (now-past) day leaves the frozen row unchanged; `GET` returns frozen over live.
- `total` equals the count of true flags.

---

## O3 — Surfaces (header rework + calendar heatmap + color)

**Goal:** show the score with maximum information and minimum chrome, and make objective/project/goal completion legible through color.

**Relocate the Morning Briefing (don't just delete it).** Remove the standalone `<MorningBriefing/>` section from [Today.tsx](../client/src/views/Today.tsx). Its **capacity bar** moves to the header (below). Its **AI prose + top-tasks list** move into the **Today's Brief pop-up** opened from the FOCUS card (O0) — same `GET /api/review` / briefing source, just parked. Nothing is lost; the vertical space is.

**Today header — reworked status rows** (Day-Overview card, `Today.tsx:84–136`):
- **Count buttons (not pills), single-select:** `overdue · due today · scheduled · open`. **Remove "blocked"; add "due today" and "scheduled."** No caret. **Only one may be selected at a time**; selecting it reveals a list of the actual tasks in that bucket below the button row (selecting another swaps; re-selecting closes). Every list item **links to the real task**. (`due today` = `due_at` on the day; `scheduled` = tasks/blocks placed today; `open` = backlog.) Overdue keeps its danger tone.
- **List paging (no long lists):** the list shows a small window (~3 rows) plus an overflow row `+N more` with an **up/down stepper** that advances the window **one item at a time** (up disabled at top, down disabled at end). Keeps the header compact regardless of bucket size.
- **Capacity bar, right of the buttons:** the relocated `scheduled_minutes / workday_minutes` bar (e.g. `690m / 540m`); tone green → amber (≥70%) → red (≥90%). Right-aligned, wraps under on narrow widths.
- **DAY TYPE row:** `DAY TYPE` select **and the "Edit windows" control sit together on the left** (Edit windows immediately right of the select). **Small day-stars** (~14px, gold `#f4d35e` earned / `#3a5560` unearned) + `n/5` sit on the **right** of the same row. Tap a star → what's-needed hint. Deliberately understated — the *calendar* is where stars are celebrated; the header is just today's live tally.

**Calendar heatmap.** Each date cell ([CalendarGrid.tsx](../client/src/components/CalendarGrid.tsx)) shows up to five tiny amber pips (one per earned star); a **perfect day (5/5)** collapses to a single glowing `ti-star` + tinted cell (`--bg-warning` + `--border-warning`). The month grid becomes an at-a-glance achievement heatmap — high information, one element per day. Backed by the single `GET /api/stars` range call.

**Color = the Category/domain axis (completion legibility).** Reuse `category_prefs.color_token` (already on `reflections` and `objectives`):
- Intentions and weekly slots: 3px left-border in the domain color (already the reflections idiom); on done, the row shows a filled check in that color + strikethrough.
- Objectives view: render `progress_cache` as a domain-colored ring; a completed objective (`status='done'`) fills the ring and shows a star. NULL progress stays the existing rot signal (distinct from 0).
- Consistency rule: **completion reads as color filling in** — everywhere (intention check, objective ring, calendar pip), not a separate widget per surface.

**Tests (client / light):**
- Header count buttons render `overdue / due today / scheduled / open` (no "blocked"); **single-select** (opening one closes the others); each list item links to the task.
- Paging stepper advances one item at a time; up disabled at offset 0, down disabled at end; `+N more` count updates.
- `Edit windows` renders next to the DAY TYPE select; day-stars render n gold + (5−n) muted on the right of that row.
- Capacity bar renders at the right tone threshold; standalone Morning Briefing no longer mounts; "Today's Brief" opens a pop-up containing the summary + top tasks; **the top-tasks list contains no habit/routine rows**.
- FOCUS `Today | This week` toggle swaps only the focus shown (no inline top-tasks list on either side).
- Calendar cell renders correct pip count; perfect day uses the single-star treatment.
- Focus (today) and weekly done state drive the filled-color + strikethrough.

---

## Open items (non-blocking, owner's call later)

- **Empty-set rule** for S2/S3 (require ≥1 vs vacuous-true) — defaulted to require-≥1 above; one line to flip.
- **Morning Briefing relocation** — O3 removes the standalone section; capacity → header, prose + focus list → the "Today's Brief" button in FOCUS. The `MorningBriefing.tsx` component is repurposed as the Brief panel's body (or a slimmer `TodaysBrief.tsx` wraps the same endpoint); the `GET /api/review` briefing source is unchanged.
- **Streaks / weekly totals** — a natural O4 (sum of `day_stars.total` per week, streak of ≥3-star days) once O2 lands. Not specced here.
- **GLOSSARY / ROADMAP** — add the "Intentions" rename note and a phase-map row; owner-owned canon edits (this spec does not touch canon), per the [N-life-planning.md](N-life-planning.md) precedent.
