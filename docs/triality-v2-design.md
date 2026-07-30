# Triality v2 — sensing what v1 can't, and knowing what it doesn't know

> ## ⚠️ Status: DESIGN (2026-07-30). Waves v2.1 and v2.2 are SHIPPED; everything else is unbuilt.
>
> **v2.1 landed on main the same day this was drafted** (`5625329`, merged with the
> wave-5 stack via #438): `collectCandidates` now honors `defer_until` (§3.1) and the
> `memory_context` dim no longer claims to be sensed (§1's bug). The audit table below
> is kept as written — it is the record of what the audit *found*, and those two rows
> now read as pre-fix history.
>
> **v2.2 (§4 confidence) is built — derive, store and report, with no gating.** As
> shipped it is `server/src/services/triality-confidence.ts` (the whole arithmetic, with
> zero runtime imports), `DecisionTelemetry` + `evidenceRows` + runner-up capture in
> `services/triality.ts`, migration `0144_triality_confidence`, a `confidence` object on
> every non-null pick in **both** `/next` surfaces, and `calibration` on
> `GET /api/metrics/triality`. **A `guess` still fills its slot** — nothing suppresses,
> reorders or filters a pick. §4's "may render empty instead" is v2.5 work and did *not*
> ship here; §13 carries the gate it has to clear first.
>
> **One §4 formula was written against a ranking the engine does not use.**
> `margin = (S_top − S_runner_up) / max(S_top, ε)` assumed the slot score ranks the pool.
> It is a **tie-break** in a lexicographic `[dot, S, ref]` key, so that subtraction goes
> negative in the ordinary case rather than an exotic one. §4 below is narrowed to the
> four-branch form that shipped and keeps the superseded line on the record with its
> counter-example. Two `coverage` claims and one `evidence` claim are narrowed there too.
> Waves v2.3+ remain design only.
>
> v1 is built and shipping dark behind `triality_enabled` (waves 1–5, PRs #433–#436
> plus `feat/triality-wave-5`, all merged via #438). This document extends
> [triality-design.md](triality-design.md);
> where the two disagree about v1 behavior, **v1's doc wins**. Every section still
> describes what is *proposed* except the two marked ✅ SHIPPED (§3.1 and §4), which
> now describe what was built — and where those two disagree with the code, **the code
> wins and this doc is wrong**.
>
> Migration numbers are written as `next-free` — check
> `server/src/db/migrations/index.ts` first, always. The v1 head at drafting was
> `0143_calibrate_triality_job`; v2.2 moved it to `0144_triality_confidence`. That
> sentence is the only copy of the number in this file, and `index.ts` outranks it.
>
> **Doctrines that do NOT change in v2** are listed in §9 and are not up for
> negotiation by any track below: deterministic ranking, honest zeros, bounded
> batch learning, local-first, suggest-only, no generative model in the ranking.

## 1. The v1 audit — an honest scorecard

Verified against the code on 2026-07-30, not from memory. This section exists so
v2 is built on what is actually missing rather than on what feels missing.

| Signal | v1 status | Where it lives / why not |
|---|---|---|
| **Action frequency** | ✅ **Yes** | `H` — recency-weighted completion frequency (14-day half-life, 90-day window), normalized by the pool max. Routines match by membership; block templates have no completion trail so `H = 0`, honestly. |
| **Direction-type frequency** | ⚠️ **Only indirectly** | Direction is one field of the H/Q *signature* `(kind, direction, category-set)`. So a **rare combination scores `H = 0` even when its direction is the owner's most frequent** — there is no standalone direction-frequency signal, and no back-off. §3.4 fixes this. |
| **Recent action sequences** | ⚠️ **First-order, one step** | `Q` — transition frequency from the signature of the single most recent completion. No second-order chains, no time-conditioned transitions. §6. |
| **Time** | ⚠️ **Coarse only** | `in_work_hours`, `day_type`, `free_gap`, `momentum`. **No time-of-day band and no day-of-week** — and the app already *collects* a band (`ParsedQuick.timeOfDay`, used by the wizard's slot proposal) which the engine ignores entirely. §3.2/§3.3. |
| **Location** | ❌ **No** | Deliberately rejected in v1 §3 as an admitted blanket hole: no local source, and local-first rules out a location API. §5 opens the only honest route — the memory graph's own place facts. |
| **Current constraints** | ⚠️ **Mostly** | Hard capacity filter (estimate vs. free gap), dependency-blocked exclusion, locked/meeting blocks, an energy factor from close-ritual mood. **Gap: `tasks.defer_until` is not filtered** — a task the owner explicitly hid until a future date can still be suggested today. §3.1 (and this one is small enough to backport to v1). |
| **Confidence scoring** | ❌ **No** | `scores.total` is a weighted sum, not a calibrated confidence. There is no margin, no evidence-weight, no per-pick uncertainty — only the global refusal floor (<10 confirmed completions), which is binary and all-or-nothing. §4 is the answer, and it is v2's most valuable single track. |
| **Feedback when a prediction is wrong** | ⚠️ **Yes, but blunt** | The learning loop prices `dismissed = −1` and `ignored = −0.25`, recalibrating component weights weekly. But it is **aggregate**: it can learn "weight F less", never "don't offer the gym on Mondays". Worse, **all dismissals are priced identically** — "already did that" teaches the same lesson as "wrong time", which is simply false. §7. |

**One v1 bug this audit turned up** *(✅ fixed in v2.1, `5625329`)*, worth fixing regardless of v2: the
`memory_context` dim reports itself **active** whenever `memory_pull_enabled` is
on while its encoder unconditionally returns `0`
(`services/triality-vector.ts`). It is a stub that claims to be a sensed
dimension. Harmless in v1 (a 0 contributes nothing to `F`), but §4's coverage
measure is built on `meta.active`, so it must be made truthful **before**
confidence ships — otherwise coverage silently overstates how much of the
blanket was actually sensed.

## 2. What v2 is for

Three themes, in priority order. Each maps to the §2b Markov-blanket lens from
v1: v1's own pinned diagnostic rule is *when learning underperforms, widen the
blanket — never crank the rate*, and v2 is that rule taken seriously.

1. **Sense more of the boundary** (§3, §5, §6) — time-of-day, day-of-week,
   real constraints, hierarchical frequency, and the dims only the memory graph
   can supply (people, places, commitments).
2. **Know what it doesn't know** (§4) — per-pick confidence, and the honesty to
   render an empty slot rather than a confident guess. *(As built, v2.2 delivered
   the first half only: it reports and hedges. Suppressing a slot is v2.5, and §13
   states what has to be true before it is allowed to.)*
3. **Learn where it was wrong, not just that it was wrong** (§7) — a dismissal
   reason turns one aggregate signal into targeted, per-dim-group attribution.

## 3. Track A — constraint and time fidelity

Small, unglamorous, and the highest ratio of correctness gained to work done.

### 3.1 `defer_until` is a constraint (backportable to v1) — ✅ SHIPPED in v2.1 (`5625329`)

`collectCandidates` selected *(pre-fix)* `status IN ('open','scheduled')` with no
`defer_until` clause. A deferred task is one the owner explicitly removed from
today's attention; surfacing it as a *suggestion* contradicts that instruction
more loudly than listing it would. Add `AND (defer_until IS NULL OR defer_until
<= :now)` to the candidate query. No schema change, no flag — this is a v1 bug
with a two-line fix and a test.

### 3.2 Time-of-day band as a paired dim

The situation gains `time_band` ∈ {morning, afternoon, evening} derived from the
owner's clock and work hours, ternarized *per candidate* rather than globally:
the action template carries the band the owner historically completes that
signature in (computed from `completed_at` hour distributions, 90-day window,
requiring a minimum sample or the template band is **absent** — honest zero, not
a guessed band). The pairing is +1 when the candidate's modal band matches now,
−1 when it is the opposite end of the day, 0 when unknown.

This also finally consumes `ParsedQuick.timeOfDay`: a task whose band the owner
*stated* at capture uses the stated band and skips the histogram entirely (user
testimony beats inference — the same precedence rule as the motivation axis).

### 3.3 Day-of-week

`day_kind` ∈ {weekday, weekend} exists implicitly via `day_type`, but the useful
signal is finer: "Sunday-ish" behavior is not "Saturday-ish". Add a
`dow_affinity` pairing on the same shape as §3.2 — the candidate's modal
day-of-week from its completion history vs. today, with a sample floor and an
honest absent state. Deliberately *not* a seven-way categorical dim: ternary is
the whole vector's contract, so this is match / mismatch / unknown.

### 3.4 Hierarchical H — back-off, so a rare signature isn't evidence-free

Today's signature is specific enough that a genuinely frequent activity can
score `H = 0` because its exact `(kind, direction, category-set)` triple is
novel. Replace the single lookup with a **back-off blend** (the standard
smoothing move):

```
H = w₃·H(kind, direction, categories)      # exact signature
  + w₂·H(kind, direction)                   # direction-level frequency  ← delivers §1's missing signal
  + w₁·H(kind)                              # kind-level base rate
```

with `w₃ ≥ w₂ ≥ w₁` and the weights *shifting toward the specific level as its
sample count grows* (a Jelinek–Mercer-style interpolation, all deterministic
arithmetic). Two consequences worth stating: direction-type frequency becomes a
first-class signal, and `N = 1 − H_class` inherits the improvement, so novelty
stops mistaking "unusual combination" for "unfamiliar activity".

## 4. Track B — confidence scoring — ✅ SHIPPED in v2.2 (report only, no gating)

The headline capability, and the one that most changes how the feature *feels*.
Confidence is **derived, deterministic, reported — and never fed back into the
ranking** (a score that both ranks and rates itself is circular). As built that
guarantee is structural rather than intended: `services/triality-confidence.ts`
reaches `services/triality.ts` through `import type` only and holds no DB handle,
no clock and no I/O, and `services/triality.ts` never names it back in either
direction of the type graph.

Three orthogonal components, each computable from state v1 already has. **As shipped:**

```
coverage = (non-zero dims among meta.active) / |meta.active|       // |meta.active| = 0 ⇒ 0
           — how many of the dims the vector says it can sense are pulling in a direction
margin   = four branches on the key the engine actually compares (table below)
           — how decisively this candidate won ITS slot
evidence = min(1, evidenceRows / EVIDENCE_FULL)                    // EVIDENCE_FULL = 8
           — how many 90-day completions match this candidate under H's own predicate
```

`|meta.active|` is **12** once the owner has work hours configured and **11**
without — and **never 13**, because v2.1's truthfulness fix took `memory_context`
out of `active` permanently until something actually senses it. The band
constants are set so `firm` and `tentative` mean the same *dim counts* at both
denominators (≥5 and ≥3), so a band means one thing in English either way.

Combined by the **weakest link, not the average**. Averaging lets a decisive
margin hide the fact that nothing was sensed; a minimum cannot. Each component
is rounded to 3dp **first**, then `value = min(coverage, margin, evidence)`, then
the band is a pure function of that stored `value` — **firm** at ≥ `FIRM_AT`
(0.4), **tentative** at ≥ `TENTATIVE_AT` (0.2), **guess** below. Rounding before
the minimum is load-bearing, not tidiness: it is what lets a reviewer verify a
stored row with a calculator, where banding an unrounded minimum would let a
printed `0.400` carry `tentative`.

### 4.1 `margin = (S_top − S_runner_up) / max(S_top, ε)` is SUPERSEDED

That formula assumed the engine ranks by slot score. **It does not.** Stage 4
compares `[dot, S, ref]` lexicographically and `S` is only the **tie-break**, so
the subtraction is not measuring the decision that was made. It fails in the
*ordinary* case, not an exotic one: a winner at dot 3 / S 0.4 legitimately beats
a runner-up at dot 2 / S 0.9, and the formula returns a **negative** margin on a
pick that was in fact decisive. The ε denominator is not a safety net either — a
block template provably carries `H = 0` and `Q = 0` (no completion trail, and no
history row can share its signature), and in Habitual `N` and `C` carry weight
zero, so `S` collapses to the `F` term alone and an all-opposed `contextFit` puts
it at exactly 0. The clamp then manufactures a confident `1.0` out of a pool
where nothing scored at all.

What shipped measures the same lexicographic key the loop uses, with the
runner-up defined as the second-best under **that** key, in that slot's
**post-veto, post-`taken`** pool — never second-best-by-S:

| situation | margin | `marginBasis` |
|---|---|---|
| no runner-up — the winner was alone in the eligible pool | **0** | `uncontested` |
| the winner's `dot` is higher | `min(1, MARGIN_PER_DOT_STEP × Δdot)` | `dot` |
| `dot` tied, the winner's `S` is higher | `MARGIN_TIER_CAP × min(1, (S − S_r) / S)` | `score` |
| `dot` tied and `S` tied — or non-finite, or `S ≈ 0` | **0** | `tie` |

Both constants are `0.5` today, which is what makes the dot tier `{0.5, 1.0}` and
the score tier `(0, 0.5]` — read them from
`server/src/services/triality-confidence.ts`, not from this sentence.

The score tier is capped below the smallest dot credit on purpose: the two are
different kinds of certainty. A dot win means the winner matched a ternary pole
the runner-up did not; a score win means the triple did not discriminate at all
and the pick rode a tie-break. The ratio is relative rather than a gap over a
constant because `getWeights` validates each learned weight but never their
**sum**, so a restored `triality_weights` row can scale every `S` by up to 2× —
an absolute gap would scale with it and manufacture confidence.

Two consequences the doc should not have needed a build to learn:

- **An uncontested pick has margin `0`, not `1`.** Margin is a comparison
  quantity and no comparison happened; no data must never render as a confident
  number. It is also **not the same state as a tie**, which is why `marginBasis`
  ships beside the number — "nothing else was eligible" and "tied with another
  candidate, and the id order decided" are different sentences and earn different
  hedges. Reachable in practice, not in theory: `taken` consumes the earlier
  slots' winners, so a small pool empties.
- **Margin can never be negative on any input**, including a corrupt one. The
  reversed comparisons are unreachable by construction — the runner-up is the
  best of the rest under the same comparator — and fall through to `tie` rather
  than being subtracted.

### 4.2 What `coverage` and `evidence` do NOT claim

`coverage` keeps the formula and the `|meta.active|` denominator above; its
**claim** is narrower than the original line, and both narrowings ship as product
copy rather than as buried comments:

- **A sensed neutral is indistinguishable from an unsensed hole**, so this is not
  "how much of the blanket was sensed". `day_energy` 'flat', `free_gap` 15–45m,
  `momentum` 'no signal', `motivation_balance` in-band and an on-target
  `cat_deficit` are genuine readings encoded as `0`. v1 §3 chose a ternary with
  no third state and `contextFit` drops a zero pair from its denominator either
  way, so the distinction does not exist for *any* consumer — coverage inherits
  that honestly rather than manufacturing a distinction the encoder threw away.
  The bias is **downward**, the safe direction under a weakest link. The real fix
  is a `sensed` predicate beside `active` on `DimEntry`; that widens the registry
  contract and belongs to a later wave.
- **It is not "how much entered the score" either — but only `momentum` is sensed
  and scored by nothing.** `vector.dims` has exactly two consumers in the engine,
  `contextFit` and `capacityScore`'s energy factor, and reading that grep
  carelessly overstates the hole. `day_energy` feeds **C** as well as **F**, and
  `free_gap`'s *dim* is unread but its information reaches the pick as raw
  minutes via `rawFreeGapMinutes` → the hard capacity filter and C. So the gap is
  **one** dim of the twelve, disclosed in the tooltip — not three. Coverage can
  therefore move without any pick moving, which the copy says out loud.

`evidence` backs **`H` only, not `H` and `Q`.** It counts the rows
`historyMatches` matched — the one predicate `habitStrengths` itself uses,
evaluated in the same pass so both numbers provably describe the same rows — and
Q's transition counts are a different corpus that nothing here measures. It is
deliberately **unweighted**: H already prices recency, and weighting twice would
collapse the evidence for a habit done fifty times but paused a month. The lapse
belongs in the *score*, not in our *certainty about the score*. The raw count
ships uncapped beside the ratio, so a reader can see that 43 is not 8.

**The product rules are the point:**

- A **guess** renders with visible hedging, and the hedge names the *binding*
  component — the one that actually set the minimum — rather than a generic line.
  The marker sits on the pill itself, always visible, because hedging behind a
  tap is not hedging; the arithmetic it came from sits inline in the breakdown
  expansion beside F·H·Q·N·C, not behind a popover. `firm` gets **no** marker: a
  badge on every pill trains the eye to ignore all of them, and boasting about a
  model the calibration tile has not validated is the failure this wave exists to
  avoid.
- A slot whose best candidate is only a guess **may render empty instead** —
  **deferred to v2.5, and not shipped in v2.2.** An empty slot is information and
  a confident wrong answer is a lie, but suppression is the half of this that can
  hurt an owner, so it waits on evidence the bands mean anything (§13). Whether
  Novel is exempt (its whole job is the low-confidence probe) is still an owner
  question — §12.
- Confidence is aggregated on Balance → Metrics as **calibration**: do `firm`
  picks actually get taken more often than `tentative` ones? If they don't, the
  confidence model is wrong and the tile says so in those words. This is the
  honest counterpart to v1's acceptance-rate tiles, and its reader **collapses
  impressions before it counts anything** — a per-band rate over raw rows would
  reproduce the ~3× overcount this file's own history records, in the one metric
  whose purpose is detecting that the model lies.

**Prerequisite** *(met in v2.1)*: fix the `memory_context` active-but-blind bug
(§1), or `coverage` starts out overstated by exactly one dim.

## 5. Track C — the Companion Memory engine as the missing dims

**Yes — and this is the single biggest intelligence gain available**, because
memory can supply precisely the dims v1 had to reject as unsensable. It is also
where v2 is most likely to hurt itself, so the constraints come first.

### 5.1 The hard constraint learned in wave 5: no network I/O in the scoring path

Wave 5's review found an unbounded embedding ladder in `noveltyScores` — up to
60 sequential Ollama calls, each inheriting a 30-second timeout, on a request a
human was waiting for. Memory is a *network* dependency and would be strictly
worse. Therefore:

> **Memory dims are read from a cached snapshot, never fetched inline.** A new
> `memory_situation` cache row per owner (dims JSON + `computed_at` + a TTL) is
> written by a background pass and read **synchronously** by the vector builder.
> A stale or missing snapshot means every memory dim is `0` **and inactive** —
> the honest-zero rule, which also keeps `coverage` (§4) truthful.

The writer rides the existing Phase AA machinery (`memory_pull_enabled`,
`connectors/memory.ts`) — extend the `memory_suggest` job rather than adding a
second cron row, so the feature's job-count footprint stays at the one row
`calibrate_triality` already added.

### 5.2 What the graph actually offers (verified)

`connectors/memory.ts` exposes a typed entity/relationship graph:
`MemoryNode { id, entityType, name, description, properties }`,
`MemoryLink { source, target, relationshipType, strength, properties }`,
plus `graphData(owner, { from, to, includeTypes })` (date-filterable),
`graphSearch(owner, query, { limit })`, and `nodeStartTime(node)`. Link
**strength** is a number the graph already computes — v2 should consume it
rather than invent its own relevance score.

### 5.3 Four new dims, each with its honest-zero state

| Dim | Source | +1 | −1 | 0 |
|---|---|---|---|---|
| `memory_context` *(make real)* | `graphData({from: now, to: +48h})` — an upcoming event node related to the candidate | related commitment ahead | — | memory off, no relation, stale snapshot |
| `social_commitment` | person-type nodes linked to a near-term event | the candidate involves a person with a live commitment | — | no person data / no link |
| `place_affinity` | place-type nodes + the candidate's historical place association | today's place matches where this work happens | mismatch | **no place data at all — the common case** |
| `graph_corroboration` | aggregate `MemoryLink.strength` between the candidate and today's active subgraph | — | — | feeds **confidence** (§4), *not* `F` |

That last row is a deliberate separation: whether the graph *knows about* this
action is a statement about our certainty, not about the action's fit. Folding
corroboration into `F` would let a well-documented but badly-timed task
outrank a well-timed one.

### 5.4 Memory strengthens the motivation axis too

The graph knows *who* a task concerns. Today `motivation` is inferred from a
task's own text by a small model. A person-linked memory node is far stronger
evidence for `them`, and `motivation_source` already distinguishes machine from
owner testimony — so a memory-derived label lands as `llm` (machine) and the
owner's tap still wins permanently. No new precedence rule needed.

### 5.5 Privacy posture, stated explicitly

Memory is **read-only** here and gated by the existing per-owner
`memory_pull_enabled` (default off). No Triality data is pushed to the graph by
this track; `push_memory` remains the only outbound path and is unchanged. A
flag-off owner gets four honest zeros and four inactive dims — byte-identical
ranking to today.

## 6. Track D — sequence depth

`Q` becomes a small back-off model like §3.4, for the same reason:

```
Q = v₂·P(candidate | prev₂, prev₁)   # second-order chain
  + v₁·P(candidate | prev₁)          # today's first-order (unchanged fallback)
```

with the second-order term used **only** above its own sample floor, and a
time-band-conditioned variant `P(candidate | prev₁, band)` available where the
data supports it. Sequence data is the sparsest signal in the system, so every
level carries an independent floor and silently contributes nothing below it —
never a smoothed guess.

## 7. Track E — targeted feedback (why the prediction was wrong)

v1's blunt instrument: every dismissal is `−1`. But three very different things
hide behind one ✕:

| Reason chip | What it actually means | What it should teach |
|---|---|---|
| **Not now** | the pick was right, the moment wasn't | attribute to the *time/capacity* dim group; do **not** penalize fit |
| **Not relevant** | genuinely bad fit | attribute to the *fit* dim group (F, categories, motivation) — the current `−1` |
| **Already handled** | the task is stale, not mis-ranked | **teach the ranker nothing.** Flag a data-freshness check instead |

That third row is a v1 correctness flaw, not a nicety: pricing "I already did
this" as a ranking error teaches the model to avoid a *good* suggestion. In v2
it produces **no reward at all** and instead surfaces the real problem (a task
that should be closed).

This is also the sanctioned route to the **per-dim attribution v1 explicitly
punted on** (v1 §3b's learning caveat): reasons attribute to dim *groups*, not
individual dims, each with its own floor — bounded exactly like §6b's weights,
and equally resettable.

**UI cost:** the ✕ becomes a two-tap dismiss (✕ → three chips), which is real
friction on the app's most-used affordance. Mitigation: the bare ✕ still works
as an unattributed dismissal (today's behavior, `−1`), and the chips are an
optional refinement. Never force the taxonomy on someone who just wants the
banner gone.

## 8. Track F — synthesized candidates (still deferred, but now specified)

v1 rejected generated actions ("record a voice note *while walking*") because
generator ≠ evaluator. v2 keeps the deferral but names the conditions under
which it becomes safe:

- the LLM **proposes combinations only** from existing actions; the deterministic
  engine scores them with the same F/H/Q/N/C, so nothing enters the ranking that
  the arithmetic didn't rank;
- a synthesized candidate must clear a **higher bar** than a real one (it has no
  completion history, so `H = 0` and `evidence` is minimal — under §4 it would
  be a `guess` by construction);
- it may **never** fill Habitual (a synthesized action cannot be habitual — the
  slot's own definition forbids it), and it is always labeled as generated.

§4's reporting half shipped in v2.2, so the bar is now *measurable* — but nothing
yet *holds* it, because holding it means declining to fill a slot, and that is
v2.5's gating. This still stays last.

## 9. Doctrines that do not change

Carried forward from v1 verbatim; any v2 track that appears to need one relaxed
must be redesigned instead:

- **Ranking is deterministic and local.** No generative model chooses, writes,
  or re-orders a pick. (The one honest asterisk, unchanged: a local *embedding*
  model contributes half of `N` when Ollama is reachable, with a pure-arithmetic
  fallback — now bounded by a stage budget and a candidate cap.)
- **Honest zeros.** Every new dim states its no-data value, and no-data never
  masquerades as a measurement. `meta.active` must remain literally true — §4
  depends on it.
- **Bounded batch learning.** No online updates, no learning-rate knob, clamps
  and floors on every new attribution channel, all of it visible and resettable.
- **Suggest-only.** No writes to placements, ever.
- **Per-owner.** No cross-owner pooling of anything, including memory-derived
  statistics.
- **Flag-off is inert.** Every track lands dark behind `triality_enabled`, and
  the memory tracks additionally behind `memory_pull_enabled`.

## 10. Storage & flags

| Change | Shape |
|---|---|
| `memory_situation` (next-free migration) | per-owner cached memory dims: `owner_id` PK, `dims` JSON, `computed_at`, `source_mode`. Regenerable — deletable, like `triality_weights`. ⚠️ add to `resetDb`. |
| `triality_log.confidence` ✅ SHIPPED (`0144_triality_confidence`) | **ONE** nullable TEXT column, not two: the band, the three components, their raw counts and a model version `v`, as a single JSON blob. Stamped at show time so calibration (§4) is measurable retrospectively — and NULL therefore means "shown before v2.2", **permanently**: the vector is never persisted, so a backfill could only stamp today's reading on an old row. Readers exclude those rows; they are never coerced to `guess`. A separate `band` column would buy no read (the calibration reader must collapse impressions in JS before it counts anything, so SQLite never sees a `GROUP BY`) and cost a denormalization invariant. Deliberately **not** folded into the existing `scores` column, which would leave the learning corpus untouched only by accident. |
| `resetDb` | **NO CHANGE for 0144.** The ⚠️ above belongs to v2.4's `memory_situation` **table**; `confidence` is a *column* on `triality_log`, which `server/test/helpers.ts` already clears unconditionally. (`server/src/db/reset.ts` does not exist — the helper is the test one.) |
| index on `triality_log(owner_id, shown_at)` | **Deliberately deferred.** Both pre-existing readers already range-scan that pair against an index on `(owner_id, local_date)` and the calibration reader is a third — but that is a pre-existing, behavior-neutral, unmeasured cost unrelated to confidence, and a wave whose core promise is being provably minimal is not where it belongs. Its own migration when it is measured. |
| `triality_log.dismiss_reason` | new nullable column (`not_now` \| `not_relevant` \| `already_handled`), NULL = unattributed ✕ |
| `triality_weights` | unchanged shape; §7's attribution adds *rows* (dim-group channels), not columns |
| Flags | no new master flag. Sub-flags for the two riskiest tracks (`triality_confidence_gating`, `triality_memory_dims`) so they can be enabled independently of each other — the Phase Z per-channel precedent. **v2.2 added neither**: it ships entirely behind the existing `triality_enabled`, because reporting a number nothing acts on has no risk to gate. `triality_confidence_gating` arrives with the suppression it names, in v2.5 (§12 Q4). |

## 11. Test plan (per track, TDD as usual)

1. **Track A** — `defer_until` excluded (and a deferred task never appears);
   time-band pairing at match/mismatch/unknown; stated band beats histogram;
   back-off H: a rare signature with a frequent direction now scores > 0, and
   the interpolation weights shift with sample count.
2. **Track B** — coverage arithmetic on a hand-built vector; margin on a
   near-tie vs. a blowout; evidence floor; **weakest-link** combination proven
   (a decisive margin with zero coverage must NOT read as firm); band
   thresholds; a guess-only slot renders **hedged and still filled** — the empty
   variant is v2.5 — plus the `meta.active` truthfulness regression test. *(The
   plan under-specified one class: §4's guarantees are structural, so the
   one-way import graph, the module's purity and `attachConfidence` leaving its
   inputs alone each need a test of their own — none of them is a number.)*
3. **Track C** — every dim's honest-zero state (memory off, snapshot stale, no
   place data); **the scoring path performs zero network calls** (assert with a
   throwing connector stub — this is the wave-5 lesson as an executable test);
   stale TTL degrades rather than blocks; corroboration affects confidence and
   provably *not* `F` (byte-identical picks with corroboration varied).
4. **Track D** — second-order used above its floor, ignored below it, and
   identical results to v1 when sequence data is sparse.
5. **Track E** — each reason's attribution target; `already_handled` produces
   **no** reward and no weight movement; bare ✕ still behaves exactly as v1;
   per-dim-group floors and clamps hold under adversarial reason spam.
6. **Cross-cutting** — determinism (same DB + same `now` + same snapshot ⇒
   byte-identical picks, confidences, and weights); flag-off byte-identity;
   two-owner isolation on every new table.

## 12. Open questions for the owner

1. **Should a `guess` fill a slot at all, or render it empty?** *(v2.2 fills it,
   hedged — the question is live for v2.5's gating, not for what shipped.)* My
   recommendation: empty for Habitual and Contextual, hedged-but-shown for
   Novel — the Novel slot's job *is* the low-confidence probe (v1 §2b's
   epistemic action), so suppressing its guesses would remove the point of it.
2. **Is the two-tap dismissal worth the friction** (§7), or should reasons be
   offered only on the Balance tab as a retrospective "why did you skip these?"
   pass over the last week?
3. **Location via memory** (§5.3): worth building if the graph has place data
   for this owner, dead weight if not. Do you have place-typed nodes in practice?
4. **Confidence in the API contract** — ✅ **ANSWERED (v2.2, as built): additive
   on the existing `/next` payload, with no sub-flag.** A number nothing acts on
   cannot mis-serve an owner, and gating the *report* would have meant shipping a
   calibration tile with no corpus to fill it — the tile is the only thing that
   can falsify the bands. The sub-flag `triality_confidence_gating` (§10) arrives
   in **v2.5**, where it gates the *suppression*: the half that can be wrong in a
   way an owner notices.

**Escalated by the v2.2 build (2026-07-30), still open:**

1. **Does the `guess` marker say the word `GUESS`, or wear a muted glyph?** v2.2
   ships the word. By construction (§13) Novel picks and every block template
   read `guess` most days, so whichever is chosen is the label the banner wears
   most of the time.
2. **Should v2.5 gating be hard-blocked on `verdict === 'ordered' && !confounded`
   persisting across two windows**, or is a single window enough to switch
   suppression on?
3. **Is a permanent `guess` on every block template acceptable** — v2.2 bands
   them like anything else — or should a template render with no band at all
   rather than one it can never leave?

## 13. Wave plan

| Wave | Tracks | Why this order |
|---|---|---|
| **v2.1** ✅ SHIPPED (`5625329`) | §3.1 `defer_until` · §1's `memory_context` truthfulness fix | Two small correctness fixes with no new concepts; §3.1 is arguably a v1 backport and the truthfulness fix is a §4 prerequisite. Landed with the wave-5 stack merge (#438). |
| **v2.2** ✅ SHIPPED | §4 confidence (derive + report only, no gating) | Reporting first, gating second: the calibration tile must show the model is right before it is allowed to suppress a slot. Built as `services/triality-confidence.ts` + migration `0144`, carried on both `/next` surfaces and on the metrics payload as `calibration`. **A `guess` still fills its slot** — nothing was suppressed, reordered or filtered. |
| **v2.3** | §3.2/§3.3 time dims · §3.4 back-off H | The cheapest real sensing gains; both feed §4's coverage and evidence immediately. |
| **v2.4** | §5 memory dims + the snapshot cache | The biggest gain and the biggest risk; lands after the confidence machinery can report what the new dims did to coverage. |
| **v2.5** | §7 targeted feedback · §4 gating switched on | Attribution needs the reason column and a trustworthy confidence model. |
| **later** | §6 sequence depth · §8 synthesis | Sparsest data and highest complexity; genuinely optional. |

Every wave leaves `main` shippable and flag-off byte-identical, exactly as v1's
five waves did.

### Release gate on v2.5 — three conditions, two of them structural

v2.2 deliberately shipped the half that cannot hurt anyone. Switching gating on
in v2.5 removes suggestions the owner would otherwise have seen, so it is
allowed only when all three of these hold:

1. **An `inverted` calibration verdict is a hard block.** If lower-confidence
   picks are taken *more* often than higher-confidence ones by more than the
   minimum gap on any adjacent pair, the bands are not measuring what they claim
   and suppressing on them would delete the *better* suggestions. v2.5 should
   additionally require `verdict === 'ordered' && !confounded` to persist across
   **two** windows before it flips — one window can be a slot effect the
   acceptance tiles already show (whether two is the right number is an owner
   question, §12).
2. **Block templates need an explicit exemption.** `historyMatches` excludes
   `kind === 'template'` by construction — a saved block has no completion trail
   — so `evidenceRows` is `0` forever and the weakest link pins **every template
   pick to a permanent `guess`**. Gating without an exemption would silently
   delete templates from the Novel slot: no error, no log line, and a feature
   that just quietly stops offering saved blocks.
3. **Novel needs its own exemption.** Its axis veto selects the low-H tail, so
   the slot is **structurally** low-evidence. That is the slot doing its
   epistemic job (v1 §2b), not a defect.

Conditions 2 and 3 are **structural, not thresholds**: no retune of `FIRM_AT`,
`TENTATIVE_AT` or `EVIDENCE_FULL` reaches them, because the counts they depend on
are zero and low *by construction*. Whoever builds v2.5 must write both
exemptions explicitly, or discover them by watching the two slots empty.
