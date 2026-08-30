# Triality — three candidate next actions, behind a flag

> ## ✅ Status: BUILT (2026-07-30), shipping dark.
>
> This is the decision record and implementation spec for the **Triality** feature —
> an arithmetic candidate-ranking layer that predicts **three** plausible next
> actions (habitual · contextual · feasibly-novel). Master flag:
> **`triality_enabled`** (scheduling_prefs, default `0`; flag-off = no routes, no UI, no
> suggestion computation — but *not* byte-identical, see §7).
>
> **Delivered in five waves** (T1–T9 of `factory/drafts/triality-waves.md`):
> **#433** wave 1 (flag, outcome log, situation vector, motivation axis) · **#434**
> wave 2 (scoring engine) · **#435** wave 3 (REST + GraphQL surfaces) · **#436**
> wave 4 (Focus banner + Balance metrics tiles) · wave 5 = `feat/triality-wave-5`
> (learning loop, rationale garnish, this docs pass). The four wave PRs are stacked
> and were still open when this line was written — check GitHub for their merge state.
>
> **Surfaces, as built** — Focus carries the **suggestions** (a dismissable banner);
> Balance → Metrics carries the **measurement** (acceptance per slot, the Novel uptake
> trend, deficit response, and the learned weights with their sample counts + the
> reset-learning button). No new routed view.
>
> Two as-built deviations to know about:
>
> - **§6b's wording on the weights tile** — it shows the **learned** numbers and an explicit
>   "learning not started" fallback; it does not render the defaults alongside them.
> - **"No LLM in the scoring path" (§11) was written broader than what shipped.** No
>   *generative* model chooses, writes, or re-orders a pick — that part holds absolutely.
>   But `noveltyScores` in `services/triality.ts` blends cosine distance from an
>   **embedding** centroid into N at 50% whenever the owner's embedder is installed, Ollama
>   answers, and the owner has ≥ 5
>   recent completions, and N carries weight 0.30 in the Contextual and Novel slots (0 in
>   Habitual). So stopping Ollama can change the picks against identical SQLite state, and
>   the honest claim is *reproducible at a fixed embedding availability* rather than
>   unconditionally deterministic. The stage is bounded — `EMBED_CANDIDATE_CAP = 40`
>   (a bigger pool skips embedding entirely rather than half-embedding it),
>   `EMBED_TIMEOUT_MS = 3000` per call, and one `NOVELTY_BUDGET_MS = 4000` deadline over the
>   whole stage with an all-or-nothing categorical fallback — so a slow Ollama degrades the
>   ranking instead of stalling the request. It is also *gated*: the stage is entered only
>   when `ollama.embedReady()` confirms the effective embedder is pulled, so a box that
>   cannot embed never pays the budget and never sees N wobble between two identical
>   requests. §5 and §11 below are narrowed to match.
>
> **Migration numbers below are the DESIGN's "next free slot" placeholders; as built
> the feature occupies `0139_triality_flag` · `0140_triality_log` ·
> `0141_task_motivation` · `0142_triality_weights` · `0143_calibrate_triality_job`**
> (authoritative order: `server/src/db/migrations/index.ts`). Two other spots read as
> pre-build intent rather than as-built fact: §8's endpoint table lists two routes
> where four exist (`DELETE /api/triality/weights` and `GET /api/metrics/triality`
> came with the learning wave), and its "No cron job" line was superseded by §6b —
> `calibrate_triality` is real (Monday 03:50, owner-scoped), so the job counts moved by one
> (and that line's "deterministic and cheap" carries the same qualification as §5's N).
> This doc deliberately keeps **no copy of those counts**: count the `case` labels in
> `server/src/jobs/index.ts` for executable kinds and the seeded `scheduled_jobs` INSERTs in
> `server/src/db/migrations/` for cron rows. README and ARCHITECTURE carry the two dated,
> verified numbers; a third copy here has already rotted once on this branch.
>
> Post-AG features carry no phase letter (ARCHITECTURE §1.1). The name is **Triality**,
> nothing else — this doc exists partly so we never repeat the two-phases-named-Z
> collision.
>
> **Owner decisions locked 2026-07-29** (§11): slot vocabulary is
> **Habitual · Contextual · Novel** (canonical everywhere — enum, constants, UI copy);
> Novel is *pulled toward* under-served categories, never hard-required; **the surfaces
> split by role — Focus carries the suggestions as a dismissable banner; Balance →
> Metrics carries measurement: the existing task metrics plus new Triality-derived
> metrics** (third same-day refinement; §11.3 keeps the audit trail); **GraphQL parity
> ships with the build**; **the system learns over time** — bounded, batch,
> evidence-only weight calibration from the outcome log (§6b; supersedes the initial
> "no self-tuning" non-goal).

## 1. The thesis, condensed

