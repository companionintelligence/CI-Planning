# Z — Focus Ritual & the Calibration Loop (implementation spec)

**Status:** In progress — **PR 1 built** (Time-Sense master flag `0105` + Z0 scoped calibration `0106` + Z1 EOD Alignment), everything dark behind the per-owner **`time_sense_enabled`** flag ("Time-Sense", Settings → Preferences). **Migration head was `0104`** at branch time; **Z claims `0105+`** ⚠️ the Z-naming-consolidation plan had provisionally claimed `0105–0107` — first-to-main wins (owner decision 2026-07-03); the later phase renumbers at merge. **Depends on / builds on:** Phase **D** (`time_entries`, `tasks.actual_minutes`), Phase **H** (service worker, Web Push/VAPID, `reminders`, `fire_reminders` cron), Phase **M** (`daily_plan`, `daily_plan.outcome`, `agents/summarize.ts`, `agents/plan.ts`), Phase **N** (`reflections`, `estimate_calibration`, `suggestEstimate`, morning ritual), the **Categories** axis (`tags.kind='category'`, `tag_prefs.color_token` — `category_prefs` merged into `tag_prefs` in S2/0097, `time_blocks.category_id`/`color_token`), and Phase **O** (Today's Brief pop-up, five-star day — lives in `client/src/components/DayGoals.tsx`). ⚠️ **Post-S reality check (2026-07-03):** `daily_summaries`+`day_stars` are now **`daily_recap`** (0096); **`plan_outcomes` and its `aggregate_plan_outcomes` job were dropped** (0095, write-only rollup) — planned-vs-done derives on demand; Phase N shipped `estimate_calibration` as plain per-owner percentiles (**no MAD/outlier handling — Z0 adds it**) and **never shipped `suggestEstimate`** (Z6 builds it new on Z0's `resolveCalibration`). Sections below are updated where this changes the build. Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), [N-life-planning.md](N-life-planning.md), [O-gamified-stars.md](O-gamified-stars.md), [H-notifications-webpush.md](H-notifications-webpush.md), [M-ai-scheduler.md](M-ai-scheduler.md), [D-time-tracking.md](D-time-tracking.md).

> **Why this phase.** The planner already *captures* estimates, actuals, the frozen day order, and completion signal — but it never closes the loop back to the human in a way that **sharpens their sense of time** or **triggers focus**. This phase adds two coupled mechanisms: (1) a **Focus Ritual** — a consistent multi-sensory block-timer that conditions a focus on-switch and renders time as ambient color rather than an anxious countdown; and (2) a **Calibration Loop** — a pre-block estimate prompt and a post-day *EOD Alignment* that turn the app's own actuals into better default durations, keyed on tags. The design deliberately gives **no points and no star** for prediction accuracy — the reward is the visible improvement of the user's own judgment (see *Evidence* → intrinsic motivation).
>
> **Noun budget: zero new nouns.** *EOD Alignment* and *Daily Brief* are **flows/modes over existing surfaces**; their persistence is a new `kind` on the `reflections` support table plus columns on existing tables — the same class as `daily_plan` / `plan_outcomes` / `day_stars`. The Focus Ritual is a client-side render layer over an existing Time Block plus `reminders` rows. Nothing here earns a row in the noun table.

---

## Map — UI beats ↔ mechanics

The two note-streams behind this spec: what the user *sees/does* (interaction) and what runs *underneath* (feature mechanics). Every beat links to its section so they stay coherent as the doc grows.

| UI beat (what the user sees/does) | Mechanics (what runs underneath) | § |
|---|---|---|
| Focus screen: task **name** + description/subtasks/tags behind icon toggles | Layout/disclosure over `tasks.title`·`description`, child `tasks.parent_id`, `entity_tags` — no schema | §1.0 |
| Four timers: start · mid · 3-min · end (haptic/sound) | `reminders` rows + in-tab scheduler; Vibration API foreground, Web Push (Phase H) backgrounded | §1.1 |
| Ambient **gradient sweep** that falls, then rises to breathe | Client animation off `startAt`/`endAt`; hue from `category_prefs.color_token` | §1.1 |
| **Keep working** (+10 min) | `extendBlock`: free-gap test → bounded forward cascade → *confirm only if needed*; not `reflow` | §1.1a |
| **Schedule again** | Re-stage same open task → `flight_plan` (`source_kind='reschedule'`); staged-not-placed | §1.1b |
| **Objective complete** | Sets `tasks.status='done'`+`completed_at`; cascades to FOCUS/Objective; feeds actual | §1.1 |
| Pre-block **estimate prompt** | `tasks.estimated_minutes` (prospective — the trainable one) | §2.1 |
| **Calibration chip** ("#taxes runs long — bump default?") | `estimate_calibration` (scoped, mig 0092) + `suggestEstimate`; suggest-only, human write | §2.3–2.4 |
| **EOD Alignment** (evening modal) | `reflections(kind='evening')` + `daily_plan.outcome`, on-open authorship | §2.6 |
| **Daily Brief** (morning) | `daily_summaries` + folds yesterday's EOD; incomplete-first fill | §2.7 |
| Every line of copy — timing notes, prompts, narratives | **Voice loop**: fast small model + deterministic gate + `copy_history` anti-repetition | §2V |

---

## 0. Vocabulary (map to GLOSSARY, so nothing here is a new concept)

| This spec's term | What it actually is | Backing store |
|---|---|---|
| **Focus Ritual** | The sensory timer that runs *inside* an in-progress Time Block. A render layer + `reminders` rows. Not a noun. | `time_blocks` (the block) + `reminders` (fire points) + `category_prefs.color_token` (the hue) |
| **Daily Brief** (morning) | The existing **Today's Brief** pop-up (Phase O) opened from the FOCUS card, fed by `agents/summarize.ts`. Z *adds* the "fill incomplete-first" recommendation and folds in last night's EOD Alignment. | `daily_summaries.prose`/`.focus`, `reflections(kind='evening')` |
| **EOD Alignment** (night) | The evening reflection modal + a nightly job. The day's "memory": planned-vs-done, estimate deltas, one LLM-phrased narrative. New `reflections` kind. | `reflections(kind='evening')`, `daily_plan.outcome`, `estimate_calibration` |
| **Calibration Loop** | Pre-block estimate prompt → measured actual → nightly per-scope recompute → suggest-only default-duration nudge, keyed on tags. Extends Phase N's `suggestEstimate`. | `tasks.estimated_minutes`/`actual_minutes`, `time_entries`, `estimate_calibration` (**scope-extended**) |

