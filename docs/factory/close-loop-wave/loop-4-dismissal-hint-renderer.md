> **Type:** Backend
> **Phase:** Close-loop wave — dismissed suggestions
> **Branch:** `feat/dismissal-hint-renderer`
> **Commit style:** `feat(learning): retrieve and render bounded dismissal hints`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 3 (the rollup must exist and be populated)

## Goal

Add retrieval and rendering to `dismissal-learning.ts`: `retrieveDismissals()` picks at most
`RETRIEVE_K` exemplars similar to an input, and `dismissalHint()` renders them as a short
block of prose phrased strictly as history.

Nothing calls it yet — ticket 5 wires it in. Landing it alone keeps the security-sensitive
rendering reviewable on its own.

## The sanitiser is the point of this ticket

`classification-learning.ts` renders exemplars through
`oneLine = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 120)`. That is sufficient there
because the text is something **the owner typed**.

Here it is not. A dismissal exemplar is the extractor's rendering of **third-party inbound
email**, replayed into a later extraction prompt. That is an injection surface the template
does not have, and the extractor's contract is JSON, so a stray brace or quote in an
exemplar can corrupt the response shape rather than merely mislead it.

So this ticket's sanitiser is deliberately stricter than `oneLine`: strip `"`, `{` and `}`,
collapse whitespace, and cap shorter. Say so in a comment naming the asymmetry — a future
reader will otherwise "simplify" it back to `oneLine`.

## Non-goals

- **Do not wire it into extraction.** `buildPrompt` / `extractTasks` / `ingest.ts` are
  ticket 5. This ticket adds functions with no production caller.
- **Do not phrase hints as rules.** No "never suggest", no "ignore", no imperative. Past
  tense, describing what happened: *"you suggested X from an email like this; the user threw
  it away."* A rule is suppression wearing a prompt's clothes.
- **Do not exceed `RETRIEVE_K`.** Not configurable, not overridable by a caller beyond the
  existing `k` option, which must still clamp to `RETRIEVE_K`.
- **Do not read `possible_outcome_log`.** Retrieval reads the rollup only; the log is the
  batch's input, not the request path's.
- **Do not embed at request time beyond the single input text.** One embed call, gated and
  time-boxed; never a batch.
- **Do not throw, ever.** Every path returns `''` or `[]` on failure.
- **No route, no client change, no new job.**

## Pinned conventions

- **Gate.** `await ollama.embedReady()` before embedding. On false, fall back to the
  owner's `MAX_PRIORS` most frequent exemplars — no vectors needed. This mirrors
  `retrieveExemplars`.
- **Similarity.** `cosineSimilarity` / `unpackVector` from `server/src/lib/vector.js`, as
  `classification-learning.ts` uses them. Rows with `embedding IS NULL` are eligible for the
  priors path but not the similarity path.
- **Timeout.** `EMBED_TIMEOUT_MS` from ticket 3's constants.
- **Spacing.** The rendered block is self-spacing — a leading and trailing `\n`, exactly as
  `exemplarPrompt` returns. The caller concatenates without adding spacing of its own.
- **Empty by default.** No index, below the floor, no embedder *and* no priors, or any
  thrown error → `''`. An empty string must be safe to concatenate anywhere.
- **Signatures**, mirroring `classificationHint`:
  - `retrieveDismissals(ownerId: string, text: string, opts?: { embedFn?: EmbedFn; k?: number }): Promise<DismissalExemplar[]>`
  - `dismissalPrompt(exemplars: readonly DismissalExemplar[]): string`
  - `dismissalHint(ownerId: string, text: string, opts?): Promise<string>` — retrieve +
    render in one call, which is what the caller actually wants.

## Before implementation

Read `server/src/services/classification-learning.ts` lines 308–448 — `EmbedFn`,
`retrieveExemplars`, `exemplarPrompt`, `oneLine`, `classificationHint`. That block is the
shape to copy. Then `server/src/lib/vector.ts`.

## Files impacted

**Changed:**
- `server/src/services/dismissal-learning.ts` — add retrieval + rendering

**New:**
- `server/test/dismissal-hint.test.ts`

## Schema required

None.

## Definition of Done

- [ ] `retrieveDismissals`, `dismissalPrompt` and `dismissalHint` are exported
- [ ] At most `RETRIEVE_K` exemplars are ever returned or rendered
- [ ] The sanitiser strips `"`, `{`, `}` and collapses whitespace, with a comment naming why
      it is stricter than `oneLine`
- [ ] The rendered block is past-tense history, never an instruction
- [ ] The block is self-spacing (leading and trailing newline) and `''` when empty
- [ ] No path can throw

## Tests

- [ ] An owner with no index gets `''`
- [ ] An owner below the floor gets `''`
- [ ] At most `RETRIEVE_K` bullets are rendered, asserted against the exported constant
- [ ] A payload containing `{`, `}` and `"` is fully stripped from the rendered output
- [ ] A very long exemplar is truncated to the cap
- [ ] Owner isolation: owner B's exemplars never render for owner A
- [ ] `embedFn: null` falls back to priors and still renders
- [ ] A throwing `embedFn` yields `''` rather than propagating
- [ ] The rendered block starts and ends with `\n`

```bash
pnpm --filter server exec vitest run server/test/dismissal-hint.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner with a populated rollup, when a hint is requested for similar text,
      then at most `RETRIEVE_K` past dismissals are described in past tense
- [ ] Given an exemplar containing JSON-ish punctuation, when rendered, then no `{`, `}` or
      `"` survives
- [ ] Given any failure, when a hint is requested, then `''` is returned and nothing throws

## Subtasks

1. [ ] Read the template's retrieval block
2. [ ] Add `retrieveDismissals` with the `embedReady` gate and the priors fallback
3. [ ] Add the strict sanitiser, with the asymmetry comment
4. [ ] Add `dismissalPrompt` and `dismissalHint`
5. [ ] Write `dismissal-hint.test.ts` covering all nine cases
6. [ ] Run the verification commands
