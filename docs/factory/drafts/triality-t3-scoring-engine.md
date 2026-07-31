# [Factory] Triality T3 — deterministic scoring engine (candidates → scores → slots)

> **Type:** Backend (service) · **Phase:** Triality Wave 2 · **Branch:** `feat/triality-engine` · **Commit style:** `feat(triality): deterministic scoring engine + slot assignment` · **Design:** `docs/triality-design.md` §1, §4, §5 · **Dependencies:** T1 (table), T2 (vector)

## Goal

`server/src/services/triality.ts`: the whole §4–§5 pipeline as one pure, owner-scoped
service — candidate collection, hard capacity filter, component scores F/H/Q/N/C,
ternary triple + target dot-products, greedy exclusive slot assignment
(**Habitual → Contextual → Novel**), the <10-reflected-completions refusal floor,
and the `triality_log` insert/outcome helpers T4/T5 will call.

## Non-goals

No routes, no GraphQL, no UI, no LLM (the rationale garnish is T7 and lives outside
this service), no weight tuning, no synthesized candidates (v2), no writes to any
table except `triality_log` via the exported helpers.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Weights/targets are **named constants**, canonical vocabulary:
  `S_habitual = 0.40F+0.40H+0.20Q` · `S_contextual = 0.50F+0.20H+0.30N` ·
  `S_novel = 0.35F+0.15H+0.30N+0.20C`; targets `t_hab=[+1,+1,+1]`,
  `t_ctx=[0,+1,+1]`, `t_nov=[−1,+1,+1]` over [normality, pragmatism, capacity]
  (design §5 thresholds). Not prefs, not env.
- **Weights flow through ONE seam:** `getWeights(owner, slot)` — in this ticket it
  returns the default constants unconditionally, but every scoring call must go
  through it. T8 (learning, design §6b) later teaches the seam to read
  `triality_weights`; the engine itself must not change again for that. Add a test
  pinning that scoring consumes injected weights (pass a stub through opts).
- Action templates carry the §3b motivation dim: candidate's `tasks.motivation`
  encoded me=+1 / us=0 / them=−1 / NULL=0 (blocks via linked-task inheritance) —
  enters F against T2's `motivation_balance` dim like any other paired dim.
- Candidate sources (§4): open tasks (excl. blocked via `task_dependencies`),
  open-today routines (`patterns` + checklist state), `flight_plan` rows,
  `block_templates`. Action categories via `entity_categories` with the
  block→linked-task inheritance rule (pin the existing effective-categories read —
  it lives in `services/blocks.ts`; reuse, don't re-derive).
- **H/Q windows:** 90d, half-life 14d, signature = (kind, direction, category-set) —
  computed by scan over `tasks.completed_at` / `time_entries`; no new tables.
- **N:** `1 − H_class`, blended 50/50 with embedding-centroid cosine distance *only
  when embeddings are reachable*. Thread an injectable `embedFn` exactly like
  `services/possibles.ts:183–189` (`opts.embedFn`) — deterministic tests, graceful
  skip when `ollama.embed` (`mcp/ollama.ts:130`) is down.
- **C + capacity filter:** estimate = `estimated_minutes`, falling back to the AA3b
  memory default (`agents/memory-suggest.ts` — reuse its exported helper, verify
  name at build); free gap from the T2 vector's source; §5 margin/energy rules.
- Refusal floor: <10 completions that are ritual-confirmed (`completion_mood` or
  `reaction_at` set) **or** timer-confirmed (`time_entries` row) in the 90d window
  → return a typed `{refused: 'sparse_history', have, need}` — never a ranked list.
- Injectable `now` threaded through to T2's builder; stable tie-break: slot `S_*`
  desc, then id asc (bit-for-bit reproducibility is a DoD item, not a nicety).

## Before implementation

Read: T2's exported types; `services/possibles.ts` embedFn threading;
`services/blocks.ts` effective-categories; `agents/memory-suggest.ts` estimate
fallback; design §5 in full.

## Files impacted

- **New:** `server/src/services/triality.ts`, `server/test/triality-engine.test.ts`
- **Changed:** none (T1 created the table; T2 the vector)

## Schema required

None (writes `triality_log` via helpers: `logShown(picks) → log ids`,
`stampOutcome(logId, outcome)` — outcome ∈ opened/staged/dismissed, append-only,
`outcome_at` stamped once; a second stamp is a no-op returning `changed:false`).

## Definition of Done

- [ ] `trialityNext(ownerId, now, opts?) → { picks: [{slot, kind, ref, title,
      scores:{F,H,Q,N,C,total}, ternary, logId?}], vector } | { refused }` —
      three *distinct* actions, empty slot rendered as `null` with `reason`
- [ ] Capacity filter runs before any scoring (pipeline order is normative, §1)
- [ ] All arithmetic deterministic; no wall-clock, no Math.random, no LLM
- [ ] Log helpers exported and used by nothing yet (T4/T5 wire them)

## Tests (fixture DB per case, `TZ=UTC`, fixed `now`, injected `embedFn`)

- [ ] determinism: same DB + `now` twice → identical picks incl. score floats
- [ ] capacity filter: oversized-for-gap and dependency-blocked candidates never scored
- [ ] H recency weighting: yesterday's completion outweighs day-80's
- [ ] Q: seeded A→B transition history ranks B's Q above C's after completing A
- [ ] N fallback: no `embedFn` → categorical-only novelty, no throw
- [ ] slot exclusivity: a candidate topping all three rankings appears once
      (Habitual), and the next-best fill the others
- [ ] deficit pull (§6): seeded under-served category flips the Contextual pick;
      Habitual pick unchanged (deficit-blind)
- [ ] refusal floor: 9 confirmed completions → refused; the 10th flips it
- [ ] empty-slot honesty: candidate pool of 2 → third slot null with reason
- [ ] log helpers: shown rows appended with full scores JSON; double `stampOutcome`
      no-ops; rows never updated otherwise

Verify: `pnpm --filter server test` · `pnpm typecheck`.

## Acceptance Criteria

Running the engine on the seeded demo DB (`pnpm seed`) with the flag on returns
three plausible, distinct, explainable picks in <50ms; every §5 sentence maps to
a test.

## Subtasks

1. Candidate collectors + capacity filter
2. F/H/Q/N/C + action templates
3. Ternary triple + targets + greedy assignment + refusal
4. Log helpers
5. Test battery above
