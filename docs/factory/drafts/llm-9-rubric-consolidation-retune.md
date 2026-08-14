> **Type:** Refactor (measured retune) · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-rubric-consolidation` · **Commit style:** `refactor(llm): one owner for the complexity rubric` · **Design:** this ticket is the spec; supersedes defects 2 and 3 of `llm-5-prompt-single-owner.md` · **Dependencies:** llm-1 (landed, `9d5a91d`) and llm-5 (landed, `270f824`) — both touch these files.

> **STATUS: READY. Re-verified against `main` @ `a0f0b2e` on 2026-08-14 by READING each cited file. All anchors hold: `COMPLEXITY_RUBRIC` at `rubric.ts:121`, `COMPLEX_LEAD_VERBS` at `:142`, `titleSuggestsComplex` at `:158`; the inline restatement is still at `subtasks.ts:35-39` (`"Plan a trip to Japan"`, `"Pay a bill"`). Neither file is touched by the open PRs #529/#530, so this ticket is independent of both.**

## Why this ticket exists separately

llm-5 tried to do this under a "prompt strings must be byte-identical" constraint and **could not** — the
constraint and the goal are mutually exclusive, because consolidating two differently-worded copies
necessarily changes at least one of them. llm-5 shipped its one genuinely byte-neutral piece (the banned-word
disclosure fix) and this ticket takes the rest, **explicitly licensed to change prompt text**.

That licence carries an obligation. Per `agents/rubric.ts:13-17`, every string in that module is prompt text,
changing one changes model behaviour, and edits must be re-tested against a live model. So this is not a
refactor with a test suite attached — it is a **measurement exercise** whose deliverable is evidence.

## Goal

`COMPLEXITY_RUBRIC` is defined once in `agents/rubric.ts:121-130` and restated, reworded, in
`agents/subtasks.ts:34-39` — same rule, same worked examples, two sources of truth. Consolidate them
without regressing either caller's measured behaviour.

## The blocker llm-5 found — read this before designing

`COMPLEXITY_RUBRIC` opens with **"Set isComplex true when…"**. The subtasks call's JSON schema has no
`isComplex` field; it returns `isBreakdownUseful` (`agents/subtasks.ts:32-34`). Composing the constant in
verbatim would instruct a 3B model to set a field it is not being asked for — and `subtasks.ts:25-31`
records, from measurement, that this exact model **ignores instructions not backed by a schema field**. That
boolean-gate mechanism is load-bearing: it is what makes the model refuse to pad "Call the dentist" into
fake steps. Breaking it silently re-opens the failure the field was added to fix.

**Required shape: split the constant so the field name is the caller's, not the constant's.**

```ts
/** The complexity DEFINITION — deliberately field-neutral so each caller supplies its own
 *  leading sentence naming the field it actually asks for. Changing this text changes model
 *  behaviour at BOTH call sites; re-measure per the protocol in the ticket. */
export const COMPLEXITY_DEFINITION = 'finishing the task takes several distinct steps …';

