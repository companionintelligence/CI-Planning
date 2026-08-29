> **Type:** Backend
> **Phase:** Close-loop wave — dismissed suggestions
> **Branch:** `feat/extract-dismissal-hint`
> **Commit style:** `feat(extract): let past dismissals inform extraction`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 4 (`dismissalHint` must exist)

## Goal

Close the loop. Thread the rendered hint from ticket 4 into the extraction prompt so past
dismissals actually change what gets proposed.

This is the only ticket in the wave that changes user-visible behaviour.

## Why this has to reach the prompt

The tempting cheaper apply is to lower `possible_tasks.confidence` for suggestions
resembling past dismissals. **That would do nothing.** Verified: `confidence` is written by
`agents/ingest.ts` and read by nothing — no threshold, no sort, no filter, server or client.
A suggestion with confidence 0.05 appears in the review queue exactly like one at 0.95.

Making `confidence` mean something is a real gap, but it is a different one. To affect what
the owner sees, the evidence has to reach the extractor.

## The JSON shape spec must stay terminal

`buildPrompt()` ends with the response-shape contract:

```
Extract actionable to-dos. Respond with JSON in exactly this shape:
{"tasks":[{"title":"...","priority":3,...}]}
If there are no actionable to-dos, respond with {"tasks":[]}.
```

The hint is injected **between the closing `"""` content fence and that shape spec**, so the
shape instruction remains the last thing the model reads. This is the load-bearing safety
property of the ticket: a diluted schema instruction yields well-formed prose instead of
parseable JSON, and the whole extraction silently degrades to `fallbackTask`.

## Non-goals

- **Do not give `extractTasks` an `ownerId`.** It takes a pre-rendered `hint` string. The
  agent stays free of DB imports and remains a pure prompt-builder, which is what makes it
  testable.
- **Do not inject inside the content fence.** The `"""` block is untrusted source text; the
  hint is not part of it.
- **Do not change `ExtractedTask`, `RawResult`, or `normalize()`.** The JSON contract is
  unchanged.
- **Do not filter, drop or re-rank extracted tasks.** The hint influences the model; the
  code must not post-filter on it. That would be suppression.
- **Do not touch `confidence` semantics** — no threshold, no sort, no decay. Out of scope.
- **Do not hint the seed script.** `seed-test-data.ts` stays hint-free so fixtures remain
  deterministic.
- **Do not retrieve more than once per item.** One `dismissalHint()` call immediately before
  `llmOrNull`, not per candidate task.
- **Do not break the no-Ollama path.** `llmOrNull` already degrades to `fallbackTask`; an
  empty hint must not change that.

## Pinned conventions

- **`buildPrompt(source: ExtractSource, hint = '')`** — default empty, so every existing
  caller is unchanged and `buildPrompt(source, '')` is byte-identical to `buildPrompt(source)`.
- **`extractTasks(source, opts)`** gains `hint?: string` in its existing options bag,
  alongside `tier` and `timeoutMs`. Preserve the conditional-spread idiom
  (`...(tier !== undefined ? { tier } : {})`) — omitting a key is what defers to
  `CALL_POLICY.extract`, and passing `undefined` explicitly is not the same thing.
- **Call site.** `runExtraction` in `server/src/agents/ingest.ts` (around line 400, at the
  `llmOrNull(\`extract:${source.kind}:${source.ref}\`, () => extractTasks(source, { tier }))`
  call). Resolve the hint with `currentOwnerId()` immediately before that call — one edit
  covers all three producers (gmail, gcal, text).
- **Debug line.** Extend the existing extraction debug log with `hinted: !!hint`, so ticket
  6's `hinted` column has a corroborating trace.
- **Test idiom for prompt capture.** The hoisted partial mock:
  `vi.mock('../src/mcp/ollama.js', async (importOriginal) => ({ ...(await importOriginal()), generateJson: vi.fn() }))`.
  It **must** spread the original — the LLM wave's llm-9 integration failure was exactly
  this: a wholesale mock left `llmOrNull` undefined at call time.

## Before implementation

Read `server/src/agents/extract.ts` in full (`SYSTEM` at line 32, `buildPrompt` at 43,
`extractTasks` at 104), the `runExtraction` call site in `server/src/agents/ingest.ts`, and
`classificationHint`'s consumer for how a hint is threaded elsewhere. Also read the llm-9
lesson in `docs/factory/drafts/README-llm-wave.md` before writing the prompt-capture test.

## Files impacted

**Changed:**
- `server/src/agents/extract.ts` — `buildPrompt` gains `hint`; `extractTasks` gains the opt
- `server/src/agents/ingest.ts` — resolve and pass the hint in `runExtraction`

**New:**
- `server/test/extract-hint.test.ts`

## Schema required

None.

## Definition of Done

- [ ] `buildPrompt(source, '')` is byte-identical to `buildPrompt(source)`
- [ ] A hinted prompt still ends with the `{"tasks":[]}` shape contract
- [ ] The hint appears outside the `"""` content fence
- [ ] `extractTasks` accepts `hint` without changing tier/timeout deferral
- [ ] `runExtraction` resolves the hint once per item, for all three source kinds
- [ ] The debug line reports `hinted`
- [ ] With no rollup, the prompt is unchanged from today's

## Tests

- [ ] `buildPrompt(source, '')` equals `buildPrompt(source)` exactly
- [ ] A hinted prompt contains the hint text
- [ ] The hint sits **before** the shape spec, and the prompt's last line is still the
      `{"tasks":[]}` instruction
- [ ] The hint is outside the `"""` fence (assert the fence's contents are unchanged)
- [ ] The hint reaches the real prompt through `runExtraction`, captured via the partial
      `generateJson` mock that preserves `llmOrNull`
- [ ] An owner with no exemplars produces today's prompt byte-for-byte
- [ ] A throwing hint resolver does not break extraction
- [ ] `normalize()` and the `ExtractedTask` shape are untouched

```bash
pnpm --filter server exec vitest run server/test/extract-hint.test.ts
pnpm --filter server exec vitest run server/test/extract.test.ts
pnpm --filter server exec vitest run server/test/ingest.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given an owner who has dismissed several similar suggestions, when ingest extracts
      from a similar email, then the prompt describes those past dismissals
- [ ] Given that same owner, when extraction returns, then the response still parses as
      `{"tasks":[...]}` and no task is dropped by code
- [ ] Given an owner with no evidence, then the prompt is identical to before this ticket
- [ ] Given no Ollama, then behaviour is unchanged (`fallbackTask` as today)

## Subtasks

1. [ ] Read `extract.ts` and the `runExtraction` call site
2. [ ] Add the `hint` parameter to `buildPrompt`, injected between the fence and the shape spec
3. [ ] Add `hint` to the `extractTasks` options bag, preserving conditional-spread
4. [ ] Resolve the hint in `runExtraction` via `currentOwnerId()` and pass it through
5. [ ] Extend the debug line with `hinted`
6. [ ] Write `extract-hint.test.ts`, using the partial mock idiom
7. [ ] Run the verification commands