Represent the owner's **current situation** as a balanced-ternary vector
(each dimension ∈ {−1, 0, +1}: opposed/absent · unknown/neutral · supportive/present).
Represent each **candidate action** as a template vector over the same dimensions.
A dot product `s · a` is then a fast, deterministic measure of contextual fit.

The output is deliberately **not** one prediction. It is three, with different
scoring postures:

| Slot | Meaning | Posture |
|---|---|---|
| **Habitual** *(thesis: "Normal")* | the habitual continuation | favor habit strength + sequence history |
| **Contextual** *(thesis: "Adjacent")* | a familiar action adapted to the present situation | favor contextual fit, allow moderate difference |
| **Novel** | a less typical but feasible action | favor novelty, hard-require capacity |

Component scores per candidate:

- **F** — context fit: `s · a` over the active (non-zero) dimensions
- **H** — habit strength: how often this owner does this
- **Q** — sequence fit: how often it follows what they just did
- **N** — novelty: distance from their normal pattern
- **C** — capacity: can it actually be done right now

Slot rankings (weights are starting constants, not preferences — see §7):

```
S_habitual   = 0.40·F + 0.40·H + 0.20·Q
S_contextual = 0.50·F + 0.20·H + 0.30·N
S_novel      = 0.35·F + 0.15·H + 0.30·N + 0.20·C
```

Pipeline order matters and is fixed:

```
candidate actions → capacity FILTER (hard) → component scores → slot ranking → 3 picks
```

The thesis's own stated limitation is adopted verbatim as a product rule: a dot
product measures resemblance, not causation. The output is **three candidate
continuations, never three certainties** — and the UI copy must say so.

## 2. Why this app, specifically

Triality is not a bolt-on; each of its commitments is already a doctrine here:

- **Deterministic hot path.** Scoring is integer/rational arithmetic over local
  SQLite rows — same inputs, same three picks. No LLM anywhere in the scoring
  path (the two-clocks doctrine: the deterministic engine defends the day; the
  LLM only garnishes). This keeps the local-first invariant trivially intact.
- **The honest zero.** Balanced ternary's `0 = unknown` is the vector-space form
  of the Metrics tab's founding rule ("where there is no data the tile says so
  rather than rendering a confident zero"). A dimension we cannot measure
  contributes *nothing* — it is never guessed.
- **Suggest-only.** Like AA3's memory-aware ordering and the flight plan itself,
  Triality proposes and the owner disposes. It never schedules, never writes
  placements, never touches `daily_plan` (the input-honesty postmortem applies).
- **Append-only feedback.** Outcomes land in an append-only log
  (`calibration_history` / `copy_history` precedent) so future weight tuning is
  evidence-based — and v1 does **no** self-tuning (bounded recursion, per the
  AI-in-the-loop principles).
- **It closes the Balance loop.** Priorities = stated intent; Metrics = measured
  reality; Triality is the missing third act: *given both, what would moving the
  needle actually look like right now?* The Contextual/Novel targets are biased
  toward under-served categories (§6), which is what makes this a Balance
  enhancement rather than a generic recommender.

**Naming discipline:** Habitual/Contextual/Novel is a *suggestion-posture*
vocabulary (owner-locked; one vocabulary everywhere — enum values, constants, UI
copy — with the thesis terms Normal/Adjacent kept only as provenance notes). Note
the near-collision deliberately accepted: **"Habitual" the slot is unrelated to
"Habit ◯" the pattern type** — the slot describes *how a pick was chosen*, the
type describes *what a pattern is*. GLOSSARY entries ship with the feature and
must draw exactly this line; the triad is also unrelated to the direction triad
(Home/Work/Community).

## 2b. Theoretical lens — the Markov blanket

The vocabulary that makes the whole design cohere, and the source of its v2
diagnostic rule. A Markov blanket is the set of states that renders inside and
outside statistically independent: once the blanket is known, nothing beyond it
adds information.

- **`s` is a claimed blanket.** Triality's core bet is that the situation vector
  is a sufficient boundary between the owner's life and the prediction of their
  next action. The honest zero is *blanket honesty* — "this part of the boundary
  is unsensed right now" — and the rejected dims (weather, location, social) are
  admitted holes: places where the real boundary of behavior passes outside what
  a local-first system can see.
- **Learning is inference across the blanket, only.** Sensory states = `s`;
  active states = the pills and the owner's open/stage/dismiss; internal states
  = `triality_weights`; external states = the owner's actual life, never observed
  directly. Every `triality_log` row is one complete blanket transaction —
  (situation, action offered, response) — and §6b is the internal model reducing
  surprise over those transactions. The system never learns *the owner*; it
  learns *the owner as seen through this blanket*. That is the only honest claim
  available.