The single conversational entry point is **one optional modal** that hosts the morning Daily Brief and the evening EOD Alignment. It is a mode over the Planner/FOCUS surface, dismissible, and the whole feature works with it never opened.

---

## 1. The Focus Ritual — sensory-trigger system

Runs when a Time Block enters the in-progress state (derived from the clock against `startAt`/`endAt`, per M's convention — we do **not** rely on `time_blocks.status='completed'`, which is never written; see [N-life-planning.md](N-life-planning.md) L169).

### 1.0 The focus screen — progressive disclosure

Focus mode is a calm surface by design: the fewer things competing for attention, the better the cue conditions and the deeper the work. So the screen shows the **task name** prominently and always, and keeps everything else **one tap away, not on screen**.

- **Always visible:** the task **name** (the anchor), the countdown/ambient sweep, and the Category tag chip context.
- **Hidden behind icon toggles** (revealed on demand, collapsed by default so the screen stays quiet):
  - <i>notes</i> **Description** — the task's body text.
  - <i>checklist</i> **Subtasks** — child tasks with their done state (tappable to check off mid-block).
  - <i>tag</i> **Tags** — the task's level-1 and secondary tags.

Each is a small icon button in a row beneath the name; tapping expands that panel in place (and, ideally, collapses the others so only one detail shows at a time). Opening a panel is a deliberate, low-frequency act — it should never auto-expand, and it must respect `prefers-reduced-motion`. Data sources are all existing: `tasks.title`/`description`, child `tasks` via `parent_id`, and `entity_tags` (level 1 + secondary). This adds no schema — it's a layout/disclosure pattern over what the task already carries.

> **Why hide, not show:** an open description or a wall of tags during focus is exactly the peripheral load §1.2 warns about. Progressive disclosure keeps the detail retrievable without letting it sit in the visual field draining attention.

### 1.1 The four default timers

All four are **defaults**; every one is individually configurable and disableable (§4). None is load-bearing — with all cues off, the block still runs, completes, and feeds calibration exactly the same.

| # | Timer | Fires at | Haptic | Sound | Visual |
|---|---|---|---|---|---|
| T1 | **Start** | block `startAt` (or "Start now") | single pulse | short start tone | app chrome **recolors to the block's Category Color** — high-contrast, monochromatic shades of `color_token` |
| T2 | **Mid-point** | `startAt + duration/2` | single pulse | *(off by default)* | none (color continues its slow depletion) |
| T3 | **3-minute warning** | `endAt − 3 min` | single pulse | *(off by default)* | color **breathes**: fade-in over 1 min → fade-out over 1 min → fade-in over 1 min |
| T4 | **End** | `endAt` | distinct end pattern | end alarm | switch to **brand highlight color**; then reset chrome to default tokens; open the **"what's next" modal** |

**Ambient time-passage (T1→T3).** Between Start and the 3-minute warning, the Category Color **depletes** — a slow, monotonic shift (saturation/lightness ramp on the monochromatic scale) that reads in the *periphery* so the user develops felt duration without watching a clock. The depletion is a pure client animation driven by a single timer against `startAt`/`endAt`; it stores nothing.

**The final 3 minutes (T3).** The breathing pulse (in-out-in over 3×1 min) is the one deliberately *attention-recruiting* cue — it marks "land the plane." At T4 the brand highlight flashes, chrome resets to defaults (this reset is itself a conditioned "off" signal), and the modal opens.

**The "what's next" modal (T4).** Reads the next `time_blocks` row on the day (Calendar order) and shows it with a **timing note in parentheses** that surfaces the consequence of running over — e.g. *"(You planned to leave at 12:00.)"* — derived from the next block's `startAt` vs. now. Offers three actions, ordered **Keep working · Schedule again · Objective complete** (Objective complete is the primary/accent action):
- **Keep working** (left of Complete) → *"Adds 10 minutes to this block."* Extends `endAt` in place. It does **not** fire a full reflow — it disturbs the day as little as possible and only asks when it has to (see §1.1a). Voluntary "keep working" frequency, and how often it fit silently vs. forced a move, are logged secondary metrics (§5) — a proxy for estimate optimism that also feeds calibration.
- **Objective complete** → **changes the task's status** to `status='done'` and stamps `completed_at`, then finalizes the `time_entries` row → feeds the actual into the Calibration Loop. Status change cascades through existing paths: a linked FOCUS/Objective auto-checks (Phase O `reflections.done_at`), Objective progress advances (Phase N `advance_objectives`), and the block derives "done" from the task (per N L169 — we set `tasks.status`, never `time_blocks.status='completed'`). If the block holds subtasks, completing the parent follows the existing subtask-completion rule (does not silently force children done — surface incomplete children first).
- **Schedule again** → the block wasn't finished this pass. Re-stage the task back onto the **Flight-plan** (a fresh instance) so Auto/the user can re-land it later today or tomorrow. The new instance **inherits the same default variables** (estimate from the tag/category scope, tags, Category, duration); the user may adjust the estimate before it re-lands (which itself feeds the Calibration Loop as a corrected prospective estimate). Distinct from *deferred* — this is an explicit "run it again, same shape."

### 1.1a "Keep working" — minimal, confirmed extension (reflow only if needed)

Principle: **extend in place, disturb nothing that doesn't have to move, and ask before moving anything the user planned.** This is deliberately *not* the auto-defense reflow — a whole-day re-place would shuffle blocks the user never asked to touch.

**Sequence (the second pop-up only appears if it must):**
1. **Extend provisionally.** Add +10 min to the active block's `endAt` in memory (not yet committed). *(Default is +10; could later be the calibration-suggested overflow for this scope — open question.)*
2. **Free-gap test.** Find the next scheduled entity after the block (next `time_blocks` row / meeting mirror / external event, by start), using its *effective* start — including any leave-by / departure buffer. Compute the free gap between the current `endAt` and that start.
   - **Gap ≥ 10 min → no collision.** Commit silently. No reflow, no pop-up. The system checked, found room, and got out of the way.
3. **Collision → compute the minimal set first.** A local **forward cascade**: push the first colliding entity by the overflow; if that push now overlaps the next, push it by the *residual only*; **stop the instant a gap absorbs the shift.** Classify each touched entity as **movable** (auto/task blocks, soft buffers like the departure/leave-by) or **fixed** (meetings, external events, user-locked, in-progress) via `computeProtected`.
4. **One confirmation, naming the concrete consequence.** *"Move departure time? 12:00 → 12:10?"* — listing only what actually moves.
   - If the cascade runs into a **fixed** entity it can't absorb (e.g. +10 would eat into the fixed 12:30 reservation), the prompt escalates instead of overrunning it: *"This runs into Lunch with Dana (fixed). Add less time, or Schedule again?"* A fixed entity is never silently displaced.
5. **On confirm → apply only the minimal cascade** from step 3 — fewest entities, smallest deltas. A *local ripple*, not `reflow(date)`.
6. **On cancel → discard the extension;** the block ends as planned and falls back to the T4 hand-off.

**Reuse vs. new.** The movable/fixed classification reuses `computeProtected`; the gap/obstacle math reuses `dayObstacles` / `utcDayBounds`. What's genuinely new is (a) the **bounded forward cascade** (push the minimum, stop at the first absorbing gap) and (b) the **conditional confirmation gate**. Implement as a distinct engine entry — e.g. `extendBlock(blockId, +minutes)` returning `{ fits, movedSet, blockedBy }` — **not** by routing through `reflow`, whose job (structural re-place from the frozen `daily_plan` after a disruption) is the opposite of surgical.

> **As built (PR 3 — engine only).** [`engine/extend-block.ts`](../server/src/engine/extend-block.ts) `extendBlock(blockId, minutes, { commit })` returns `{ fits, committed, newEndAt, movedSet, blockedBy }`. `isFixed` = meeting / `is_locked` / `in_progress` (generalizes `computeProtected` to any following entity, since the cascade walks all subsequent blocks, not just the auto snapshot). Two-phase: `POST /api/blocks/:id/extend { minutes, confirm? }` (flag-gated, 404 off) commits a silent fit immediately, returns `movedSet` for confirmation when a move is needed, applies on `confirm:true`, and returns `blockedBy` (no write) when a fixed entity can't be absorbed. The **client "Keep working" button** lands with the Z3 focus screen — there's no surface for it yet.

> **Why this matters:** auto-defense reflow is *reactive, silent, structural*; "Keep working" is *user-initiated, minimal, confirmed*. Conflating them would make a 10-minute nudge reshuffle the afternoon — exactly the thrash the anti-thrash rules elsewhere fight. Keep them separate engine paths.

### 1.1b "Schedule again" — re-stage semantics (reuse, don't rebuild)

The block ended and the task isn't done. *Schedule again* returns it to the **Flight-plan** so it can re-land later today or tomorrow, **with the same defaults**, and gives the user a beat to adjust the estimate first. This is the *manual, immediate* twin of what `review.ts` already does nightly (re-stage open tasks with no future blocks) — so it reuses that path rather than adding one.

**It re-stages the same task; it does not clone.** The task stays `status='open'`; the just-ended `time_blocks` row is the historical "attempt 1". Because it's the same task row, its defaults — `tasks.estimated_minutes`, its level-1 `entity_tags`, and (on re-landing) the Category color re-stamped from `category_prefs.color_token` — are preserved for free. No new task, no duplication. ("Fresh instance" in the mockup copy means a fresh *placement*, not a new entity.)

**Flow (the deliberate gap between re-stage and re-land):**
1. `POST /api/flight-plan { task_id, source_kind:'reschedule' }` → `INSERT OR IGNORE INTO flight_plan (…, selected=1, position=nextPos)`. Reuses the existing stage endpoint; `source_kind='reschedule'` is the only addition (also the §5 "schedule again" metric key). The endpoint's recurrence guard still applies — habit/series instances re-land via their RRULE, not this path.
2. Mark attempt 1 so it doesn't corrupt calibration: set the ended block `status='skipped'` and flag its partial `time_entries` row **interruption-excluded** (per N L169 — partials never enter `estimate_calibration`).
3. **Staged, not placed.** *Schedule again* does **not** invoke Auto. The task sits in the Flight-plan tray where the user can edit `estimated_minutes` (and tags) on the card — a *corrected prospective estimate*, which is exactly the "accept = explicit human write" the Calibration Loop wants (§2.4). Auto/Fill places it on the next run, respecting Direction windows; if today has no room it flows to tomorrow.

**Distinct from its neighbors:** *Keep working* extends **this** block now (`extendBlock`, §1.1a); *Objective complete* closes it; *deferred* punts to a chosen date; *Schedule again* = "run it again, same shape, soon — let me fix the estimate first." Optional nicety: a today-vs-tomorrow toggle in the confirmation; default is "let Auto decide."

> **As built (PR 3 — server).** `POST /api/blocks/:id/reschedule` (flag-gated, in `routes/blocks.ts`): marks the ended block `status='skipped'`, re-stages the same task with `source_kind='reschedule'` at `MAX(position)+1`, and flips the task back to `open` via `revertTaskPlacementStatus`. The partial `time_entries` row is left untouched by design — the task stays open and calibration only reads *done* tasks, so the partial can't enter `estimate_calibration` (no schema flag needed). The estimate-edit-before-reland and the today/tomorrow toggle live in the Z3b client. ⚠️ note the as-built keeps the task `open` via revert (not "stays open" — the task was `scheduled` while it held the block); net effect matches the spec's intent.

### 1.2 Why the split: haptic vs. visual (design constraint, evidence-backed)

- **Haptics mark transitions; color renders duration.** A screen flash mid-block pulls the eyes off the work — the opposite of focus. A brief haptic signals a boundary (T1/T2/T3) without breaking gaze. So haptics own the *transitions*; the ambient color owns *continuous duration sense*. (Evidence §3.)
- **Consistency is the active ingredient.** The Start cue only conditions into a Pavlovian focus trigger if it is near-identical every time **and reserved for deep work**. Therefore the Category-Color recolor and start pulse must **not** be reused for notifications, nav, or non-focus states — the scarcity is the mechanism.
- **The brain habituates to constant stimuli.** Cues fire on transitions and reset between blocks; nothing persists all session, or it goes invisible within days.

### 1.3 Delivery (reuse Phase H, don't rebuild)

- **Foregrounded / app open:** all four timers and the color animation run **client-side** off a single in-tab scheduler synced to `startAt`/`endAt` (sub-minute precision for T2/T3 lives here; SSE only corrects drift). The Vibration API (`navigator.vibrate`) drives haptics.
- **Backgrounded:** T1 and T4 (and optionally T3) are also written as `reminders(block_id, fire_at, status)` rows so Phase H's `fire_reminders` cron + Web Push deliver them when the tab is closed. Push `showNotification` carries a `vibrate` pattern; de-dupe against the in-app cue via the notification `tag` (H's existing rule). T2 and the continuous animation are **foreground-only** (no value when the app is closed).
- **Platform reality:** `navigator.vibrate` and Notification `vibrate` are **unsupported on iOS Safari/PWA**. Haptics degrade to sound+visual there; this is a *degrade*, never a *block* (design constraint: no cue is load-bearing). Detected via capability check, surfaced in Settings.

