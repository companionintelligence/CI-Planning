# Z — Focus Ritual & the Calibration Loop (implementation spec)

**Status:** Draft · not started · **Migration head `0086`** (Phase O claims `0088–0090`, FU2 claims `0087`; **Z migrations start at `≥0091`**). **Depends on / builds on:** Phase **D** (`time_entries`, `tasks.actual_minutes`), Phase **H** (service worker, Web Push/VAPID, `reminders`, `fire_reminders` cron), Phase **M** (`daily_plan`, `daily_plan.outcome`, `agents/summarize.ts`, `agents/plan.ts`), Phase **N** (`reflections`, `estimate_calibration`, `suggestEstimate`, morning ritual), the **Categories** axis (`tags.kind='category'`, `category_prefs.color_token`, `time_blocks.category_id`/`color_token`), and Phase **O** (Today's Brief pop-up, five-star day). Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), [N-life-planning.md](N-life-planning.md), [O-gamified-stars.md](O-gamified-stars.md), [H-notifications-webpush.md](H-notifications-webpush.md), [M-ai-scheduler.md](M-ai-scheduler.md), [D-time-tracking.md](D-time-tracking.md).

> **Why this phase.** The planner already *captures* estimates, actuals, the frozen day order, and completion signal — but it never closes the loop back to the human in a way that **sharpens their sense of time** or **triggers focus**. This phase adds two coupled mechanisms: (1) a **Focus Ritual** — a consistent multi-sensory block-timer that conditions a focus on-switch and renders time as ambient color rather than an anxious countdown; and (2) a **Calibration Loop** — a pre-block estimate prompt and a post-day *EOD Alignment* that turn the app's own actuals into better default durations, keyed on tags. The design deliberately gives **no points and no star** for prediction accuracy — the reward is the visible improvement of the user's own judgment (see *Evidence* → intrinsic motivation).
>
> **Noun budget: zero new nouns.** *EOD Alignment* and *Daily Brief* are **flows/modes over existing surfaces**; their persistence is a new `kind` on the `reflections` support table plus columns on existing tables — the same class as `daily_plan` / `plan_outcomes` / `day_stars`. The Focus Ritual is a client-side render layer over an existing Time Block plus `reminders` rows. Nothing here earns a row in the noun table.

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

**The "what's next" modal (T4).** Reads the next `time_blocks` row on the day (Calendar order). Offers two actions:
- **Complete** → sets the block's task(s) `status='done'`, stamps `completed_at`, finalizes the `time_entries` row → feeds actuals into the Calibration Loop.
- **Add time** → extends `endAt` and triggers the existing Phase-M **auto-defense reflow** (`reflow(date, reason='extend')`), which re-places only movable downstream blocks from the frozen `daily_plan`. Voluntary "add time" frequency is a logged secondary metric (§5).

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
-- migration ≥0091_calibration_scope.ts (idempotent, owner-scoped, B0 runner)
-- New PK: (owner_id, scope_kind, scope_ref). Backfill existing global row as scope_kind='global'.
scope_kind  TEXT NOT NULL DEFAULT 'global'   -- 'global' | 'subtype' | 'tag' | 'tag_combo' | 'category' | 'objective'
scope_ref   TEXT NOT NULL DEFAULT ''         -- tag id, sorted tag-id tuple, category id, objective id, or ''
```

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

## 3. Evidence base

**Time-sense is trainable, and prospective estimation is the lever.** Time-perception deficits are among the most robust findings in the ADHD/executive-function literature, and *time-skills training* (estimation, interval reproduction, discrimination) measurably improves everyday time management, punctuality, deadline adherence, and even impulsivity. Two design consequences: **prospective** estimates (guessing an ongoing/future duration) are more accurate and more trainable than retrospective ones — so we prompt *before* the block (§2.1); and the internal clock is most reliable in the **1–10 s "psychological present"** — which is why the ambient depletion trains *felt* duration continuously rather than via a single end-alarm. ([Time Perception in Adult ADHD — decade review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9962130/), [Prospective vs. retrospective time estimation in ADHD](https://pmc.ncbi.nlm.nih.gov/articles/PMC10697718/), [Time estimation & prospective memory](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6909009/))

**A conditioned focus trigger is real — if consistency and scarcity are respected.** A neutral stimulus paired consistently with a state becomes a conditioned cue that can evoke it; deep-work practitioners use fixed rituals/playlists as Pavlovian on-switches, reliably after ~a week of consistent pairing. Hence: the Start cue must be identical every time and reserved only for focus (§1.2). The brain also *habituates* to constant stimuli, so cues fire on transitions and reset between blocks. ([Psychology Today — classical conditioning for focus](https://www.psychologytoday.com/us/blog/thinking-about-kids/201806/classical-conditioning-can-help-your-child-sleep-and-focus), [Inducing/disrupting flow](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10272888/))

**Gamification backfires when it's extrinsic.** In head-to-head testing, gamified focus apps scored high on *liking* but were used rarely and were **less** effective than dead-simple interventions (e.g. phone grayscale); and external rewards reliably **undermine intrinsic motivation**. This is the direct justification for §2.5's no-score stance and for keeping the "reward" as visible skill improvement (competence — a self-sustaining motive in Self-Determination Theory). ([The Conversation — do focus apps work?](https://theconversation.com/focus-apps-claim-to-improve-your-productivity-do-they-actually-work-271388))

**Haptic vs. visual.** The haptic/color *specifics* rest on conditioning theory + adjacent HCI work, not large trials of these exact cues for focus. Treat them as **hypotheses to validate** — which is what §5 is for.

---

## 4. Design constraints (hard rules)

1. **Every cue is configurable and disableable; none is load-bearing.** All-cues-off is a fully supported mode: the block runs, completes, and feeds calibration identically. Config lives in a `scheduling_prefs`-style flag set (mirror the `auto_defense_enabled` / `enable_rituals` pattern), per-timer (T1–T4) × per-channel (haptic / sound / color).
2. **Zero new nouns.** Enforced against [GLOSSARY.md](GLOSSARY.md). New persistence = `reflections(kind='evening')` + the `estimate_calibration` scope columns + `reminders` rows. Declare all three as non-noun support state in the GLOSSARY amendment.
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
- Focus-session length; voluntary **"add time"** frequency (T4 modal); EOD Alignment open rate; self-reported focus (one 1-tap scale in the EOD modal).

**Guardrails / backfire detection:**
- **Cue-disable rate** per channel (the honest satisfaction proxy — if people turn it off, it's noise, not signal).
- Notification-dismissal rate; **D1/D7/D30 retention**; ritual-abandonment mid-block.

**Habituation check (pre-registered):** compare weeks 1–2 vs weeks 3–4 within the exposed arms. If the accuracy/completion lift **decays**, that is the habituation risk from §1.2 materializing — response is to make cues rarer/transition-only, not louder.

### 5.4 Ship gate

Default a channel **on** only if it shows a positive calibration-slope effect **and** a non-negative retention effect **and** a cue-disable rate below a pre-set threshold. Any channel that only moves *liking* without moving accuracy stays opt-in (the §3 lesson: enjoyment ≠ efficacy).

---

## 6. Build order & migrations

| Step | Work | Migration | Dep |
|---|---|---|---|
| Z0 | `estimate_calibration` scope columns + backfill global row; widen `calibrate_estimates` GROUP BY; scope fallback ladder | `≥0091_calibration_scope` | N (exists) |
| Z1 | `reflections(kind='evening')` + `summarizeEvening` (mirror `summarizeDay`) + nightly EOD job | none (new kind) | N, M |
| Z2 | Daily Brief extension: fold in EOD Alignment + incomplete-first fill suggestion | none | O (Today's Brief), Z1 |
| Z3 | Focus Ritual client render layer: 4 timers, ambient depletion, breathing, T4 modal; capability + `prefers-reduced-motion` gates | none (client) | Categories color tokens |
| Z4 | `reminders` rows for T1/T3/T4 (background delivery) + push `vibrate` payload | none (reuses H) | H |
| Z5 | Prefs flag set (per-timer × per-channel) + Settings UI + experiment arm assignment | `≥0092_focus_prefs` | Z3 |
| Z6 | Suggest-only calibration chip wired to scoped table (accept = human write) | none | Z0 |

**GLOSSARY amendment:** declare `reflections(kind='evening')`, the `estimate_calibration` scope columns, and the Focus-Ritual `reminders` rows as **non-noun support state**; confirm no label in the ritual/brief/alignment introduces a new user-facing noun.

---

## 7. Decisions & open questions

**Resolved (2026-07-01):**
- **EOD Alignment authorship → modal-only.** Written only when the user opens the evening modal; the Brief degrades gracefully when absent (§2.6, §2.7).
- **Tag-combo scope → hybrid.** Job auto-*suggests* divergent combos; only user-confirmed pins persist a `tag_combo` scope (§2.3).
- **Experiment design → between-subjects 2×2, no crossover.** Rejected the crossover because the intervention's mechanism is consistency and toggling it both breaks validity and harms the user (§5.2).

**Still open (owner's call):**
1. **`kind` value** — `'evening'` vs `'eod'` for the reflections row (naming consistency with `'morning'` from N3's R1)?
2. **T4 "add time" default** — fixed +N minutes, or the calibration-suggested overflow for that scope?
3. **Sound defaults** — T2/T3 sounds are off by default above; confirm, or default T3 sound on (it's the "land the plane" cue)?
4. **Pin-suggestion surface** — offer combo pins in the EOD Alignment only, or also inline on the task editor when a matching combo is detected?
