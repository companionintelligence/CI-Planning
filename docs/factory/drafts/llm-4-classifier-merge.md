> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-classifier-merge` · **Commit style:** `refactor(llm): one constrained-vocabulary merge for every classifier` · **Design:** this ticket is the spec · **Dependencies:** llm-1 (tier vocabulary). Independent of llm-3 and llm-5.

> **STATUS: DRAFT — pending owner approval of the breakdown. Do not create as an issue yet.**

## Goal

Five classifiers apply the same rule — *"take the model's answer, keep only names that exist in
the owner's vocabulary, canonical casing from the vocabulary, dedupe, cap"* — and every one of
them implements it separately. The rule is stated five times in comments as if it were shared
("the same never-invent rule as every other classifier here",
`services/task-enrich.ts:217-218`), but no code is.

### The duplication, verified

| Concern | Copy A | Copy B |
|---|---|---|
| `EnrichOut` result interface | `agents/quickadd.ts:46-56` | `services/task-enrich.ts:130-135` |
| Category constraining | inline in `mergeEnrichment`, `agents/quickadd.ts:108-123` | `constrainCategories`, `services/task-enrich.ts:57-72` |
| Direction canonicalization | `dirByLower` map, `agents/quickadd.ts:77-85` | `directions.find(…toLowerCase())`, `services/task-enrich.ts:219-221` |
| Tag allow-listing | `otherByLower` map + cap 2, `agents/quickadd.ts:88-101` | `new Set(vocabulary)` filter, `agents/tags.ts:41-44` |

`constrainCategories` and the `quickadd` category block are the same function written twice —
same cap of 3, same lowercase map, same dedupe, same drop-unknown — and they even differ subtly:
`task-enrich` dedupes on the canonical name, `quickadd` dedupes on `canonical.toLowerCase()`.
Equivalent today only because canonical names are unique case-insensitively.

Separately, two cosine implementations sit in the embedding path with names that do not say what
they return:

- `agents/groom.ts:85-95` — `cosine(a,b)`, plain cosine **similarity**, `||1` guard on a zero norm.
- `services/triality.ts:673-680` — `cosineDistance(a,b)`, cosine **distance**, then squashed
  (`/2 + 0.25`) and clamped so it never saturates. Zero norm ⇒ `1`.

Neither name mentions that the second is squashed, and a reader who assumes `1 - cosine()` gets
the wrong answer.

## Non-goals

- **Do not change any classifier's output.** Same picks, same caps, same order, same drops. The
  merge functions have direct unit tests (`enrichment-rubric.test.ts`, `quickadd.test.ts`) and
  those tests must pass **unedited**.
- **Do not unify the two cosine functions into one.** They compute genuinely different quantities
  for different purposes. Rename and document them so the difference is legible; do not make
  triality's novelty score depend on groom's dedupe function or vice versa.
- Do not change `suggestibleVocabulary` (`services/tags.ts:356`) — it is already the single
  vocabulary source and four call sites already use it correctly.
- Do not touch prompt text — that is llm-5.
- Do not merge `QuickVocab` (`agents/quickadd.ts:35-44`) into `TagVocabulary`; the routes already
  pass one straight through as the other (`routes/tasks.ts:165-168`). Note it in the PR body as
  a follow-up if the shapes turn out identical.

## Pinned conventions

- New module `server/src/agents/constrain.ts` — sits with `rubric.ts`, the existing "one source of
  truth for the classifier layer" module, and follows its file-header style (state the rule, state
  why it is centralized, state that changing it changes model-facing behavior).
- Exported surface, exactly:
  ```ts
  /** Canonical names from `vocabulary` that the model actually picked. Unknown names
   *  dropped, casing from the vocabulary, deduped case-insensitively, capped at `max`. */
  export function constrainToVocabulary(raw: unknown, vocabulary: string[], max: number): string[];

  /** The single vocabulary name the model picked, canonical-cased, or null. */
  export function constrainOne(raw: unknown, vocabulary: string[]): string | null;
  ```
- Dedupe key is `toLowerCase()` everywhere (quickadd's rule; strictly the safer of the two).
- `constrainCategories` in `task-enrich.ts` is **deleted**, not wrapped — it is exported only for
  its own unit test, and that test moves to the new module's test file.
- Cosine renames: `groom.cosine` → `cosineSimilarity`; `triality.cosineDistance` →
  `squashedCosineDistance`, each with a one-line comment giving its range and its zero-norm
  behavior. Both stay private to their modules.

## Before implementation

1. `server/src/agents/rubric.ts` — the file this one is modeled on.
2. `agents/quickadd.ts:65-159` (`mergeEnrichment`) and `services/task-enrich.ts:57-72, 205-250` —
   the two merges, side by side.
3. `server/test/enrichment-rubric.test.ts` and `server/test/quickadd.test.ts` — the contracts that
   must not move.
4. `agents/groom.ts:150-245` and `services/triality.ts:660-700` — confirm the two cosines are
   genuinely different before renaming rather than merging.

## Files impacted

**New:**
- `server/src/agents/constrain.ts`
- `server/test/constrain.test.ts` (absorbs the `constrainCategories` cases)

**Changed:**
- `server/src/agents/quickadd.ts` — `mergeEnrichment` calls the shared helpers; local `EnrichOut` replaced by the shared type
- `server/src/services/task-enrich.ts` — delete `constrainCategories` and the local `EnrichOut`; use the shared helpers for direction + categories
- `server/src/agents/tags.ts` — allow-list via `constrainToVocabulary`
- `server/src/agents/memory-suggest.ts` — if its answer-constraining duplicates the rule, route it through too; if it does not, say so in the PR body
- `server/src/agents/groom.ts`, `server/src/services/triality.ts` — cosine renames + comments
- `server/test/enrichment-rubric.test.ts` — import path only, **no assertion edits**

## Schema required

None.

## Definition of Done

- [ ] `grep -rn "toLowerCase()" server/src/agents/quickadd.ts server/src/services/task-enrich.ts`
      shows no hand-rolled vocabulary map left in either file.
- [ ] `constrainCategories` no longer exists.
- [ ] Exactly one `EnrichOut` type in the repo.
- [ ] `cosine` and `cosineDistance` are gone; the two replacements each document range + zero-norm.
- [ ] `enrichment-rubric.test.ts` and `quickadd.test.ts` pass with **zero assertion changes**.

## Tests

- [ ] `constrain.test.ts`: unknown names dropped; canonical casing wins over the model's casing;
      duplicates collapsed case-insensitively; `max` respected; non-array / non-string input ⇒ `[]`;
      empty vocabulary ⇒ `[]`.
- [ ] `constrainOne`: exact match, case-insensitive match, unknown ⇒ `null`, non-string ⇒ `null`.
- [ ] Regression: a model answer of `["Finance","finance","FINANCE","made-up"]` against
      `["Finance"]` yields `["Finance"]` — the case-dedupe difference between the two old copies.
- [ ] Existing `enrichment-rubric.test.ts`, `quickadd.test.ts`, `tag-tasks-job.test.ts` unchanged.

```
pnpm --filter server typecheck
pnpm --filter server test
```

## Acceptance Criteria

- [ ] Given the same model answer and vocabulary, quick-add enrichment and memory enrichment now
      produce identical category picks (today they can differ only in a pathological casing case —
      after this they cannot differ at all).
- [ ] Given a reader asking "what stops the model inventing a tag", then there is one function to
      read.

## Subtasks

1. [ ] Write `constrain.ts` + `constrain.test.ts` (tests first, from the union of both old copies).
2. [ ] Convert `task-enrich.ts`; delete `constrainCategories`; move its cases.
3. [ ] Convert `quickadd.ts`'s `mergeEnrichment`; share the `EnrichOut` type.
4. [ ] Convert `tags.ts`; check `memory-suggest.ts` and convert or document.
5. [ ] Rename both cosine functions with range/zero-norm comments.
6. [ ] Confirm `enrichment-rubric.test.ts` passes with only an import-path edit.
