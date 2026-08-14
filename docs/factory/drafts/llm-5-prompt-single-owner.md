> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-prompt-single-owner` · **Commit style:** `fix(llm): every prompt rule has exactly one owner` · **Design:** this ticket is the spec · **Dependencies:** none. Independent of llm-2/3/4.

> **STATUS (2026-08-13): DONE, RE-SCOPED. Defect 1 shipped on `fix/llm-prompt-single-owner` (`270f824`). Owner chose option (b): defects 2 and 3 are split out into [`llm-9-rubric-consolidation-retune.md`](llm-9-rubric-consolidation-retune.md), which is explicitly licensed to change prompt text. `NEVER_INVENT` (defect 3) is recommended for permanent removal there — see the Correction below for why. This ticket is now scoped to the banned-word fix only and is ready to raise as an issue.**

## Correction — this ticket as first drafted was wrong

Three errors, found during implementation:

1. **Self-contradictory.** Non-goals demand byte-identical prompt strings; Pinned conventions
   demand replacing `subtasks.ts`'s wording with a differently-worded shared constant (the ticket
   itself calls the copy "reworded"). Both cannot hold. Defects 2 and 3 are therefore **retunes**,
   not de-duplication, and per `rubric.ts:15-17` a retune requires live re-measurement.
2. **`agents/memory-suggest.ts` does not contain a constrained-vocabulary clause.** Its only prompt
   instruction is `Respond ONLY with JSON in exactly this shape` — a format rule. The real count for
   defect 3 is **three** sites (`tags.ts:36-37`, `quickadd.ts:189`, `task-enrich.ts:196`), not the
   "five" the heading claimed. Three further `never invent` hits are UNRELATED rules that a naive
   sweep would wrongly capture: `plan.ts:514` (never invent/drop/merge tasks), `rubric.ts:101`
   (never invent a clock hour), `render-copy.ts:199` (never invent facts or numbers).
3. **The `COMPLEXITY_RUBRIC` consolidation has a functional hazard, not just a wording one.** The
   constant opens `Set isComplex true when…`, but the subtasks call's JSON schema has no
   `isComplex` field — it returns `isBreakdownUseful`. Composing it verbatim instructs a 3B model
   to set a field it is not being asked for, and `subtasks.ts:25-31` records that this model
   ignores instructions not backed by a schema field. That risks the measured refusal mechanism
   this ticket was told to preserve. A field-neutral split (`COMPLEXITY_DEFINITION` body, with each
   site supplying its own leading field sentence) is the shape that could work — and it still
   changes `subtasks.ts`'s text, so it is still a retune.

**Also measured during implementation, and load-bearing for every future prompt ticket:**
`llama3.2` at `temperature: 0.1` is **not deterministic**. Incidental fields drifted between two
*pre-change* runs of the same prompt (e.g. "Call the dentist" returned priority 1, then 3). Any
"byte-identical prompt ⇒ identical output" verification must therefore sample repeatedly and
compare only rubric-governed verdicts, not whole payloads.

## What shipped (defect 1 only)

`voice-gate.ts` gained `BANNED_PHRASES_PROMPT`, derived from `BANNED_PHRASES`; `VOICE_RULES`
interpolates it. `seamlessly` and `lets` are now disclosed to the model as well as enforced by the
gate. Three tests added, including the invariant `BANNED_PHRASES.every(p => VOICE_RULES.includes(p))`.
Verified live against `llama3.2:latest` with non-empty responses asserted (not eyeballed).

One disclosed side effect: the hard line-wrap *inside* the banned list is gone (two source lines
became one), unavoidable once the list is a derived comma-join. Content change is the two words.

## Goal

`server/src/agents/rubric.ts` exists so that "the quick-add classifier, the Auto-tag sweep, and
the memory enrichment pass cannot drift into three different definitions of the same word"
(`rubric.ts:10-13`). Three rules escaped it, and **two have already drifted.**

### 1. The banned-word list is duplicated, and the copies disagree — live bug

- `agents/voice-gate.ts:17-20` — `BANNED_PHRASES`, the list the deterministic gate **enforces**:
  `successfully, simply, just, unlock, leverage, seamless, seamlessly, empower, great job,
  keep it up, you've got this, let's, lets`
- `agents/render-copy.ts:196-198` — `VOICE_RULES`, the list the prompt **tells the model**:
  `successfully, simply, just, unlock, leverage, seamless, empower, "great job", "keep it up",
  "you've got this", "let's"`

`seamlessly` and `lets` are enforced but never disclosed. A model that writes "seamlessly" is
obeying the prompt it was given and is still rejected — costing a regeneration
(`MODEL_ATTEMPTS = 2`, `render-copy.ts:201`) and, when the retry also fails, pushing the surface
onto the template pool. Silent, and exactly the failure mode `rubric.ts` was written to stop.

### 2. `COMPLEXITY_RUBRIC` is restated inline in a second prompt

- `agents/rubric.ts:121-130` — the rubric, with its worked examples.
- `agents/subtasks.ts:34-39` — the same rule, reworded, with **the same examples**
  ("Plan a trip to Japan" → true; "Organize the team offsite" → true; "Call the dentist" → false).

Two prompts asking one question. `rubric.ts:120` even says the wording was measured against a
live model; the `subtasks.ts` copy carries its own separate measurement note (`:25-31`), so a
future retune of one silently diverges from the other.

### 3. "Choose only from the list — never invent" is written five ways

`agents/tags.ts:36-37`, `agents/quickadd.ts:189`, `services/task-enrich.ts:195-197`,
`agents/memory-suggest.ts` — same instruction, four phrasings, no shared string.

## Non-goals

- **Do not retune any rubric.** The only prompt-text change permitted is adding the two missing
  banned words to the model-facing list — a disclosure fix, not a wording change. Everything else
  is de-duplication: the string a model receives must be **byte-identical** afterwards, apart
  from that one addition.
- Do not change `gateCopy`, the repetition thresholds, or `MODEL_ATTEMPTS`.
- Do not move `rubric.ts`'s existing exports or change their text.
- Do not add a template engine. Plain string composition, the way `directionGuide()` already works.

## Pinned conventions

- `voice-gate.ts` remains the **owner** of `BANNED_PHRASES` — it is the enforcer, and the enforcer
  must be the source. Add there:
  ```ts
  /** The banned list as prompt text, so the model is told exactly what the gate enforces. */
  export const BANNED_PHRASES_PROMPT: string;
  ```
  derived from the array (quote the multi-word entries, comma-join). `VOICE_RULES` interpolates it.
  This direction is deliberate: generator ≠ evaluator (`voice-gate.ts:6-9`) means the gate cannot
  import from `render-copy.ts`, so the shared constant must live in the gate.
- `subtasks.ts` imports `COMPLEXITY_RUBRIC` from `rubric.ts` and composes it into the
  `isBreakdownUseful` sentence, keeping the boolean-gate framing that `subtasks.ts:25-31` measured.
  The `isBreakdownUseful` *mechanism* stays; only the duplicated definition-and-examples text is
  replaced by the shared constant.
- New shared constant in `rubric.ts`:
  ```ts
  /** The constrained-vocabulary clause every classifier prompt ends with. */
  export const NEVER_INVENT = 'Choose ONLY from the given lists — never invent a value.';
  ```
- Every prompt-text export in `rubric.ts` / `voice-gate.ts` keeps a comment noting that editing it
  is a behavior change requiring a live-model re-test (`rubric.ts:13-17`).

## Before implementation

1. `server/src/agents/rubric.ts` — the whole file; it is the model for this work.
2. `server/src/agents/voice-gate.ts:17-30` and `server/src/agents/render-copy.ts:192-225` — the two
   banned lists, side by side. Confirm the two-word gap still exists before writing the fix.
3. `server/src/agents/subtasks.ts:22-53` — confirm the boolean-gate framing is separable from the
   duplicated definition text.
4. `server/test/render-copy.test.ts` — how gate rejections are currently asserted.

## Files impacted

**Changed:**
- `server/src/agents/voice-gate.ts` — add `BANNED_PHRASES_PROMPT`
- `server/src/agents/render-copy.ts` — `VOICE_RULES` interpolates it (this is the bug fix)
- `server/src/agents/rubric.ts` — add `NEVER_INVENT`
- `server/src/agents/subtasks.ts` — import `COMPLEXITY_RUBRIC`; drop the inline restatement
- `server/src/agents/{tags,quickadd,memory-suggest}.ts`, `server/src/services/task-enrich.ts` — use `NEVER_INVENT`

**New:** none.

## Schema required

None.

## Definition of Done

- [ ] `BANNED_PHRASES_PROMPT` is derived from `BANNED_PHRASES`; no hand-typed word list remains in
      `render-copy.ts`.
- [ ] Adding a word to `BANNED_PHRASES` changes the prompt with no second edit.
- [ ] `grep -n "Plan a trip to Japan" server/src` returns exactly one hit (`rubric.ts`).
- [ ] `grep -rn "never invent" server/src --include="*.ts" -i` returns one definition + its uses.
- [ ] Every prompt string sent to a model is byte-identical to before, except `VOICE_RULES`, which
      gains `seamlessly` and `lets`. Diff the composed strings and paste them in the PR body.

## Tests

- [ ] New case in `server/test/render-copy.test.ts`: `BANNED_PHRASES.every(p => VOICE_RULES.includes(p))`
      — the invariant that makes this class of drift impossible to reintroduce.
- [ ] New case: a draft containing "seamlessly" is gate-rejected **and** the word appears in the
      prompt the draft was generated from.
- [ ] Snapshot the composed `subtasks.ts` prompt before and after; assert the complexity clause is
      the `COMPLEXITY_RUBRIC` text verbatim.
- [ ] `server/test/enrichment-rubric.test.ts` unchanged.

```
pnpm --filter server typecheck
pnpm --filter server test
```

⚠️ Per `rubric.ts:15-17`: before merging, run the quick-add classifier and one `render-copy`
surface against a **live** Ollama and confirm outputs are unchanged. Attach the two outputs to the
PR. A `thinking`-capable model returns an empty string under `format:"json"`, which reads exactly
like "no change" — check the model in use is not one.

## Acceptance Criteria

- [ ] Given a model writes "seamlessly", when the gate rejects it, then the regeneration prompt
      already listed that word — the model was not set up to fail.
- [ ] Given the owner retunes the complexity rule, then quick-add and the subtask suggester change
      together, because there is one string.

## Subtasks

1. [ ] Add `BANNED_PHRASES_PROMPT` + the `VOICE_RULES` interpolation; add the invariant test.
2. [ ] Add the "seamlessly" end-to-end case.
3. [ ] Import `COMPLEXITY_RUBRIC` into `subtasks.ts`; drop the restatement; snapshot-compare.
4. [ ] Add `NEVER_INVENT`; convert the four classifier prompts.
5. [ ] Diff every composed prompt string old-vs-new; paste into the PR body.
6. [ ] Live-model spot-check; attach outputs.