---

## 2. The Calibration Loop — sharpening the sense of time

### 2.1 Pre-block: the estimate prompt (prospective)

At block placement / start, the user confirms or sets an estimate ("how long?"). This is the **prospective** estimate the time-perception literature finds most trainable (§3). It already exists as `tasks.estimated_minutes`; Z surfaces it as a lightweight confirm step in the ritual's entry, defaulted from the tag/category calibration below.

### 2.2 During: measured actual

Phase D's `time_entries` → `tasks.actual_minutes` captures the real duration. For timer-less completions, `actual = estimated` is **imputed and flagged**, and imputed rows are **excluded from calibration** (per N L169). Interruption-corrupted entries are likewise excluded.

### 2.3 Nightly: per-scope recompute — **key on tags** (schema change)

Phase N shipped `estimate_calibration` as a **single global row per owner** (`owner_id` PK; `bias_ratio`, `p25/p50/p75`, `sample_count`). To support the user's tag-scoped defaults ("if `#taxes` → +60m", "if `#reservation` + `#dinner` → +30m over the normal dinner block default"), Z **extends the PK to a scope**:

```
-- migration 0106_calibration_scope.ts (AS BUILT — head was 0104; manual=true, rebuildTable)
-- New PK: (owner_id, scope_kind, scope_ref). Existing global row backfills via the
-- column DEFAULTs (the rebuild copy omits the new cols → scope_kind='global', scope_ref='').
scope_kind  TEXT NOT NULL DEFAULT 'global'   -- 'global' | 'subtype' | 'tag' | 'tag_combo' | 'category' | 'objective'
scope_ref   TEXT NOT NULL DEFAULT ''         -- tag id, sorted '+'-joined tag-id tuple, category tag id, subtype, objective id, or ''
-- + calibration_combo_pins(owner_id, scope_ref, created_at) for confirmed combos.
-- Same migration moves the calibrate_estimates cron Sun 04:00 → nightly 01:30.
```

