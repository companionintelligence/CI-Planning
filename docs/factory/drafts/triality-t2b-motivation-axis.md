# [Factory] Triality T2b — motivation axis (me/us/them): schema, LLM-first tagging, wizard override

> **Type:** Backend + Frontend · **Phase:** Triality Wave 1 · **Branch:** `feat/motivation-axis` · **Commit style:** `feat(tasks): motivation me/us/them, LLM-first tagging` · **Design:** `docs/triality-design.md` §3b (owner-locked 2026-07-29; vocabulary + LLM-first locked same day) · **Dependencies:** none (parallel with T1/T2; T2's `motivation_balance` dim and T3's template dim consume it, so land before wave 2 closes)

## Goal

Every task can carry a **motivation** — who the work is for: `me` (the owner's
legacy) · `us` (shared benefit) · `them` (other people). **The local LLM tags
first** on creation and during enrichment; the wizard control overrides
permanently; NULL means unlabeled and is never conflated with `us` (the §3b
0-overload resolution is this ticket's core correctness rule).

## Non-goals

No Triality consumption (T2/T3 read it; this writes it). No backfill of existing
tasks by default (they get tagged lazily as the enrichment pass visits them —
no bulk re-tag job). No motivation on patterns/objectives (v2). No metrics or
visuals (T7). No Tasks-view filter/sort by motivation (unscoped). No cloud
model — Ollama only, deterministic fallback (local-first invariant).

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Columns: `tasks.motivation` TEXT nullable (`'me'|'us'|'them'`, enforced in
  code, **no CHECK constraint**) + `tasks.motivation_source` TEXT nullable
  (`'user'|'llm'`). Migration = next-free slot, addColumn-if-missing idiom
  (0137 model). Source is NULL exactly when motivation is NULL.
- **LLM-first tagging:** classification via `ollama.generateJson`
  (`mcp/ollama.ts:249` exports it) on the small model, one-of-three-or-null
  constrained shape. 3B prompt gotchas (HANDOFF-2026-07-27): output-shape
  instruction FIRST; no trailing rules; no refusal-clause reliance. Qualifiers
  live in `rubric.ts` (ONE source of classifier qualifiers — extend there).
- **Unsure ⇒ NULL, never `us`** — `us` is a positive claim of shared benefit,
  not a shrug. Deterministic fallback when Ollama is down: conservative keyword
  pass (clear `them` signals: "for mom", "volunteer", "help X"; clear
  first-person-goal `me` signals; else NULL). Never guess `us` in the fallback.
- Tagging call sites: task creation paths (create route + quick-add) and
  `services/task-enrich.ts` (add motivation to its fillable set — fills blanks
  only). A row with `motivation_source='user'` is **never re-tagged** by any
  path; that's the contract, and a test.
- Wizard: 3-way segmented control in `ElementWizard.tsx` near the categories
  picker; shows the LLM's tag when present (visually marked as suggested);
  a user tap writes the value with `motivation_source='user'`; clearing back
  to unset writes NULL/NULL.
- Blocks: NO own column — effective motivation = linked task's
  (`services/blocks.ts` effective-read precedent).
- API: `POST/PATCH /api/tasks` accept `motivation` (user writes stamp
  `source='user'`); 422 outside `me|us|them|null`; serializer exposes both
  columns (snake_case). GraphQL: nullable enums `Motivation { ME US THEM }`,
  `MotivationSource { USER LLM }` (W enum-mapping convention).

## Before implementation

Read: §3b in full (NULL-vs-`us`, LLM-first guardrails); `mcp/ollama.ts`
`generateJson`; `rubric.ts`; `task-enrich.ts` fill-blanks contract; the 0137
migration; ElementWizard categories picker; one W enum mapping.

## Files impacted

- **New:** `server/src/db/migrations/<next-free>_task_motivation.ts`
- **Changed:** `server/src/db/migrations/index.ts`, `server/src/db/schema.ts`,
  `server/src/routes/tasks.ts`, `server/src/lib/serialize.ts`,
  `server/src/services/task-enrich.ts`, `server/src/services/rubric.ts`,
  `server/src/graphql/task.graphql` + resolvers, `client/src/lib/api.ts`,
  `client/src/components/ElementWizard.tsx` (+ the quick-add parse module —
  pin its real path at build)

## Schema required

`tasks.motivation` TEXT NULL · `tasks.motivation_source` TEXT NULL. No index
(low-cardinality; metrics window on dates first).

## Definition of Done

- [ ] Create via quick-add with Ollama up → LLM tag lands with `source='llm'`;
      Ollama down → conservative fallback or NULL; never `us` from a guess
- [ ] Wizard shows the LLM suggestion as suggested, override sticks
      (`source='user'`), and no later pass re-tags it
- [ ] Enrichment fills NULL-motivation tasks it visits; skips user-labeled ones
- [ ] Block's effective motivation mirrors its linked task
- [ ] REST validation matrix + GraphQL enums agree; NULL ≠ `us` end-to-end

## Tests

- [ ] migration idempotency; NULL defaults on existing rows
- [ ] LLM path with injected fake `generateJson` (the `embedFn`-style threading
      idiom, `possibles.ts:183`): valid tag stored with source llm; model
      returns junk/refusal → NULL, no throw
- [ ] fallback matrix: clear-`them`, clear-`me`, ambiguous→NULL, never-`us`
- [ ] user-override contract: set via wizard → enrich pass runs → value and
      source unchanged
- [ ] **NULL ≠ us** through serializer, effective-read, and GraphQL
- [ ] route validation (me/us/them/null/junk); user write stamps source
- [ ] client: wizard renders suggested-vs-user states + 4-way control

Verify: `pnpm --filter server test` · `pnpm --filter client test` · both typechecks.

## Acceptance Criteria

A freshly quick-added "study for the exam so mom stops worrying" arrives already
tagged `them` by the local model, the owner can flip it to `us` in one tap and
that answer is final, and nothing anywhere confuses "shared" with "never asked".

## Subtasks

1. Migration + schema + serializer + route validation + source stamping
2. LLM classifier (generateJson + rubric qualifiers) + deterministic fallback
3. Call-site wiring (create, quick-add, enrichment) + never-re-tag guard
4. Wizard control (suggested vs user states) + GraphQL enums
5. Test battery above