/** Quick-add's field sentence + the shared definition. Byte-identical to the pre-split rubric. */
export const COMPLEXITY_RUBRIC = `Set isComplex true when ${COMPLEXITY_DEFINITION}`;
```
`subtasks.ts` then composes `isBreakdownUseful is true when ${COMPLEXITY_DEFINITION}`.

`COMPLEXITY_RUBRIC` must come out **byte-identical** to today — that half is still a pure refactor and is
cheap to assert. Only `subtasks.ts`'s composed prompt changes.

## Known text deltas the split must resolve

The two copies are not the same text. Decide each explicitly and record the decision:

| | `rubric.ts` | `subtasks.ts` |
|---|---|---|
| Verb-list sentence | present ("Verbs like plan, organise, launch, prepare, research, or build usually mean true.") | absent |
| "moving house" | present | absent |
| "anything spanning days or involving several people" | present | present |
| Examples | 5 | 4 |
| Last example | "Pay the electricity bill" → false | "Pay a bill" → false |

`subtasks.ts:29-31` records a residual false positive on **"Pay the electricity bill"** — it pads steps. The
richer `rubric.ts` example list names that exact string. Adopting the shared definition may therefore *fix* a
known defect. Measure it; do not assume it either way.

## Non-goals

- **Do not touch `NEVER_INVENT`.** llm-5's investigation found the idea is smaller and worse than drafted:
  there are three sites, not five (`tags.ts:36-37`, `quickadd.ts:189`, `task-enrich.ts:196`), no single string
  matches any of them, and substituting one **drops information** at each — which fields are constrained
  (quickadd), singular vs plural list (tags), and `[] when none fit` (task-enrich). Three further `never invent`
  hits are unrelated rules a naive sweep would wrongly capture: `plan.ts:514`, `rubric.ts:101`,
  `render-copy.ts:199`. **Recommendation: drop it permanently.** If the owner still wants it, it needs its own
  ticket with a per-site plan, not a sweep.
- Do not change `isBreakdownUseful`'s existence, its position in the schema, or the `isComplex` gate in
  `quickadd.ts` that decides whether the subtask call happens at all.
- Do not change tier, temperature, or timeout at either site (llm-1 landed; llm-2 owns those).
- Do not "improve" the rubric wording while you are in there. The only permitted delta is the one the
  consolidation forces.

## Measurement protocol — the actual deliverable

llm-5 measured that **`llama3.2` at `temperature: 0.1` is not deterministic**: incidental fields drifted between
two *pre-change* runs of an identical prompt ("Call the dentist" returned priority 1, then 3). A single
before/after pair therefore proves nothing.

- **N ≥ 5 runs per case, before and after.** Report the distribution, not one sample.
- **Compare only the rubric-governed verdict** (`isComplex` / `isBreakdownUseful` and the step list's
  shape), never the whole payload — incidental fields are noise at this temperature.
- **Assert responses are non-empty.** A `thinking`-capable model returns `""` under `format:"json"`
  (`lib/models.ts:26-46`), which reads exactly like "unchanged". The selected fast model must not advertise
  `thinking` — on the reference machine it resolves to `llama3.2:latest`, which does not.
- **Cases (minimum):** "Plan a week-long trip to Japan", "Organize the team offsite", "Research and launch
  the new pricing page", "Prepare the annual budget review", "Move house" → expect true. "Call the
  dentist", "Pay a bill", **"Pay the electricity bill"**, "Send the invoice" → expect false. The bolded one is
  the known residual defect; report whether it improves, regresses, or holds.
- A verdict flip in either direction is a **finding to report, not a failure to hide** — the owner decides
  whether an improvement is worth the churn.

## Before implementation

1. `agents/rubric.ts:112-163` — the rubric and its code twin `titleSuggestsComplex`. Note the comment at
   `:140-141`: every verb the RUBRIC names must also be in `COMPLEX_LEAD_VERBS`. If you change the verb
   sentence, that invariant is in scope.
2. `agents/subtasks.ts:22-53` — the whole function; the boolean-gate reasoning is in the comment.
3. `agents/quickadd.ts:136-141` — how `isComplex` is OR'd with `titleSuggestsComplex` and what gates the
   second call.
4. `docs/factory/drafts/llm-5-prompt-single-owner.md` — the "Correction" section; do not repeat its mistakes.

## Files impacted

**Changed:** `server/src/agents/rubric.ts`, `server/src/agents/subtasks.ts`, `server/test/enrichment-rubric.test.ts`
**New:** a measurement note under `docs/` recording the before/after distributions (the evidence outlives the PR)

## Schema required

None.

## Definition of Done

- [ ] `grep -n "Plan a trip to Japan" server/src` returns exactly one hit (`rubric.ts`).
- [ ] `COMPLEXITY_RUBRIC` composes byte-identical to its pre-split value (asserted in a test).
- [ ] `subtasks.ts` still asks for `isBreakdownUseful` and never mentions `isComplex`.
- [ ] N≥5 before/after distributions recorded for every case above, with non-emptiness asserted.
- [ ] Any verdict change is reported explicitly, with a recommendation.

## Tests

- [ ] `COMPLEXITY_RUBRIC === 'Set isComplex true when ' + COMPLEXITY_DEFINITION` and equals the literal
      pre-split string (pin the old text in the test file).
- [ ] `subtasks.ts`'s composed prompt contains `COMPLEXITY_DEFINITION` and does **not** contain `isComplex`.
- [ ] `enrichment-rubric.test.ts` passes with at most an import-path edit.

```
pnpm --filter server typecheck
pnpm --filter server test
```
Plus the live measurement run (requires Ollama; `llama3.2:latest` on the reference machine).

## Acceptance Criteria

- [ ] Given the owner retunes the complexity definition, then quick-add and the subtask suggester change
      together, because there is one string.
- [ ] Given "Call the dentist", then the subtask call still returns `[]` across N runs — the measured refusal
      mechanism survives.
- [ ] Given "Plan a week-long trip to Japan", then both callers still judge it complex across N runs.

## Subtasks

1. [ ] Capture the BEFORE distributions (N≥5 per case) on current `main`; commit the note.
2. [ ] Split `COMPLEXITY_DEFINITION` out; assert `COMPLEXITY_RUBRIC` is byte-identical.
3. [ ] Recompose `subtasks.ts`'s prompt; resolve each row of the delta table deliberately.
4. [ ] Re-check the `COMPLEX_LEAD_VERBS` invariant if the verb sentence moved.
5. [ ] Capture the AFTER distributions; diff verdicts only.
6. [ ] Write the measurement note; recommend keep / revert per case.