> **As built (PR 1).** The scoped math lives in [`services/calibration.ts`](../server/src/services/calibration.ts) (`computeScopedCalibration`, `robustStats`, `resolveCalibration`, `detectComboSuggestions`), shared by the nightly [`jobs/calibrate-estimates.ts`](../server/src/jobs/calibrate-estimates.ts) writer and the [`routes/calibration.ts`](../server/src/routes/calibration.ts) read/pin surface (`GET /api/calibration/scopes`, `POST/DELETE /api/calibration/pins` — all gated on `time_sense_enabled`, all 404 when off). **The flag-off path is byte-identical to Phase N** (single global row, plain percentiles, no caps) — pre-Z owners see zero change; a test pins this. The legacy `GET /api/calibration` (routes/review.ts) now reads the `scope_kind='global'` row explicitly so it keeps returning the same global bias after scopes exist.

- Nightly `calibrate_estimates` job (runs after `review_day`, before/with `aggregate_plan_outcomes`) computes **per-scope robust ratios**: median + MAD, drop outliers outside `[median ± 3·MAD]`, cap `r ∈ [0.1, 10]`, exclude imputed/corrupted. Reuse N's exact math — Z only widens the `GROUP BY` to the scope key.
- **Scope resolution / fallback** (N's ladder, with tag-combo inserted): `tag_combo → single tag → category → subtype → objective → global`. `tag_combo` = the sorted tuple of a task's level-1 tags.
- **Tag-combo materialization is hybrid (auto-suggest → user confirms).** The nightly job *detects* promising combos — a tuple whose calibration diverges materially from its component single-tag scopes and clears the confidence floor — and surfaces them as a **pin suggestion** in the EOD Alignment / editor ("`#reservation` + `#dinner` runs longer than `#dinner` alone — track it separately?"). Only a **confirmed pin** persists a `scope_kind='tag_combo'` row and starts biasing suggestions. Unconfirmed combos fall through to the single-tag scope. This avoids the sparse-data explosion of auto-materializing every tuple while still letting the system *find* the combos worth tracking. A `calibration_combo_pins(owner_id, scope_ref, created_at)` set records confirmations.
- **Three-tier confidence** (unchanged): `<5` samples → silent, fall to broader scope; `5–11` → tentative phrasing; `≥12` → confident.

### 2.4 Suggest-only default nudge (never auto-write)

`suggestEstimate(taskId)` (N's function) now resolves against the scoped table and returns a **dismissible chip** in the task/block editor: *"Tasks tagged `#taxes` run ~60m over your estimate — bump default to 90m?"* **Accept = an explicit human write** to `tasks.estimated_minutes` or the tag/category `default_minutes`. The job **never** writes an estimate itself (test-enforced, per N). The LLM may only *phrase* the chip; a deterministic template is the fallback. This is the concrete home for "adjust the default times for similar tasks given a tag."

### 2.5 No score, by design

There is **no sixth star** and **no points** for estimate accuracy. The Phase-O five-star day rewards *completed real work*; the Calibration Loop rewards *sharper judgment*, and the only readout is the trend surfaced in the EOD Alignment (§2.6). This is a deliberate anti-gamification stance grounded in the evidence (§3): extrinsic reward on a *skill* undermines the intrinsic motive to improve it.

### 2.6 EOD Alignment — the day's memory (night)

A `reflections(kind='evening')` row (new kind on the existing composite-PK table; `period_key = YYYY-MM-DD`, `position = 0`).

- **Modal-only authorship (owner decision, 2026-07-01).** The row is written **only when the user opens the evening modal** — there is no unconditional nightly auto-write. This keeps the Alignment a genuine act of reflection (not a report generated whether or not anyone looks) and avoids writing rows nobody reads. The underlying *deterministic inputs* (planned-vs-done, estimate deltas) are still computed nightly by `aggregate_plan_outcomes` / `calibrate_estimates` and simply *rendered* in the modal on open; opening the modal is what persists the `reflections` row (with any edits/notes the user adds).
- **Deterministic content (rendered on open):** planned-vs-done from `daily_plan.outcome`; per-block estimate deltas (est vs actual); today's calibration movement ("your `#deep-work` estimates tightened from +40% to +15% this week"); incomplete tasks carried forward; any pin suggestions (§2.3).
- **AI-phrased narrative (one call, small tier, on open):** `agents/summarize.ts`-style `summarizeEvening`, mirroring `summarizeDay` (cache + `inputsHash` + `fallbackProse`). **Generator ≠ evaluator**, deterministic-gated, escape hatch — works fully with Ollama down.
- **Feeds tomorrow *when present*:** the next morning's Daily Brief reads yesterday's `reflections(kind='evening')` if it exists; if the user skipped the modal, the Brief **degrades gracefully** to the deterministic planned-vs-done / carry-forward data (which always exists), just without the reflective narrative. The Brief never blocks on an Alignment having been written.

### 2.7 Daily Brief — morning (before & after scheduling)

The existing Phase-O **Today's Brief** pop-up, extended:
- **Folds in last night's EOD Alignment** (`reflections(kind='evening')` for yesterday's `period_key`) **when it exists**; otherwise falls back to the deterministic carry-forward data (§2.6).
- **Recommends filling incomplete-first:** the Brief's suggested Flight-plan order puts yesterday's carried-forward incomplete tasks ahead of fresh ones, before Auto runs. This is a suggestion into staging — placement stays deterministic (`daily_plan`), the human commits.
- Runs both **before** scheduling (here's the shape of your day / what's left over) and **after** (here's the committed plan + capacity bar from N3's R1).

---

## 2V. The Voice loop — one language engine, fast and never repetitive

Every human-facing line Companion writes — the timing note ("You planned to leave at 12:00"), the T4 what's-next line, the "move departure?" prompt, calibration chips (§2.4), the Daily Brief (§2.7), the EOD Alignment narrative (§2.6) — goes through **one path**, so the voice is consistent, sounds like a thoughtful person, and, above all, **never repeats itself.** Repetition is the specific failure mode we design against: for the wedge audience, a planner that reuses the same sentence daily becomes background noise. Anti-repetition is a retention feature, not polish.

### 2V.1 The model: fast, small, local

Use the **smallest Ollama tier** — the existing `generate(tier:'small')` seam ([agents/summarize.ts](../server/src/agents/summarize.ts), `agents/loop.ts`) pointed at a 1–3B local model. Microcopy is short, frequent, and latency-sensitive; a small model returns in well under a second, costs nothing, keeps data on-device (privacy = wedge), and is more than enough when the output is one tightly-constrained line. Reserve `tier:'medium'` for the longer EOD/weekly narrative only. The small model is the workhorse of the day-to-day voice.

### 2V.2 The loop (bounded · generator ≠ evaluator · escape hatch)

Matches the house `[feedback_ai_in_the_loop]` discipline (deterministic-gated, bounded recursion, append-only `audit_log`, escape hatch):

1. **Deterministic payload.** Compute the facts — numbers, deltas, next event, times. *Never* generated. This is the truth the line must carry.
2. **Prompt** = Voice rules (2V.4) + payload + an **avoid-list** (recent phrasings for this surface/owner, from 2V.3) + the surface's length budget + variation levers.
3. **Small model drafts** a candidate.
4. **Deterministic gate — code, not a model (the evaluator ≠ the generator):** length cap; banned-phrase list; contains the required datum (e.g. the actual time); **repetition check** (normalized-opener + trigram similarity vs. the recent-history store — fail above threshold); on-topic/safe.
5. **Fail → regenerate once**, appending the failure reason (bounded: ≤2 retries). Still failing, or Ollama down → **deterministic fallback**: draw from a rotation pool, picking an entry **not recently used**. The pool uses **datum-slotting (decision)** — each template has a slot for the unique datum (the actual time, number, or name), so even when Ollama is down and the sentence structure repeats, the *content* differs line to line. A handful of templates per surface (≈4–6) plus datum-slotting is enough to keep the offline path from feeling robotic, without hand-authoring a dozen variants.
6. **Success → emit + record** the phrasing signature to the recent-history store, so the next generation is told to avoid it.

The two guarantees: the loop is bounded (latency + cost capped) and it degrades to a rotation pool (works fully with Ollama down, and even the fallback doesn't repeat).

### 2V.3 The anti-repetition memory

A small support table — `copy_history(owner_id, surface, signature, created_at)` — holding a **rolling window** per owner×surface. `signature` = normalized opener + key trigrams (+ template id for fallbacks). Cheap to read/write; this is the operational core of "don't say it the same way twice." **Zero new nouns** — declare it non-noun support state alongside the others.

**Window is per-surface tuned (decision).** A single K is wrong: a surface seen every day needs a long memory or it goes stale within a week, while a rarely-seen surface can recur sooner unnoticed. So K is a per-surface constant, not global:

| Surface tier | Example surfaces | K (signatures kept) |
|---|---|---|
| High-frequency (daily+) | timing note, T4 what's-next, nudges, calibration chip | **~30** (≈ a month of freshness) |
| Medium | Daily Brief, EOD Alignment narrative | **~14** |
| Low-frequency | weekly review lines | **~4** |

The gate reads only its own surface's window, so a fresh timing note never collides with a Brief phrasing.

### 2V.4 The rules card (the job the model follows)

Embedded in every prompt. Reuses the CDS content voice and, if present, the user's `my-writing-style` profile.

- **Voice:** warm, plain, brief. Sentence case; contractions; verb-first. State the fact, then at most one light forward nudge. No praise, no confetti, no exclamation marks on system copy.
- **Banned:** *successfully, simply, just, unlock, leverage, seamless, empower, "great job", "keep it up", "you've got this", "let's"*, emoji, motivational-poster tone.
- **Variation levers** (rotate; never repeat the last choice for a surface): opener type (observation · question · direct address · the bare number); structure (fact-first vs. consequence-first); length (fragment vs. sentence); framing (neutral vs. gently forward-looking). The **unique datum** in each line — a specific time, number, or name — is the cheapest natural source of variety; anchor on it.
- **Grounding:** reference the real datum; never invent; when there's no signal, say less or nothing — silence beats filler.
- **Personalization (optional):** if `my-writing-style` exists, bias tone toward it so the copy sounds like the user; else house voice.

### 2V.5 Worked example — same data, three mornings

Payload: `{ next:'Lunch with Dana', planned_departure:'12:00', block_overrun:true }`. The Voice loop must never produce the same line twice:

> · *"You'd planned to leave by 12:00 — this block's about to eat into that."*
> · *"Heads up: Dana's at 12:30, and you wanted to be out the door at noon."*
> · *"Noon was your leave-by. Ten more minutes here pushes it."*

Same fact, three shapes. The recent-history store is what forces the third to differ from the first two.

### 2V.6 One service, many callers

`renderCopy(surface, payload)` centralizes it so the voice and the anti-repetition rules apply everywhere. Each surface declares its payload schema, length budget, and fallback pool: timing note (§1.1), T4 what's-next line, Keep-working/departure prompt (§1.1a), calibration chip (§2.4), Daily Brief (§2.7), EOD Alignment (§2.6), nudges. One path = one voice.

**Tests:** repetition gate rejects a near-duplicate of a stored signature; banned-word rejection; required-datum presence; fallback rotation never repeats within K; Ollama-down path never throws; generator output is never its own evaluator.

## 3. Evidence base

**Time-sense is trainable, and prospective estimation is the lever.** Time-perception deficits are among the most robust findings in the ADHD/executive-function literature, and *time-skills training* (estimation, interval reproduction, discrimination) measurably improves everyday time management, punctuality, deadline adherence, and even impulsivity. Two design consequences: **prospective** estimates (guessing an ongoing/future duration) are more accurate and more trainable than retrospective ones — so we prompt *before* the block (§2.1); and the internal clock is most reliable in the **1–10 s "psychological present"** — which is why the ambient depletion trains *felt* duration continuously rather than via a single end-alarm. ([Time Perception in Adult ADHD — decade review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9962130/), [Prospective vs. retrospective time estimation in ADHD](https://pmc.ncbi.nlm.nih.gov/articles/PMC10697718/), [Time estimation & prospective memory](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6909009/))

**A conditioned focus trigger is real — if consistency and scarcity are respected.** A neutral stimulus paired consistently with a state becomes a conditioned cue that can evoke it; deep-work practitioners use fixed rituals/playlists as Pavlovian on-switches, reliably after ~a week of consistent pairing. Hence: the Start cue must be identical every time and reserved only for focus (§1.2). The brain also *habituates* to constant stimuli, so cues fire on transitions and reset between blocks. ([Psychology Today — classical conditioning for focus](https://www.psychologytoday.com/us/blog/thinking-about-kids/201806/classical-conditioning-can-help-your-child-sleep-and-focus), [Inducing/disrupting flow](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10272888/))

**Gamification backfires when it's extrinsic.** In head-to-head testing, gamified focus apps scored high on *liking* but were used rarely and were **less** effective than dead-simple interventions (e.g. phone grayscale); and external rewards reliably **undermine intrinsic motivation**. This is the direct justification for §2.5's no-score stance and for keeping the "reward" as visible skill improvement (competence — a self-sustaining motive in Self-Determination Theory). ([The Conversation — do focus apps work?](https://theconversation.com/focus-apps-claim-to-improve-your-productivity-do-they-actually-work-271388))

**Haptic vs. visual.** The haptic/color *specifics* rest on conditioning theory + adjacent HCI work, not large trials of these exact cues for focus. Treat them as **hypotheses to validate** — which is what §5 is for.

---

## 4. Design constraints (hard rules)

1. **Every cue is configurable and disableable; none is load-bearing.** All-cues-off is a fully supported mode: the block runs, completes, and feeds calibration identically. Config lives in a `scheduling_prefs`-style flag set (mirror the `auto_defense_enabled` / `enable_rituals` pattern), per-timer (T1–T4) × per-channel (haptic / sound / color).
2. **Zero new nouns.** Enforced against [GLOSSARY.md](GLOSSARY.md). New persistence = `reflections(kind='evening')` + the `estimate_calibration` scope columns + `calibration_combo_pins` + `copy_history` + `reminders` rows. Declare them all as non-noun support state in the GLOSSARY amendment.
3. **Deterministic core, AI on top.** Calibration math, planned-vs-done, and the ambient animation are deterministic. Every LLM touch (EOD narrative, Brief phrasing, calibration chip) has a built fallback and works with Ollama down.
4. **Suggest-only.** The calibration job never writes `estimated_minutes`/`default_minutes`; accept is always an explicit human write (test-enforced, inherited from N).
5. **Scarcity of the focus cue.** Category-Color recolor + start pulse are reserved for in-progress focus blocks only — never notifications, nav, or idle states.
6. **Accessibility & platform.** Respect `prefers-reduced-motion` (disables the ambient animation, keeps discrete cues); color is never the sole signal (pair with sound/haptic/text); iOS haptic absence degrades, never blocks.
7. **Reuse H for delivery.** No new push/SW/cron infra — Z adds `reminders` rows and timer cases only.

---

## 5. A/B test plan (behind feature flags)

**Goal:** validate the haptic and ambient-color claims (§1.2, §3) — do they improve time-estimation accuracy and focus without harming retention — before defaulting them on.

### 5.1 Flags

A flag set in the prefs layer (mirror `scheduling_prefs`), each independently togglable and remotely assignable:

- `focus_ritual_enabled` — master gate for §1.
- `haptic_cues_enabled` — T1–T4 haptics.
- `ambient_color_enabled` — depletion + breathing animation.
- `calibration_loop_enabled` — §2 prompt + scoped nudge.
- `z_experiment_arm` — assignment bucket (below).

### 5.2 Design — between-subjects 2×2 factorial (haptic × color)

| Arm | Haptic | Ambient color | Notes |
|---|---|---|---|
| **A (control)** | off | off | plain end-alarm only; calibration loop still on so accuracy is measurable |
| **B** | on | off | transition cues only |
| **C** | off | on | duration rendering only |
| **D** | on | on | full ritual |

Randomize **per owner** (multi-tenant, Phase T), **fixed arm per owner for the whole study** (between-subjects).

> **Why not a crossover.** A within-subject ABAB crossover is normally the higher-powered choice at low N, and it was the initial instinct here. It is **rejected for this feature** on both validity and humane-design grounds — and the two agree:
> 1. **The intervention's mechanism *is* consistency.** A conditioned focus cue only becomes a trigger by firing identically every time (§1.2, §3). Switching it on and off week to week doesn't just add statistical carryover — it **prevents conditioning from ever forming** and measures a broken version of the treatment. Carryover isn't a nuisance parameter here; it's the whole effect.
> 2. **It's user-hostile.** Giving someone a focus ritual, letting them build a habit around it, then removing it for a week trains them to distrust the cue and disrupts real work. We won't degrade a user's week for cleaner error bars.
>
> So the design that is **simpler to build, kinder to the user, and more internally valid** is the same one: a fixed between-subjects arm. We buy back the lost power by (a) measuring the longitudinal **calibration slope** per owner rather than a single cross-sectional mean, (b) a longer exposure window, and (c) pre-registering the primary endpoint to avoid multiple-comparison leakage. If N is too small for significance, we report effect sizes with CIs and treat it as a pilot — never by reintroducing a crossover.

### 5.3 Metrics

**Primary** (from `estimate_calibration` + `daily_plan.outcome`, all deterministic):
- **Estimation accuracy trend** — per-owner rolling MAPE `|actual − estimated| / estimated`, and its **slope** over the exposure window. This is the core "sharpened sense of time" outcome.
- **On-time block starts** and **overrun rate** (`time_blocks.status='overrun'`).
- **Block completion rate** (task `done` via `daily_plan.block_id` join).

**Secondary:**
- Focus-session length; EOD Alignment open rate; self-reported focus (one 1-tap scale in the EOD modal).
- **"Keep working" rate + fit-silently-vs-forced-move ratio** (T4 modal). This is a *calibration signal*, not just a UX metric: how often a block needs a +10 nudge measures estimate optimism, and the share of those nudges that fit silently (free gap) vs. forced a confirmed move tracks how tightly the day is packed against reality. A rising forced-move ratio for a scope is corroborating evidence that its `estimate_calibration` bias is real — cross-check it against the scope's bias_ratio in the EOD Alignment.
- **"Schedule again" rate** (`source_kind='reschedule'` on `flight_plan`) — how often blocks don't finish in one pass; a per-scope spike flags chronically under-estimated work.

**Guardrails / backfire detection:**
- **Cue-disable rate** per channel (the honest satisfaction proxy — if people turn it off, it's noise, not signal).
- Notification-dismissal rate; **D1/D7/D30 retention**; ritual-abandonment mid-block.

**Habituation check (pre-registered):** compare weeks 1–2 vs weeks 3–4 within the exposed arms. If the accuracy/completion lift **decays**, that is the habituation risk from §1.2 materializing — response is to make cues rarer/transition-only, not louder.

### 5.4 Ship gate

Default a channel **on** only if it shows a positive calibration-slope effect **and** a non-negative retention effect **and** a cue-disable rate below a pre-set threshold. Any channel that only moves *liking* without moving accuracy stays opt-in (the §3 lesson: enjoyment ≠ efficacy).

---

## 6. Build order & migrations

**PR 1 (built):** the **Time-Sense master flag** (`0105`, `time_sense_enabled` on `scheduling_prefs`, default OFF, per-owner; Settings → Preferences toggle labelled "Time-Sense") + **Z0** + **Z1**. Everything ships dark: with the flag off the calibration job is byte-identical to Phase N and every Z endpoint 404s.

**PR 2 (built):** **Z6** (suggest-only estimate chip) + **Z2** (Daily Brief folds in last night's EOD Alignment). Both flag-gated; no new migrations (they build on 0106/Z1).

**PR 3 (built):** the **`extendBlock` engine + `POST /api/blocks/:id/extend`** ("Keep working", §1.1a) — the deterministic, unit-tested server half of the T4 modal, plus "Schedule again" (§1.1b).

**PR 4 (built):** **Z4** (focus-cue background reminders + push vibrate) and **Z3b** (the Focus Ritual client screen — the visible centerpiece: timers, ambient color, T4 modal). Remaining: the per-cue prefs matrix + experiment arms (Z5) and the voice loop (Z7).

| Step | Work | Migration | Dep | Status |
|---|---|---|---|---|
| — | **Time-Sense master flag** (`time_sense_enabled`, Settings toggle, `lib/flags.ts` helper) | `0105_time_sense_flag` | — | ✅ **built** |
| Z0 | `estimate_calibration` scope-keyed PK + `calibration_combo_pins` + backfill; robust per-scope math (cap + median±3·MAD) in `services/calibration.ts`; scope fallback ladder (`resolveCalibration`); combo auto-suggest (`detectComboSuggestions`); read/pin routes; cron Sun→nightly | `0106_calibration_scope` | N (exists) | ✅ **built** |
| Z1 | `reflections(kind='evening')` + `summarizeEvening` (mirror `summarizeDay`, deterministic fallback) + on-open authorship routes (`GET`/`POST open`/`PUT`) | none (new kind) | N, M | ✅ **built** |
| Z2 | Daily Brief extension: fold in EOD Alignment (`morningCarryover` in summarize.ts, attached to `GET /api/summary` when flag on; "Last night" section in `DayGoals.tsx` `TodaysBrief`, degrades to carry-forward when prose null). ⚠️ incomplete-first is surfaced as a *recommendation* (carry_forward list shown first) — the flight-plan **staging-order** change is deferred to the Z3 client work, so the deterministic placement path stays untouched | none | O (Today's Brief), Z1 | ✅ **built** |
| Z3a | **T4 server actions** — "Keep working" (`extendBlock` + `POST /api/blocks/:id/extend`, §1.1a: bounded cascade, confirm-before-move, blockedBy) + "Schedule again" (`POST /api/blocks/:id/reschedule`, §1.1b: skip + re-stage `source_kind='reschedule'` + reopen). "Objective complete" already exists (task status→done) | none | — | ✅ **built** |
| Z3b | Focus Ritual client screen — `client/src/components/FocusRitual.tsx` (full-screen overlay) + pure logic `client/src/lib/focus.ts` (phase/depletion/cues, unit-tested). Task name + progressive disclosure (desc/subtasks/tags behind icon toggles); ambient category-color depletion + `focus-breath` (final 3 min); tick-driven haptic cues (`navigator.vibrate`, capability-guarded); T4 modal wiring extend/reschedule/complete; `prefers-reduced-motion` disables the animation (discrete cues remain). Current in-progress block derived from the clock vs `start_at`/`end_at` (a 30s tick in Today.tsx; no SSE channel needed); a flag-gated "Focus" button in the Day Overview opens it; arms Z4 background cues on open, clears on exit. | none (client) | Categories color tokens | ✅ **built** |
| Z4 | Focus-cue background reminders + push `vibrate`. `syncBlockFocusReminders`/`clearBlockFocusReminders` (engine/reminders.ts) arm T1=start/T3=end−3min/T4=end as `reminders` rows with `source` ∈ focus_start/warn/end (distinguishes them from `source='auto'`, so `syncTaskReminders` never touches them). `POST`/`DELETE /api/blocks/:id/focus-reminders` (flag-gated) — the Focus screen arms the block it's on (no cross-block spam). `contentFor` adds per-cue titles + haptic `vibrate` patterns; sw.js passes `vibrate` to `showNotification`. `fireDueReminders` now also gates BLOCK-targeted reminders on block + linked-task status, so a skipped/completed block or a done task falls silent (covers "Schedule again" + "Objective complete"). | none (reuses H) | H | ✅ **built** |
| Z5 | Prefs flag set (per-timer × per-channel) + Settings UI + experiment arm assignment (expands the master flag into the §5.1 matrix) | `≥0107_focus_prefs` | Z3 | ⬜ |
| Z6 | Suggest-only calibration chip — `suggestEstimate` (services/calibration.ts, snapped to 5m, null below floor / <15% bias / <5m delta) + `GET /api/calibration/suggest/:taskId` (flag-gated) + dismissible chip in `ElementWizard` task fields (accept sets the estimate field → human write on Save) | none | Z0 | ✅ **built** |
| Z7 | **Voice loop** (2V): `renderCopy` service + small-model tier + deterministic gate + `copy_history` anti-repetition memory + fallback pools per surface | `≥0108_copy_history` | M (Ollama seam) | ⬜ |

**GLOSSARY amendment:** declare `reflections(kind='evening')`, the `estimate_calibration` scope columns + `calibration_combo_pins`, and the Focus-Ritual `reminders` rows as **non-noun support state**; confirm no label in the ritual/brief/alignment introduces a new user-facing noun.

---

## 7. Decisions & open questions

**Resolved (2026-07-03, PR 1):**
- **`kind` value → `'evening'`** (Q1). The reflections row uses `kind='evening'`, `position=0`.
- **T4 "add time" default → fixed +10 min** (Q2) for now; the calibration-suggested overflow is a later refinement once Z3/Z6 land.
- **T3 3-minute-warning sound → stays OFF by default** (Q3); it remains individually enableable.
- **`calibrate_estimates` cadence → nightly 01:30** (moved from Sun 04:00): the loop needs fresh scopes every morning, and 01:30 is the slot 0095 vacated (runs after `review_day` at 01:00).
- **Feature-flag granularity → one master `time_sense_enabled`** for PR 1; the per-timer × per-channel matrix (§5.1) and experiment arms defer to Z5.

**Resolved (2026-07-01):**
- **EOD Alignment authorship → modal-only.** Written only when the user opens the evening modal; the Brief degrades gracefully when absent (§2.6, §2.7). *(As built: `POST /api/reflections/evening/open` is the authorship act — idempotent, `refresh:true` regenerates, a user's `PUT` edits survive re-opens. There is **no nightly EOD job** — the §2.6 "nightly EOD job" line is superseded; deterministic inputs are computed live by `gatherEvening` on read.)*
- **Tag-combo scope → hybrid.** Job auto-*suggests* divergent combos; only user-confirmed pins persist a `tag_combo` scope (§2.3).
- **Experiment design → between-subjects 2×2, no crossover.** Rejected the crossover because the intervention's mechanism is consistency and toggling it both breaks validity and harms the user (§5.2).
- **Voice-loop repetition window → per-surface tuned** (K≈30 high-frequency / 14 medium / 4 low), not a single global K (§2V.3).
- **Voice-loop offline fallback → pool + datum-slotting** (≈4–6 templates per surface, unique datum slotted so content varies even when structure repeats) (§2V.2).

**Still open (owner's call):**
1. **Pin-suggestion surface** — combos are already surfaced in the EOD Alignment payload (`combo_suggestions`) and via `GET /api/calibration/scopes`; also inline on the task editor when a matching combo is detected? (deferred to Z6's editor work.)
2. **Combo divergence threshold** — Z0 hard-codes a 25% divergence-from-every-component floor + the shared ≥5-sample confidence floor for a combo to be *suggested*. Confirm, or make it tunable?
3. **T4 "add time"** — revisit fixed +10 vs calibration-suggested overflow once Z3/Z6 make the scope suggestion available at block end.