- **The slots are three postures toward the blanket.** Habitual = the prior
  (boundary nearly ignored) · Contextual = perception-led (condition hard on
  today's sensory states) · Novel = the **epistemic action**, chosen partly for
  the information its outcome generates. A dismissed Novel pick is still a
  useful blanket transaction — it maps where the owner's boundary of
  plausibility sits — which is why the metrics track Novel *trend*, not just
  rate, and why low Novel uptake alone never argues for removing the slot.
- **The leaky-blanket warning — §6b's bounds are the antidote.** When the true
  cause of a dismissal lives outside the dims (the walk was skipped because of
  rain; weather isn't in `s`), the update rule will misattribute the error to
  F/H/N — conditional independence was assumed, not real, and the weights absorb
  noise. The clamps, the 20-outcome floor, batch-only updates, and the visible
  weights tile exist to cap and expose exactly that. **Diagnostic rule (pinned
  for v2): if learning plateaus or oscillates, widen the blanket — add dims to
  T2's registry — never turn up the learning rate.** Chasing a leak with
  aggressiveness launders noise into confident weights.
- The metrics' "moved with, never because" copy (§9.2) is blanket humility as
  product language: blankets yield conditional dependence, never causation.

## 3. The situation vector `s`

Every dimension is owner-scoped, computed at request time in the owner's timezone,
and **defaults to 0 when its source has no data**. v1 dimensions:

| Dim | Source | +1 | 0 | −1 |
|---|---|---|---|---|
| `in_work_hours` | `scheduling_prefs` work hours | inside | — | outside |
| `day_energy` | most recent close-ritual rating with `reaction_at` within 3h ([0137](../server/src/db/migrations/0137_close_ritual.ts), rescored [0161](../server/src/db/migrations/0161_completion_score.ts)) | 4 · 5 | 3 / **no recent reading** | 1 · 2 |
| `free_gap` | minutes until next fixed block (locked/meeting `time_blocks`) | ≥ 45m | 15–45m / no calendar data | < 15m |
| `day_type` | `day_types` resolution for today | work-typed | unset | rest-typed |
| `momentum` | a `time_entries` row running now, or a completion in the last 30m | yes | no signal | idle > 3h during work hours |
| `memory_context` | Phase AA connector (only when `memory_pull_enabled`) | related upcoming event | **off / nothing related** | — |
| `cat_deficit[c]` ×6 | Balance deficit per category (§6) | under-served | on-target / no self-audit | over-served |

**Explicitly rejected dimensions** (the thesis mentions them; we have no honest
source): weather, location, social setting. Local-first means no external
context APIs; if these ever arrive it will be through the memory graph, as
`memory_context` refinements — not as new fabricated dims.

Action templates `a` use the same dimensions, derived from the action's own rows:
its categories (via `entity_categories`, falling back to the linked-task
inheritance rule), its direction tag, its estimate vs. the free gap, and its
historical time-of-day distribution.

## 3b. The motivation axis — me / us / them (owner-locked 2026-07-29; vocabulary and LLM-first labeling locked later the same day)

Every task carries an optional **motivation**: who the work is for.

- **`me` (+1)** — the owner's own legacy: priorities alignment, personal
  success, self-directed work. *(drafted as `i`/internal)*
- **`them` (−1)** — other people: volunteering, caregiving, going out when
  they don't want to, studying to make their mom happy. *(drafted as `o`)*
- **`us` (0)** — genuinely shared benefit, self and others at once.
  *(drafted as `x`/both)*

One vocabulary everywhere (the Habitual lesson): enum values, dim names, UI copy
all say `me`/`us`/`them`; `i/x/o` survives only as this provenance note.
⚠️ Disambiguation for the GLOSSARY: **`us` the motivation ≠ Community the
direction tag** — motivation says who benefits, direction says which life sphere
the work happens in ("volunteer at the shelter" is direction Community,
motivation `them`).

**The 0-overload wrinkle, resolved.** The encoding maps `us` to 0 — but the
honest-zero rule reserves 0 for *unknown*. These must stay distinguishable or the
metrics lie. Resolution: **storage is a nullable enum** (`'me'|'us'|'them'`,
NULL = unlabeled) so measurement always tells "shared" from "never asked";
**scoring encodes both `us` and NULL as 0** — a shared-benefit task is *neutral
on this axis*, exactly like an unsensed one, and neither should tip a dot
product. The distinction lives in the data; the collapse lives only in the
arithmetic.

**Labeling is LLM-first (owner-locked).** On task creation and during the
enrichment pass, the local small model attempts the tag before any human is
asked — this is what keeps coverage high enough for the axis to mean anything.
The guardrails that make LLM-first safe:

- **Constrained output** — `ollama.generateJson` with a one-of-three-or-null
  schema; the 3B prompt gotchas apply (output shape first, no trailing rules,
  no refusal-clause reliance). Classifier qualifiers live in `rubric.ts` (the
  one-source rule).
- **Unsure ⇒ NULL, never `us`.** `us` is a positive claim of shared benefit,
  not a shrug. The deterministic keyword fallback (Ollama down) is even more
  conservative: obvious `them` signals ("for mom", "volunteer", "help X"),
  obvious first-person-goal `me` signals, else NULL.
- **Provenance column** — `motivation_source` `'user'|'llm'` beside the value.
  A user-set label (wizard) always wins, is never re-tagged, and the metrics
  disclose the llm-tagged share so nobody mistakes model coverage for owner
  testimony.
- **Wrong-tag blast radius is bounded by the ternary:** a mistaken `us` is
  scoring-inert (0); the damaging error is a `me`↔`them` flip, which inverts
  one dim of one candidate — and the owner can correct it in the wizard, which
  ends the argument permanently.

Blocks inherit their linked task's motivation, the `entity_categories`
inheritance pattern — no second column.

**How it enters Triality:**

1. **Action-template dim** — each candidate carries its motivation; via F it
   lets the situation pull toward or away from them-directed work.
2. **Situation dim `motivation_balance`** — homeostatic, self-referenced (no
   stated target exists, unlike categories): ternarize the drift of the 30d
   me-share of *timed minutes* against the owner's own 90d baseline. Recent
   window much more them-directed than the owner's norm → +1 (pull toward `me`);
   much more me-directed → −1 (pull toward `them`); within band or
   unlabeled-heavy → 0. Share math excludes NULL from numerator *and*
   denominator. Pulled, not required — the same posture as category deficits (§6).
3. **Metrics for free** — the close ritual already stamps a rating per completion,
   so *mood by motivation* ("work for them leaves you stressed 38% of the time;
   your own, 9%") costs zero new collection. §9.2 gains the motivation tiles,
   including the llm-vs-user label-share disclosure.
4. **Learning caveat, stated honestly** — §6b learns component weights (F/H/Q/N/C),
   so it senses this axis only through F's aggregate; per-dim attribution
   ("dismissals correlate with `them` picks specifically") is a v2 item under
   the §2b widening rule, not a v1 promise.

In §2b terms this is a textbook blanket widening: one new entry in T2's dim
registry plus a labeled attribute on the action side of the boundary.

## 4. The candidate space `A`

v1 candidates are **existing actions only**:

- open tasks (due/scheduled today, overdue, or undated), excluding blocked ones
  (`task_dependencies`)
- routines/habits whose checklist is open today (`patterns`)
- staged flight-plan items (`flight_plan`)
- saved block templates (`block_templates`)

**No synthesized actions in v1.** The thesis's most seductive output ("record a
voice note *while walking*" — a novel combination) requires a generator, and the
AI-in-the-loop rule is generator ≠ evaluator. v1 is pure evaluator: "novel"
means *a real action this owner rarely picks, that fits now*. Synthesis is a v2
with its own design pass.

Sparse-history floor: fewer than **10 ritual-or-timer-confirmed completions** in
the window → Triality refuses to rank (the card renders its honest empty state,
§9). Ranking noise dressed as insight is exactly what this app refuses to ship.

## 5. Component scores (all arithmetic, all owner-scoped)

Window: 90 days, matching the Metrics tab's longest window.

Four of the five components are pure arithmetic over local SQLite rows and depend on
nothing outside the database. **N is the exception** — it reaches a local embedding model
when one is reachable (below), which is the whole of the feature's I/O and the reason
"deterministic" is qualified rather than absolute in the status box.

- **F (context fit)** = `s · a` normalized by the count of *active* (non-zero in
  both vectors) dimensions → [−1, 1] rescaled to [0, 1]. Unknown dims dilute
  nothing — they are simply absent from the denominator.
- **H (habit strength)** = recency-weighted completion frequency of the action's
  *signature* — `(kind, direction, category-set)` — using half-life 14d over
  `tasks.completed_at` / `time_entries`. Routines use their checklist history.
- **Q (sequence fit)** = first-order transition frequency from the signature of
  the owner's most recent completion to this candidate's signature, computed from
  the `completed_at` ordering. No new table — it is a scan over 90 days of local
  rows, which SQLite does in microseconds at this app's scale.
- **N (novelty)** = `1 − H_class` where `H_class` is habit strength at the
  signature-class level; when the owner's effective embedder is actually pulled
  (`ollama.embedReady()` — *reachable* alone is not enough, and an unknown installed set
  counts as no) *and* the owner has ≥ 5
  completions in the window, blended 50/50 with cosine distance from the centroid of the
  owner's last 25 completed-task embeddings (`nomic-embed-text`, same fallback ladder as the
  dedupe path in `services/possibles.ts`). Ollama down ⇒ the categorical term alone. Never
  blocks, and as built never stalls either: a pool over `EMBED_CANDIDATE_CAP` (40) skips
  embedding **entirely** rather than half-embedding it (a partly-blended pool is two
  rankings interleaved, not a ranking), each call is capped at `EMBED_TIMEOUT_MS` (3s), and
  the stage as a whole races one `NOVELTY_BUDGET_MS` (4s) deadline with an all-or-nothing
  categorical fallback. Because N weighs 0.30 in Contextual and Novel, this is also the one
  path by which external state can move a pick — see the status box.
- **C (capacity)** = 1 if `estimated_minutes` (or the memory fallback estimate,
  AA3b) fits the free gap with ≥ 5m margin, scaled down toward 0 as the fit
  tightens; multiplied by an energy factor (`day_energy = −1` halves C for
  candidates whose estimate > 30m). The capacity **filter** (pipeline stage 1)
  drops candidates that cannot fit at all or are blocked; the **C term** grades
  comfort among survivors.

**Slot assignment.** Each surviving candidate also gets a ternary triple
`[normality, pragmatism, capacity]` (thresholds on H, F, C: top-third → +1,
bottom-third → −1, else 0). Slots select by dot product against fixed targets —
`t_hab = [+1,+1,+1]`, `t_ctx = [0,+1,+1]`, `t_nov = [−1,+1,+1]` — with the slot's
`S_*` ranking as tie-break, then stable order by id (bit-for-bit reproducible).
Assignment is greedy Habitual → Contextual → Novel with exclusion, so the three
picks are always three *distinct* actions. A slot with no qualifying candidate
renders empty with a reason — it does not steal a mismatched one.

## 6. The Balance coupling (what makes this a Metrics feature)

Per category `c`, define the deficit from both halves of the Balance view:

```
stated_c   = clamp(importance_c − satisfaction_c, −9..9) / 9        (life_priorities)
measured_c = (target_share_c − timed_share_c)                        (taskMetrics minutes)
deficit_c  = ternarize( 0.5·stated_c + 0.5·measured_c )              → −1 | 0 | +1
```

`deficit_c` is the `cat_deficit[c]` dimension of `s`. The consequence falls out
of the arithmetic with no special cases: the **Habitual** slot is deficit-blind
(honest about what you'll probably do anyway), while **Contextual** and **Novel** —
whose targets weight context fit — are **pulled toward** actions filed under
under-served categories, never hard-required to come from one (owner-locked,
2026-07-29). Missing self-audit rows or an empty timed window
ternarize to 0: no data, no pull. `measured_c` reuses
[`taskMetrics`](../server/src/services/task-metrics.ts) rather than re-deriving
minutes — one source of measured truth.

## 6b. The learning loop (owner-locked 2026-07-29: "the system should learn over time")

The repo already owns this shape: `calibrate_estimates` — a **regenerable rollup**
recomputed by a scheduled job from durable evidence, consumed at read time, never
trusted as history (`calibration_history` holds the trend). Triality copies it:

- **Evidence** = `triality_log` outcomes (it doubles as the learning history — no
  new history table). Reward per row: `staged` +1 · `opened` +0.5 · `dismissed` −1
  · still-`shown` after 24h counts as *ignored* −0.25 (younger than 24h is **pending** —
  undecided, and not evidence at all). As built, the window read is first passed through
  `collapseImpressions`: `triality_log` is an *impression* log, so one vote is kept per
  (slot, action, owner-local day) — a decision beats an impression, otherwise the earliest
  `shown` row represents the group. Without it, re-opening the Focus banner would
  manufacture evidence and could clear the floor below with no owner feedback at all.
- **Update rule** (deterministic batch, 90d window, per owner × slot): for each
  component k ∈ {F,H,Q,N,C}, `delta_k` = mean of `reward_i · (s_k,i − mean(s_k))`
  over outcome rows (the per-pick component scores are already persisted in
  `scores` JSON — that decision is what makes learning possible at all). Then
  `w_k = clamp(default_k · (1 + 0.5·delta_k), 0.5·default_k, 2·default_k)`,
  renormalized so the slot's weights sum to the default sum. Worth stating once, because
  the summaries elsewhere read as though the clamp were routine: **on real evidence the
  clamp never binds.** Every component score is provably in [0,1] and `parseScores`
  rejects anything outside that range as an absent score, which caps `|delta_k|` at 0.5
  and therefore `1 + 0.5·delta_k` inside [0.75, 1.25] — well within [0.5, 2]. The clamp is
  a guard against a corrupt or hand-edited row, not an operation the weekly pass performs.
- **Floor:** fewer than **20 outcome-bearing rows for a slot** → that slot stays
  on defaults. Learning never runs on noise.
- **Job:** `calibrate_triality`, weekly cron, **owner-scoped** (must join
  `OWNER_SCOPED_KINDS` — the fan-out-per-owner rule). This deliberately reverses
  the earlier "no new cron jobs" line; README/ARCHITECTURE job counts move with it.
- **Storage:** `triality_weights` — one regenerable row per (owner, slot):
  weights JSON, `sample_count`, `computed_date`. The engine reads
  `getWeights(owner)` → learned row if present and floored, else defaults.
  Deleting the rows is the **reset switch** (an audited, owner-initiated action
  surfaced with the metrics) — the log survives, so learning can be re-earned. Say this
  plainly wherever the affordance is described, UI copy included: a reset clears the
  **derived** weights and the next weekly pass **re-derives from the untouched log**. It is
  a recompute, not a permanent opt-out — an owner who wants the defaults to stand has to
  turn the flag off. As built the button is therefore labeled **"Recompute from scratch"**,
  not "Reset learning", and it renders only once weights exist.
- **Bounds are the contract:** batch (never online, never mid-request), clamped
  (each weight to ½×–2× of its default, then renormalized so the slot's weights still sum
  to the default total), reproducible (same log → same weights), per-owner, and
  fully visible — the Balance metrics show effective vs default weights with the
  sample counts. Unbounded or opaque adaptation stays a non-goal. The bounds are
  also the leaky-blanket guard (§2b): they cap how far an error misattributed to
  the wrong component can bend the model. When learning underperforms, the §2b
  diagnostic rule applies — widen the blanket, never the learning rate.

## 7. Storage & flag

- **Migration (next free slot):** `scheduling_prefs.triality_enabled`
  boolean default `0` — same shape as `time_sense_enabled` (schema.ts §
  scheduling_prefs). Flag-off means **no routes, no UI, no suggestion computation** — the
  four surfaces 404 and nothing writes `triality_log`. It is *not* byte-identical, and the
  earlier wording claiming so was wrong: `0143_calibrate_triality_job` seeds the
  `calibrate_triality` cron row **unconditionally**, so on any deployment every owner gets
  the weekly `job_runs` row, its `job:run` SSE broadcast, and one extra row in the Jobs
  view forever. The pass no-ops on an empty log, which is why seeding it unconditionally is
  safe — but "no-op" and "byte-identical" are different claims and only the first is true.
- **Migration (next free slot + 1):** `triality_log`, append-only:

```sql
CREATE TABLE triality_log (
  id          TEXT PRIMARY KEY,            -- uuid7()
  owner_id    TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  shown_at    TEXT NOT NULL,
  local_date  TEXT NOT NULL,               -- owner-tz 'YYYY-MM-DD'
  slot        TEXT NOT NULL,               -- 'habitual' | 'contextual' | 'novel'
  action_kind TEXT NOT NULL,               -- 'task' | 'routine' | 'flight' | 'template'
  action_ref  TEXT NOT NULL,
  scores      TEXT NOT NULL,               -- JSON {F,H,Q,N,C,total,ternary:[..]}
  outcome     TEXT NOT NULL DEFAULT 'shown', -- shown|opened|staged|dismissed
  outcome_at  TEXT
);
```

  Persisting the full score breakdown is what makes future weight-tuning
  evidence-based instead of vibes-based. ⚠️ **Add `triality_log` to `resetDb`** —
  the 0137/0138 wave established that forgetting append-only tables there breaks
  the test harness (see the close-ritual handoff note).
- Weights and thresholds are **named constants**, not prefs — the *defaults*. They live in
  **two** files, and knowing which is which saves a wrong-file edit: the scoring constants
  (`DEFAULT_WEIGHTS`, the slot targets, the embedding bounds) are in
  `services/triality.ts`; the learning constants (`LEARNING_WINDOW_DAYS`, `PENDING_MS`,
  `OUTCOME_FLOOR`, `REWARDS`, `LEARNING_FACTOR`, `CLAMP_LO`/`CLAMP_HI`) are in
  `services/triality-learning.ts`. The engine reads weights through one seam,
  `getWeights(owner, slot)`, which returns the learned `triality_weights` row when
  present and floored (§6b) and a **copy** of the defaults otherwise (including when a
  stored row is all zeros). `triality_weights` ships with the learning wave (its own
  next-free migration), not here.
- ⚠️ **`PENDING_MS` is a two-site invariant.** The 24h pending boundary is declared
  independently in `services/triality-learning.ts` and `services/triality-metrics.ts` — the
  duplication is deliberate (the metrics tile must not import the learning job), but it
  means editing one and not the other makes the tile and the weekly pass disagree about
  which rows count as evidence. Change both, in the same commit.
- `calibrate_triality` is the **one** scheduled job this feature adds (weekly,
  owner-scoped, §6b); the suggestion path itself stays request-time only. Job counts are
  deliberately not written down here — count the `case` labels in
  `server/src/jobs/index.ts` for executable kinds and the seeded `scheduled_jobs` INSERTs
  under `server/src/db/migrations/` for cron rows (minus the ones a later migration
  retired). README and ARCHITECTURE hold the two dated copies of those numbers.

## 8. API

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/triality/next` | The three candidates with full per-component score breakdowns + the situation vector actually used. **404 while `triality_enabled` is off** — the shipped flag-gating idiom (`routes/calibration.ts` under `time_sense_enabled`); the client gates on the flag it already has from `GET /api/prefs`. Read scope. |
| POST | `/api/triality/feedback` | `{log_id, outcome}` — stamps `opened`/`staged`/`dismissed` on the log row. Write scope. |

No cron job — computed on request (deterministic and cheap), so the Jobs
view/count is untouched. **GraphQL parity ships with the build** (owner-locked):
a `trialityNext` query + `trialityFeedback` mutation on the Phase W Apollo
schema, calling the same owner-scoped `services/triality.ts` the REST routes
call — parity by shared service layer, the W convention, not a second
implementation. The response's score breakdown **is** the explanation: the UI
popover shows the arithmetic. An optional Ollama one-liner per pick (small
model, `daily_plan` "why now" precedent) is garnish — labeled as AI, template
fallback, never blocking.

## 9. UI

The two surfaces **split by role** (owner-locked 2026-07-29, third same-day
refinement — §11.3 keeps the trail):

1. **Focus = the suggestion surface.** `TrialityBanner.tsx` — a **dismissable
   banner** between the header/Time-Sense hero and the today list. Three pills
   (title + category swatch + slot label), *open*/*stage* per pill, the score
   breakdown behind a tap. The banner's ✕ dismisses the **whole banner for the
   rest of the owner-local day**: it stamps `dismissed` on the still-open shown
   rows and collapses via a localStorage date key (per-device by design in v1 —
   a dismissal is a mood, not data worth syncing).
2. **Balance → Metrics = the measurement surface.** No suggestion chips here.
   `BalanceMetrics.tsx` keeps its existing task metrics and gains
   **Triality-derived tiles** reading `triality_log` + `triality_weights`:
   acceptance rate per slot (staged+opened / shown), the Novel uptake trend
   (is feasible novelty actually taken?), deficit response (did acting on
   Contextual/Novel picks move under-served categories' minutes?), and the
   **learned weights vs defaults** with sample counts — plus the reset-learning
   action (§6b). Same honesty rules as the rest of the tab: no data → the tile
   says so.

   **Motivation-axis visuals (§3b)** join the same section: a **motivation
   split** bar (timed minutes me/us/them per window, with the unlabeled share
   shown — never silently excluded — and the **llm-tagged share disclosed**);
   **mood by motivation** (the existing MoodBar per me/us/them — close-ritual
   data, zero new collection); a **drift sparkline** (me-share vs the owner's
   own 90d baseline — the same series `motivation_balance` ternarizes, so the
   dim's input is literally visible); and **acceptance by motivation** in the
   Triality tiles (do you take suggestions for you, or for them?). On the
   banner, each pill carries a small glyph (● me · ◐ us · ○ them; unlabeled
   gets none). In the wizard, a 3-way segmented control (`me · us · them`,
   default unset — the LLM has usually answered first; a user tap overrides it
   permanently).

Today stays out — the cockpit is already dense (Phase AC's whole point was
decluttering it), and Focus is one tap away. Banner pills, copy owner-locked:

> **Habitual** · **Contextual** · **Novel**

Each chip: title, category stripes
(existing texture tokens), a transparent "why" popover (the score arithmetic +
which situation dims fired), and two actions — *open* (TaskCard/ElementWizard)
or *stage* (flight plan). Both go through existing surfaces; Triality itself
never mutates a task. Empty/refusal states are first-class copy: "not enough
history yet (N of 10 reflected completions)" beats an over-confident guess.

## 10. Degradation ladder (nothing below ever blocks the card)

| Missing | Effect |
|---|---|
| Recent ritual mood | `day_energy = 0`; C's energy factor inert |
| Ollama | categorical novelty only; template rationale |
| Ollama reachable but slow, or a candidate pool over 40 | categorical novelty only — the whole embedding stage is skipped or abandoned as one unit (§5), never partially applied |
| Ollama reachable but no embedder pulled (or the installed set is unknown) | categorical novelty only — the stage is not entered at all, so "no embedder" and "a slow embedder" are not the same observable event |
| < 5 completions in the window | categorical novelty only — too little signal for a meaningful centroid |
| Memory (off/unreachable) | `memory_context = 0` |
| Life-priorities self-audit | `stated_c = 0` — deficit pull halves |
| < 10 reflected completions | refuse to rank; honest empty state |
| < 20 outcome rows per slot | learning inert — that slot scores on default weights (§6b) |

## 11. Non-goals and locked decisions

**Non-goals:** auto-scheduling or any write to placements · **online/unbounded
learning** (batch, clamped, evidence-only calibration per §6b is in scope; anything
mid-request or beyond the ±2× clamps is not) · synthesized/novel-combination
actions · **any generative model in the scoring path** — no LLM chooses, writes, or
re-orders a pick, and the ranking is arithmetic; this non-goal is *narrowed* to match what
shipped, since a local **embedding** model does contribute half of N when Ollama is
reachable (§5, and the status box's second as-built deviation) · cross-owner learning ·
exposing weights as
*settings* (they are displayed and resettable, never hand-edited) · **any surface
beyond Focus (suggestions) and Balance → Metrics (measurement)** (Today explicitly
excluded — Phase AC declutter).

**Locked decisions (owner, 2026-07-29)** — these were this doc's open questions;
where they disagree with anything above, this list wins:
1. **Chip copy: Habitual · Contextual · Novel** — and the same triple is the
   canonical vocabulary in code (slot enum, `S_*` constants, log values), so no
   translation layer exists between UI and storage.
2. **Novel is pulled, not required** — the deficit dims bias the dot product;
   there is no category filter on any slot.
3. **Surfaces split by role: Focus = dismissable suggestion banner, Balance →
   Metrics = measurement (task metrics + Triality metrics)** — this ruling moved
   twice on 2026-07-29: Balance-only → both-views-show-picks → the role split
   that stands. Today remains excluded — a standing non-goal above. This line is
   the audit trail of those reversals.
5. **The system learns over time** (added with the role split) — bounded batch
   weight calibration per §6b, on the `calibrate_estimates` pattern; supersedes
   the initial "no weight self-tuning / no new cron jobs" non-goals. The bounds
   (batch, the ½×–2× clamp *with* the renormalization back to the default weight
   sum, 20-outcome floor, per-owner, visible, resettable) are part
   of the decision, not implementation detail.
6. **The motivation axis (me/us/them)** — tasks carry who-the-work-is-for
   motivation (me/legacy +1 · us/shared 0 · them/others −1), §3b; drafted as
   i/x/o, vocabulary re-locked to me/us/them the same day. **Labeling is
   LLM-first** (owner-locked): the local model tags on creation/enrichment via
   constrained JSON, unsure ⇒ NULL (never `us`), `motivation_source` tracks
   user-vs-llm, a user label wins permanently. Storage keeps `us` ≠ unlabeled
   (nullable enum); scoring collapses both to 0; the `motivation_balance` pull
   is homeostatic against the owner's own baseline (flag at review if a stated
   target is wanted instead); metrics gain the motivation visuals incl. the
   llm-share disclosure (§9.2).
4. **GraphQL parity ships with the build** — `trialityNext` query +
   `trialityFeedback` mutation over the same service layer (§8), landing in the
   same PR wave as the REST routes, not deferred.

## 12. Test plan (per slice, TDD — the Phase N pattern)

1. **Vector builder** — frozen clock, `TZ=UTC`, no wall-clock date literals (the
   time-bomb rule): each dim's +1/0/−1 per source state; every "no data → 0" row
   in §3's table gets an explicit test.
2. **Scoring** — determinism (same DB fixture ⇒ identical triple, twice) **with
   `embedFn: null`**, the injectable seam that forces categorical novelty: the assertion is
   about the arithmetic, and it must not be allowed to depend on a reachable Ollama;
   capacity filter drops blocked/oversized; slot exclusion yields three distinct
   picks; empty-slot refusal.
3. **Balance coupling** — a seeded deficit flips a Contextual pick; missing
   self-audit exerts zero pull.
4. **Flag** — off ⇒ all four surfaces return **404 with `{error:'Not found'}`** (a disabled
   feature looks absent, not broken — §8, `routes/triality.ts` + `routes/metrics.ts`), and
   no log rows are written. An early draft of this line said `{enabled:false}`; it was never
   built that way and the route must not be "fixed" toward it. What flag-off does *not*
   guarantee is byte-identity — the `calibrate_triality` cron row is seeded either way (§7),
   so assert the 404 shape and the absent log rows, never an untouched `scheduled_jobs`.
5. **Log** — append-only outcomes; `resetDb` covers `triality_log`.
6. **Degradation** — each ladder row in §10, including Ollama-down novelty.
7. **GraphQL parity** — `trialityNext` / `trialityFeedback` mirror the REST
   behavior case-for-case, including flag-off and the sparse-history refusal
   (same service layer, so a divergence is a test bug worth catching).
8. **Learning** — update-rule determinism (same log twice → identical weights);
   clamps hold under adversarial rewards — but note the shape this line originally
   suggested does not exercise them: with *uniform* rewards (all −1 / all +1) the
   deviations from the mean sum to zero, so every delta is exactly 0 and the weights come
   back at defaults. That is worth a test of its own ("uniform feedback teaches nothing");
   pushing against the clamp needs reward *variation* correlated with a component, and per
   §6b real evidence cannot reach the bound at all — the clamp's test is a hand-written
   out-of-range `scores` row, which `parseScores` rejects as absent; the 20-outcome floor;
   renormalization keeps the weight sum; reset deletes rows, preserves the log,
   and the next request scores on defaults; `calibrate_triality` fans out
   per-owner and never touches another owner's rows (two-owner fixture).

## 13. Rollout

Ship dark → owner self-use with the log accumulating → revisit weights against
logged outcomes (accepted-per-slot rates) → only then consider v2 (per-owner
weight fitting — bounded and explicit — and generated novel candidates, each
behind its own design pass).
