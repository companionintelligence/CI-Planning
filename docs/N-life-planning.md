# N — Life planning: goals/objectives, intentions, reflection & learning loops (implementation spec)

**Status:** Spec'd · not started · **Worktree head `0068`.** **Depends on / coordinates with:** the in-flight **Categories** work (`claude/category-ui-surfacing`, `0069_category_tags`, last commit 2026-06-26) which provides life-domains; and **Phase M** (shipped: `daily_plan`, `agents/loop.ts` runLoop, `authorPlanOrder`). Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), [M-ai-scheduler.md](M-ai-scheduler.md), and the deferred [G-rituals-reflection.md](archive/G-rituals-reflection.md).

> **Why this phase.** Today everything keys off work hours, focus blocks, deep work, and day themes — it plans a *workday*, not a *life*. A life planner needs the rest: a **goal → project → objective → task** hierarchy with rollups and long-horizon planning; lightweight **daily/weekly intentions**; and the **reflection + learning loop** (Sunsama's morning ritual + weekly review) that turns captured data into insight. This phase adds all of it in five independently-shippable slices.

> **📍 Noun-budget note (READ FIRST — 2026-06-26).** The committed [GLOSSARY.md](GLOSSARY.md) (this branch, `main`, and the feature branches) lists **8 in-use nouns** — Task · Time Block · Routine · Tag · Inbox · Flight-plan · Planner · Pattern-block. The header's *"7 in use, 1 reserved"* is **stale** against its own 8-row table: Pattern-block is in use, so there is **no free slot**. Per the project owner, the current canonical tree adds **Categories** and **Objectives** as nouns (the strict 8-cap relaxed). Two things this spec pins down:
> - **Categories** ships (today) as a **Tag sub-level** — `tags.kind='category'`, seeding base categories **`family` / `social` / `me`**, with `category_prefs.color_token` + `time_blocks.category_id`. Whether it's promoted to a *formal noun* is the owner's glossary call; **this spec binds life-domains to that Category axis regardless** of label.
> - **Objective** is a genuinely new **entity** (below). Updating [GLOSSARY.md](GLOSSARY.md) (Objective as a noun; declare the support tables non-noun) and [ROADMAP.md](ROADMAP.md) (the phase-map row) are **follow-ups owned by the project owner** — this spec does not edit the canon.
>
> The intention/reflection surfaces in N0/N3 add **zero new nouns** — they are *modes/flows over existing surfaces* + *support tables* (the same class as `daily_plan` / `reminders` / `audit_log`).

> **Migration numbering.** `0069` is taken by `0069_category_tags`. All migrations below are **provisional, numbered from the next free slot after Categories integrates (≥`0070`)**; renumber at integration time.

---

## The locked Objective model

One self-nesting **entity** — Goal / Project / Objective are *levels* of one noun (like `tasks.parent_id` subtasks and `time_blocks.parent_block_id` containers), **not** three nouns. Leaf work stays **Tasks**. *(As built: the leaf level is **height-based** and named `objective` — see the leveling note below; migration 0085 renamed the original `milestone` leaf → `objective`.)*

```
objectives (
  id, owner_id,
  parent_id,            -- self-nesting; cycle-rejected (reuse Phase-C dependency cycle check)
  level,                -- 'goal'|'project'|'objective' — DISPLAY ONLY, server-derived from HEIGHT
                        --   (leaf-with-tasks='objective', node-of-objectives='project', node-of-projects='goal');
                        --   stamped on the node + ancestors on every (re)parent. NOT accepted on POST/PATCH.
  source_task_id,       -- set when auto-created by task promotion (0086): owns idempotency + GC.
  horizon,              -- 'year'|'quarter'|'month'|'week'|'none' — planning ALTITUDE
  target_date,          -- optional, SOFT (never a hard due_at; never renders red/overdue)
  status,               -- 'active'|'paused'|'done'|'dropped'
  category_id,          -- FK → the Category axis (tags.kind='category'); the life-domain
  progress_cache,       -- 0..1 OR NULL  (NULL is load-bearing — see below)
  cadence,              -- 'weekly'|'biweekly'|'monthly'|'none' — drives the nominator
  last_advanced_at,
  priority, created_at, completed_at
)
objective_tasks (objective_id, task_id)   -- M:N; the rollup source. A task may serve >1 objective.
```

**Three orthogonal time concepts** (kept sharply distinct, mirroring `due_at` vs `scheduled_for` vs `defer_until`):
`horizon` = altitude · `target_date` = soft date · `cadence` = surfacing rhythm.

**Rollup (`progress_cache`):** estimate-weighted task completion (`Σ done.est / Σ all.est`, fall back to count when estimates absent); a parent = weighted average of children (directly-linked tasks act as pseudo-children); recompute = a **bounded upward walk** from the changed node to root (same shape as [review.ts](../server/src/engine/review.ts)) plus a nightly safety net.
**NULL ≠ 0:** no tasks and no children ⇒ `progress_cache = NULL` ("no plan yet / rotting"), distinct from `0` ("planned, nothing done"). The UI must render these differently — this is the rot signal the whole long-horizon view is built around.
**Next action** = the highest-priority incomplete linked **leaf task**; "no next action" is itself a rot signal.

---

## Slice map

| Slice | Name | Ships | Hard deps | New nouns |
|---|---|---|---|---|
| **N0** | Today + weekly goals | **first** (standalone) | — | 0 |
| **N1** | Objective hierarchy + `/objectives` view + horizon lens + cadence push | after N0 | Categories (for color), N0 (`reflections`) | Objective (entity) |
| **N2** | Life domains = Categories | **in flight** (`category-ui-surfacing`) | — | (Categories — owner's call) |
| **N3** | Reflection surfaces (morning ritual + weekly review) | after N0/N2 | N0 (`reflections`), Categories | 0 |
| **N4** | Learning loops (estimate calibration + ordering feedback) — revives G-INT | after N1/N3 | Phase M (exists) | 0 |

Recommended order: **N0 → N2 (already moving) → N1 → N3 → N4.**

---

## N0 — Today goal + weekly goals (the lightweight intention layer)

**Goal:** users set **one** today goal and **three** weekly goals (Sunsama's daily objective + weekly intention, distilled). One **Goals card** in the Today cockpit, one segmented control, two sections. Zero new nouns, zero new routes, zero crons. Ships entirely on its own.

**Placement:** a card in [Today.tsx](../client/src/views/Today.tsx), under Day Overview, before `<PlanInstruct/>`. **Not** a `/goals` route (a route reads as a noun; cockpit is where you plan the day). New component `client/src/components/DayGoals.tsx`.

**Layout:** segmented `[ Today | This week ]` (copy the App.tsx Suggest/Schedule pill), default `today`. Today = 1 slot; This week = **3 stable slots** (render all three; each empty slot is its own dashed `+ Add` affordance — *not* progressive disclosure, which is ambiguous when a middle slot is cleared). Inline edit (no modal): empty → dashed `+ Set today's goal` / `+ Add a weekly intention`; filled → body + category chip + complete/clear; Enter/Save upserts; empty-body save deletes. **Both delete paths (explicit clear and save-empty) route through the same undo toast** (`showToast`).

**Color = the Category axis (corrected).** Each goal optionally carries a **`category_id`** (the `tags.kind='category'` axis — family/social/me/…), and its color comes from `category_prefs.color_token`, reusing the Categories work shipped 2026-06-26. Per [color-styling-rules.md](color-styling-rules.md): the hue is a **3px left border + neutral chip only**; the Save CTA stays the mint `.btn-primary`; untagged ⇒ `var(--border)`. **Do not** use a generic free-text tag string for color (an earlier draft did — superseded by Categories).

**Data model — `reflections` support table** (created here, adopted by N3; pure composite key, **no `id` column** — matches the `daily_plan` precedent; an `id TEXT NOT NULL` with no default + composite PK would throw on insert):

```sql
CREATE TABLE IF NOT EXISTS reflections (
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- 'today_goal' | 'weekly_goal' (N3 adds 'morning'|'weekly')
  period_key  TEXT NOT NULL,                 -- 'YYYY-MM-DD' (day) | 'YYYY-Www' (ISO week)
  position    INTEGER NOT NULL DEFAULT 0,    -- today: 0 | weekly: 0..2
  body        TEXT NOT NULL DEFAULT '',
  category_id TEXT,                          -- nullable → category_prefs.color_token
  done_at     TEXT,                          -- optional complete toggle (see open item #2)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_id, kind, period_key, position)
);
CREATE INDEX IF NOT EXISTS ix_reflections_owner_kind_period ON reflections(owner_id, kind, period_key);
```

The composite PK makes a 2nd today / 4th weekly row structurally impossible; the route additionally validates `position` (`today`⇒0, `weekly`⇒0..2, else 422). Always **upsert by composite key**.

**Period + rollover:** `today_goal.period_key` = local `YYYY-MM-DD` (`selectedDay()`); `weekly_goal.period_key` = ISO-week `YYYY-Www` via a **new `isoWeekKey()`** in [dates.ts](../client/src/lib/dates.ts) + a server twin in [tz.ts](../server/src/lib/tz.ts) — Monday-start, true ISO-8601 week-*year* (Thursday rule), computed from local parts on the noon-UTC pivot the existing helpers use. **Rollover is key-only — no cron, no clear/carry job.** A new day/week returns no row ⇒ empty slots; prior rows persist untouched and *are* the snapshot the N3 weekly review reads. Carry-forward is opt-in only (an explicit button copying the prior key's bodies) — never automatic (keeps the feature wall-clock-stateless, immune to the time-bomb test trap).

**API** (`server/src/routes/reflections.ts`, register in `routes/index.ts`; copy the `plan.ts` idiom — `currentOwnerId()` on every query, `writeAudit()` on writes, `broadcast()` SSE):
```
GET    /api/reflections?period=YYYY-MM-DD   → { today: {body,category_id,done_at}|null, weekly: [{position,body,category_id,done_at}] }
PUT    /api/reflections/today               { period_key, body, category_id? }       upsert pos 0
PUT    /api/reflections/weekly/:position    { period_key, body, category_id? }       422 if pos∉{0,1,2}
POST   /api/reflections/:kind/:position/done{ period_key, done }
DELETE /api/reflections/:kind/:position?period_key=…
```
**The client always sends `period_key = selectedDay()`** on every write (don't rely on the server default) so editing while the cockpit is navigated to another day can't drift.

**Build order:** (1) `isoWeekKey()` + server twin + tests; (2) migration `≥0070_reflections` + `schema.ts` + `migrations/index.ts` + add `reflections` to the test `resetDb()` delete list + **regenerate `baseline.characterization` schema snapshot**; (3) `routes/reflections.ts`; (4) `api.reflections` namespace in [api.ts](../client/src/lib/api.ts); (5) `DayGoals.tsx` + insert into `Today.tsx`.

**Acceptance:** 1 today slot + ≤3 weekly slots on one shared card/toggle · inline create/edit/complete/clear, complete sets `done_at` (no delete), clear+save-empty both undoable · category goal shows `category_prefs.color_token` 3px left border + chip, untagged = `var(--border)`, Save is `.btn-primary` · day/week rollover empties slots, prior rows persist addressable, no cron · zero new nav entries/routes/nouns.
**Tests:** rollover at a tz/DST boundary under `TZ=UTC` with fixtures derived from helpers (guards the time-bomb trap) · `isoWeekKey` W53/year-boundary + Monday-start matches `weekDaysOf` · exactly-3 enforcement (PK + 422) · owner isolation · category-color application · `resetDb` includes `reflections`.

---

## N1 — Objective hierarchy, `/objectives` view, horizon lens, cadence push

**Goal:** the `objectives`/`objective_tasks` entity with rollups; a `/objectives` view (tree + long-horizon lens); and a weekly **cadence push** that surfaces each active objective's next action into the Flight-plan staging tray.

### Schema & the flight_plan source rework

Migration `≥007x`: `objectives` + `objective_tasks` (model above). **Plus a flight_plan source rework (real, net-new — not "reuse").** Today [flight_plan](../server/src/db/schema.ts) has PK `(owner_id, task_id)` + `source_pattern_id` + `INSERT OR IGNORE`, so a task appears at most once and nominating an already-staged task silently no-ops. Collapse `source_pattern_id`/(new)`source_objective_id` into a single **`(source_kind, source_ref)`** pair and switch the insert to **UPSERT** (`ON CONFLICT DO UPDATE`), so an objective nomination can claim/repoint an existing staged row deterministically.

### `/objectives` — tree default + swimlane-roadmap lens

One view of the Objective entity, a `[ Tree | Month | Quarter | Year ]` view-mode toggle (mirrors Calendar's day/week/month — **one surface, not new routes/nouns**; guard-test that no `/objectives/<period>` route exists). **Tree is the default** (the daily act is browse/manage/link/triage — a list job, and the natural mobile layout); the **roadmap is the lens** (spatial position is the only way to read behind/ahead, cross-domain balance, and rot at a glance).

**Tree** (clone the [AllTasks.tsx](../client/src/views/AllTasks.tsx) shell + [TaskCard.tsx](../client/src/components/TaskCard.tsx) depth recursion):

| Signal | Rendering | Rule |
|---|---|---|
| Progress | track + fill in **category color**, reads `progress_cache` | never recompute client-side |
| **NULL** | **dashed** track, no fill, italic "No plan yet", em-dash | `null` ≠ `0` (uses TaskCard's `—`-for-empty vocabulary) |
| 0% | solid empty track + "0%" | "planned, not started" |
| Rot | `(progress===null) OR (cadence≠none AND no next_action)` → amber dot + floats to top; "Rotting only" filter | the reason the lens exists |
| Level marker | `ShapeIcon` goal=circle / project=square / objective=diamond | derived from height (== stored `level`) |
| Behind/ahead | soft amber/green hint, **never red** | `target_date` is soft |

**Horizon lens = swimlane roadmap** (time on X, life-domain category on Y; bars positioned by soft `target_date`, filled by `progress_cache` in the category hue; permanent **Undated lane** — never silent-drop). Zoom = one spine, `Year → Quarter → Month → Week → the existing day Planner (/)`, driven by one `view` + one `anchor` signal. Granularity: Year→goals, Quarter→projects, Month→objectives, Week→next-action tasks. Reuses [dates.ts](../client/src/lib/dates.ts) date math (a new `lib/horizon.ts`); does **not** reuse CalendarGrid minute-geometry. *(Note: the Month zoom is the least valuable — real lives have few dated objectives per month; don't over-invest. Year is the headline.)*

**Editing & linking:** inline chips on the expanded row for link/unlink/re-parent (the [RoutinesPanel](../client/src/components/RoutinesPanel.tsx) idiom); a **dedicated lightweight `ObjectiveModal`** for create/edit — **not** a 5th `ElementWizard` kind (the wizard's doSave/seed/loadForEdit/ElementForm are deeply task/timeblock-shaped and share ~no fields with Objective). `target_date` edited via form only (it's soft — no pixel-drag in v1).

**Server-precomputed payload (kills the N+1):** `GET /objectives` returns, per objective, a **precomputed `next_action`** (id+title+status+scheduled day) and **`pace_expected`** + **`effective_target`** — all via a **`WITH RECURSIVE` CTE over the subtree** (`parent_id` is unbounded; a goal's next action / latest descendant date can live several levels down). Parent pace uses `effective_target = max(self.target_date, all descendant target_dates)` so a parent whose children legitimately land later isn't false-flagged "behind"; client shows "behind" only when `progress_cache + 0.1 < pace_expected`, never when progress is null (rot wins).

### Cadence push

New job `advance_objectives` (weekly, e.g. Mon 05:00; sibling to `review_day` in the [jobs](../server/src/jobs/index.ts) infra). For each active objective with a due cadence period (`last_advanced_at` older than the period), nominate its next-action task into the Flight-plan via the new `(source_kind='objective', source_ref=objective_id)` UPSERT. **Anti-thrash:** once per period (gate on `last_advanced_at`); skip if the next action is already staged / scheduled / in_progress / done; skip paused/done/dropped; **no next action ⇒ flag, don't nominate**. Bumping `last_advanced_at` means a removed task isn't re-added until next period (no nag loop).

**API:** `GET/POST/PATCH/DELETE /objectives`, `POST/DELETE /objectives/:id/tasks`, SSE `objective:created|updated|deleted`. All owner-scoped.

**Acceptance:** tree + roadmap render the signal table above (null ≠ 0 in both) · rollup is server-computed and estimate-weighted, null when empty · cycle-free parent_id · `next_action`/`effective_target`/`pace_expected` precomputed (no per-row fetch at Year zoom over ≥30 objectives) · cadence push is idempotent per period and respects every anti-thrash rule · no `/objectives/<period>` route; one nav entry (desktop `Nav.tsx` + mobile `BottomNav.tsx` overflow — separate files).
**Tests:** rollup correctness under partial estimates + mixed nesting · recursive CTE surfaces a grandchild's date/task · pace deadband + parent `effective_target` · `advance_objectives` re-run is a no-op (idempotency) · flight_plan UPSERT repoints an already-staged task instead of no-op'ing · owner isolation REST + SSE · mobile (no body horizontal scroll; roadmap collapses to a period-grouped vertical list — a real second render branch, budget it).

---

## N2 — Life domains = Categories (in flight)

**Already shipping** on `claude/category-ui-surfacing` (`0069_category_tags`): `tags.kind='category'`, base categories **family/social/me**, `tag_categories` (intention→category), `category_prefs` (per-owner color + default minutes), `category_direction_optouts`, `time_blocks.category_id` + `color_token`.

**N's job is to consume it, not rebuild it:** bind `objectives.category_id` and `reflections.category_id` to this axis; render category colors via `category_prefs.color_token` (N0/N1 above); add **time-by-category display rollups** to the N3 weekly review (read this single source of truth — do not recompute). **Budget *enforcement* (biasing the scheduler toward under-served domains) is deferred** — soft-constraint placement risks thrash; ship the read-only "you intended X, spent Y" display first.

---

## N3 — Reflection surfaces (morning ritual + weekly review)

The cockpit (Phase G) has landed, so the deferred reflection work ([G-rituals-reflection.md](archive/G-rituals-reflection.md)) is now in scope. Both are **flows/modes over existing surfaces + the `reflections` table** (0 nouns).

**R1 — Morning ritual (flow over the Planner cockpit).** The app already *generates* a warm briefing ([summarize.ts](../server/src/agents/summarize.ts) → `daily_summaries.prose`/`.focus`) and [Today.tsx](../client/src/views/Today.tsx) **discards it**, rendering only two stat counts. Surface `summary().prose` + `summary().focus[]`; add a deterministic **capacity bar** (`Σ estimated_minutes` of picked tasks vs workday minutes − fixed/locked blocks; amber ≥80%, red >100%) — a **net-new `workdayMinutes` helper** near [autoplan.ts](../server/src/engine/autoplan.ts):420 (it does not exist today; do not "reuse from plan.ts"). Guided Reflect→Pick→Estimate→Order→Commit; commit writes a `reflections(kind='morning')` row. Fully works with Ollama down (briefing has `fallbackProse`; capacity is arithmetic).

**R2 — Weekly review (mode over the Calendar week-view).** `GET /api/review/week` → new `services/weekly-review.ts` computes deterministic metrics, cached in a **`weekly_reviews`** table *parallel* to `daily_summaries` (do **not** add a `kind` column to `daily_summaries` — its PK is `(owner,date)`). `summarizeWeek` **mirrors** `summarizeDay` (extract the cache/`inputsHash`/`generate(tier:'medium')`/fallback shape — do not duplicate the generator); `fallbackWeekProse` when Ollama is down. Sections: objective progress (N1 rollup), time-by-category (N2 rollup), reflection journal (`reflections(kind='weekly')` — the persisted weekly goals from N0 *are* part of this). Needs `selectAudit(owner, from, to)` — [audit.ts](../server/src/lib/audit.ts) is INSERT-only; add a read path + `ix_audit_owner_at`.

> **Data correctness (verified):** `time_blocks.status` is **never set to `'completed'`** anywhere (only `overrun`/`missed`/`skipped`). Derive "done" from **`tasks.status='done'`/`completed_at`** joined via `daily_plan.block_id` — reading `time_blocks.status='completed'` would report ~0% for everyone. For timer-less users, impute `actual=estimated` for done tasks, flagged `imputed` — and **exclude imputed rows from N4 calibration**.

**Acceptance:** cockpit renders the previously-discarded prose/focus + capacity bar · weekly review caches on unchanged inputs, never 500s with Ollama down · planned-vs-done derived from task status (a done task with a default-`planned` block counts done) · no `/review` route.

---

## N4 — Learning loops (revives the deferred G-INT)

Phase M is **shipped**, so the substrate exists: `daily_plan`, `agents/loop.ts` (`runLoop`), and **`authorPlanOrder` already authors the LLM day order and is wired to production** (Fill/Place/reauthor; gated on `planning_mode='smart'`, default `'basic'`). So R4 is **not** "build an ordering author" — it's capture + a bounded prior.

**R3 — Estimate calibration (deterministic, suggest-only).** The Phase-D "≥5-sample calibration" is **vaporware** (`suggestEstimate` exists only in [D-time-tracking.md](D-time-tracking.md)). Add it: nightly `calibrate_estimates` job (after `review_day`) computes per-scope robust ratios — **median + MAD**, drop outliers outside `[median ± 3·MAD]`, cap `r∈[0.1,10]`, exclude imputed and interruption-corrupted tasks; three-tier confidence (`<5` silent→broader scope, `5–11` tentative, `≥12` confident); scope fallback `objective → primary category/tag → subtype → global`. `suggestEstimate(taskId)` returns a dismissible chip in the task editor; **accept = an explicit human write; the job never writes `tasks.estimated_minutes`** (test-enforced). 100% deterministic; the LLM may only phrase the chip (template fallback).

**R4 — Ordering/planning feedback (append-only, offline-first).**
- **Capture (ships first, valuable alone):** nightly `aggregate_plan_outcomes` stamps `daily_plan.outcome` (write-once) + appends one `audit_log` `plan_outcome` row (top-k hit rate, position↔completion correlation, overrun/skip/defer by source). Plus the **lossy-slip fix**: [review.ts](../server/src/engine/review.ts) hard-deletes the block on auto-defer (`:91`) — stamp `outcome='deferred'/'missed'` keyed by `(owner,date,task_id)` **before** the delete. The `source='llm'` vs `'deterministic'` A/B dashboard can populate wherever `planning_mode='smart'`.
- **Feedback (gated on the A/B showing real LLM lift):** feed a **bounded, weekly-frozen, summarized historical prior into `authorPlanOrder`'s `judge()` seam ONLY — never `check()`.** `check()` is the reproducible hard gate; making it history-dependent would make placement non-reproducible from visible inputs (violates the locked "same inputs → same plan"). `judge()` is the soft scorer, can't override `check()`, and never feeds placement deterministically; `baseline()` stays the permanent escape hatch, so a bad prior can never produce a worse-than-deterministic plan.

**Acceptance:** calibration is deterministic (byte-identical reruns on a pinned clock), never auto-writes estimates, falls to broader scope under sparse data · `aggregate_plan_outcomes` idempotent, `daily_plan.outcome` write-once, deferred tasks retain a planned-vs-done record · the ordering generator never receives history (generator≠evaluator, asserted on the LoopStage wiring); LLM-off ⇒ reproducible placement.

---

## Cross-cutting

- **Deterministic core, AI-assist on top.** Every AI touch (briefing, weekly narrative, calibration phrasing, judge prior) has a built deterministic fallback; placement/rollup/calibration math are deterministic. Matches [ROADMAP.md](ROADMAP.md) principles and the [feedback_ai_in_the_loop] discipline (generator≠evaluator, deterministic-gated rubric, bounded recursion, append-only `audit_log`, escape hatch).
- **Anti-nag.** Surfaces you open, not alerts that chase you. **Co-locate the heavy weekly moment:** pin the `advance_objectives` cadence day = the weekly-review day, and have the morning ritual present objective-nominated tasks as one grouped "this week's objectives" section. N-phase jobs create **zero** `reminders` rows (test).
- **Owner-scoped, forward-only, expand/contract migrations**, every new route + SSE event under the standard owner-isolation matrix.
- **Test-harness gotchas** ([reference_companion_test_gotchas]): shared sequential SQLite ⇒ add every new table to `resetDb()`; regenerate the `baseline.characterization` snapshot when adding a table; pin clock + `TZ=UTC` for any date-derived test; derive date fixtures from helpers, never hardcode.

## Follow-ups (not in this doc's commit)

- [ROADMAP.md](ROADMAP.md) phase-map row for **N**.
- [GLOSSARY.md](GLOSSARY.md) amendment — **Objective** as an entity noun; declare `reflections` / `weekly_reviews` / `estimate_calibration` / `daily_plan.outcome` as non-noun support state; resolve the Categories noun-vs-sub-level question and the stale "1 reserved" header. *(Owner's call.)*
- Standalone fix (independent of this phase): nothing sets `time_blocks.status='completed'` — worth a one-line write on the task-done route, or formalize that completion lives only on the Task.

## Open items for the owner

1. **Categories noun status** — formal top-level noun, or the `tags.kind='category'` sub-level the migration calls it? (Spec binds life-domains to the Category axis either way.)
2. **`reflections.done_at`** — keep the complete-toggle on today/weekly goals (additive beyond the literal "set goals" ask), or ship set/edit/clear only?
