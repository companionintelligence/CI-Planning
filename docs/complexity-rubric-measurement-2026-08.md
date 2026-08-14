# Complexity rubric consolidation — live measurement (ticket llm-9)

Evidence for `refactor(llm): one owner for the complexity rubric`. Recorded because
`agents/rubric.ts:12-17` makes every string in that module prompt text: changing one changes
model behaviour, so a consolidation that necessarily reworders one copy is a **retune** and has
to be measured, not reasoned about.

Reproduce with the committed harness (opt-in; it needs a live Ollama and takes ~45 s):

```
cd server
LIVE_RUBRIC=1 LIVE_RUBRIC_RUNS=5 LIVE_RUBRIC_OUT=../before.json \
  npx vitest run test/rubric-live-measure.test.ts
```

## Setup

| | |
|---|---|
| Ollama | `http://127.0.0.1:11434` |
| Fast tier resolves to | `llama3.2:latest` (3.2B, capabilities `completion,tools`) |
| `thinking` capability | **absent** — asserted in the harness, not assumed |
| Purposes exercised | `classify` (quick-add, temp 0.1) and `brainstorm` (subtasks, temp 0.3) — unchanged by this ticket |
| Runs per case | 5, before and after |
| Recorded | `isComplex` (quick-add), `isBreakdownUseful` and the returned step count (subtasks) — **verdicts only**; whole payloads are noise at this temperature |
| Non-emptiness | asserted on every raw completion before parsing (a `thinking` model answers `""` under `format:"json"`, which reads exactly like "unchanged") |

The harness wraps `generateJson` rather than re-typing the prompts, so what is measured is the
prompt each agent actually sends.

## BEFORE — `main` @ `a0f0b2e`, unmodified

`quickadd` = the model's `isComplex`; `subtasks` = the model's `isBreakdownUseful`; `steps` = the
list length `suggestSubtasks` finally returned.

| Case | expect | quickadd `isComplex` | subtasks `isBreakdownUseful` | steps |
|---|---|---|---|---|
| Plan a week-long trip to Japan | true | true ×5 | true ×5 | 6,6,6,5,5 |
| Organize the team offsite | true | true ×5 | true ×5 | 5,5,5,5,5 |
| Research and launch the new pricing page | true | true ×5 | true ×5 | 6,6,6,6,6 |
| Prepare the annual budget review | true | **false ×5** | true ×5 | 5,6,6,6,6 |
| Move house | true | false, true, true, true, true (**4/5**) | true ×5 | 6,6,6,6,6 |
| Call the dentist | false | false ×5 | false ×5 | 0,0,0,0,0 |
| Pay a bill | false | false ×5 | false ×5 | 0,0,0,0,0 |
| **Pay the electricity bill** | false | false ×5 | **true ×5** | 5,6,5,5,5 |
| Send the invoice | false | false ×5 | **true ×5** | 6,6,5,6,5 |

### What the baseline already tells us

- **The known residual defect reproduces exactly.** `subtasks.ts:29-31` records
  "Pay the electricity bill pads steps"; it does, 5/5, with 5–6 invented steps.
- **A second false positive was not previously recorded: "Send the invoice"**, true 5/5. Same
  shape — a single action the 4-example `subtasks.ts` list does not cover.
- **The quick-add misses are the ones the comments already name.** `Prepare the annual budget
  review` comes back `false` 5/5 and `Move house` 4/5 — which is exactly why
  `titleSuggestsComplex` exists and is OR'd in (`quickadd.ts` merge). The user-visible verdict at
  that site is therefore `true` for both regardless; the raw model column above is the un-rescued
  signal.
- **The refusal mechanism is solid at the low end.** "Call the dentist" and "Pay a bill" are
  `false` 5/5 and return `[]` — the boolean gate `subtasks.ts:25-31` describes is working.

## The change measured

`COMPLEXITY_DEFINITION` is the field-neutral body; `COMPLEXITY_RUBRIC` is
`` `Set isComplex true when ${COMPLEXITY_DEFINITION}` ``, and `subtasks.ts` composes
`` `isBreakdownUseful is true when ${COMPLEXITY_DEFINITION}` ``.

**Quick-add's prompt does not change at all** — proven byte-for-byte against the blob at
`a0f0b2e`, not asserted:

```
old @ a0f0b2e   bytes 618 sha256/16 a10f94ff52045994
new composed    bytes 618 sha256/16 a10f94ff52045994
test pinned lit bytes 618 sha256/16 a10f94ff52045994
```

So quick-add is a **control group**: any movement in its column is the temperature noise floor,
not the edit. The only prompt that changed is the subtask suggester's.

### How each known text delta was resolved

The two copies were never the same text. Every difference resolves the same way — the shared
definition wins, because the richer wording is the one that was measured and the leaner one was
an undocumented restatement:

| Delta | Was | Resolution |
|---|---|---|
| Verb-list sentence ("Verbs like plan, organise, launch…") | `rubric.ts` only | **Adopted** into the subtasks prompt. It is inside the shared body, and carving it back out would be a second wording, i.e. the drift this ticket removes. Puts the `COMPLEX_LEAD_VERBS` invariant in scope — see below. |
| "moving house" | `rubric.ts` only | **Adopted.** |
| "anything spanning days or involving several people" | `rubric.ts` only — **the ticket's table says "present, present"; it is not in `subtasks.ts` at all** | **Adopted.** The table row is wrong; the resolution is unaffected. |
| 5 worked examples vs 4 | `subtasks.ts` lacked `"Research and launch the pricing page" → true` | **Adopted** the 5. |
| Last false example | `"Pay the electricity bill"` vs `"Pay a bill"` | **Adopted `"Pay the electricity bill"`.** This is the one that mattered — see below. |
| Uncatalogued: "several distinct steps **that** a person" vs "several distinct steps a person"; "Set it false for anything done in one sitting: … a single chore" vs "It is false **only** for a single action done in one sitting — …" | wording drift | **Adopted** `rubric.ts`'s, wholesale. |

No wording was invented, softened or "improved" for this ticket. The delta is exactly the one
consolidation forces: `subtasks.ts` now receives `rubric.ts`'s text.

### `COMPLEX_LEAD_VERBS` invariant

`rubric.ts` requires every verb the prompt names to be in the code twin `COMPLEX_LEAD_VERBS`.
The verb sentence moved into `COMPLEXITY_DEFINITION`, so it now reaches **both** prompts — the
invariant got wider, not weaker. The named verbs (plan, organise, launch, prepare, research,
build) were already in the set, so nothing had to be added. It is no longer only a comment:
`test/enrichment-rubric.test.ts` parses the verb sentence out of the live string and asserts
`titleSuggestsComplex` fires for each.

## AFTER — same machine, same model, same session, N=5

`T`/`F` = the model's boolean; `steps` = what `suggestSubtasks` returned.

| Case | expect | quickadd B → A | subtasks B → A | steps B → A |
|---|---|---|---|---|
| Plan a week-long trip to Japan | true | TTTTT → TTTTT | TTTTT → TTTTT | 6,6,6,5,5 → 5,5,5,5,5 |
| Organize the team offsite | true | TTTTT → TTTTT | TTTTT → TTTTT | 5,5,5,5,5 → 5,5,5,5,5 |
| Research and launch the new pricing page | true | TTTTT → TTTTT | TTTTT → TTTTT | 6,6,6,6,6 → 6,6,6,5,5 |
| Prepare the annual budget review | true | FFFFF → FFFFF | TTTTT → TTTTT | 5,6,6,6,6 → 5,5,5,5,5 |
| Move house | true | FTTTT → TTTTT | TTTTT → TTTTT | 6,6,6,6,6 → 5,5,6,5,6 |
| Call the dentist | false | FFFFF → FFFFF | FFFFF → FFFFF | 0×5 → 0×5 |
| Pay a bill | false | FFFFF → FFFFF | FFFFF → FFFFF | 0×5 → 0×5 |
| **Pay the electricity bill** | false | FFFFF → FFFFF | **TTTTT → FFFFF** | **5,6,5,5,5 → 0×5** |
| Send the invoice | false | FFFFF → FFFFF | TTTTT → TTTTT | 6,6,5,6,5 → 5,5,5,5,6 |

### Findings

1. **The known defect is fixed. "Pay the electricity bill" flipped false, 5/5, and now returns
   no chips at all** (was 5–6 invented steps, 5/5). This was the residual false positive
   `subtasks.ts:29-31` recorded; the mechanism is exactly the one the ticket predicted — the
   4-example list did not name the string, the 5-example one names it verbatim.
   **Recommendation: KEEP.** This is the ticket paying for itself.

2. **No regression anywhere.** Every expect-true case stayed true 5/5 at both sites; both
   already-correct refusals ("Call the dentist", "Pay a bill") stayed false 5/5 and returned
   `[]`. The refusal mechanism the boolean gate exists for survives the retune intact.

3. **"Send the invoice" is an unfixed false positive, not a new one** — true 5/5 before and
   after, ~5 padded steps. It was never in the recorded defect list; the BEFORE run is where it
   surfaced. It is not reachable in practice: quick-add answers `isComplex: false` 5/5 and
   `titleSuggestsComplex('Send the invoice')` is false, so the gate means the subtask call never
   happens for it. **Recommendation: leave it.** Fixing it means adding a sixth worked example,
   which is a wording retune this ticket is not licensed to make — worth its own ticket only if
   the gate is ever loosened.

4. **The noise floor is real and it is in the control column.** Quick-add's prompt is
   byte-identical, yet "Move house" moved 4/5 → 5/5. That is `temperature: 0.1`
   nondeterminism, and it is the reason single before/after pairs prove nothing. Step *counts*
   drift by ±1 on almost every complex case for the same reason; only the boolean verdict and
   the empty/non-empty shape of the list are treated as signal here.

5. **Quick-add's raw `isComplex` still misses "Prepare the annual budget review" 5/5** —
   unchanged, and unchanged is the whole point, since that prompt did not change. The user-visible
   verdict is still `true` because `titleSuggestsComplex` is OR'd in. Recorded so the next reader
   does not mistake the code twin's rescue for the model getting it right.

## What would invalidate this

Different hardware, a different Ollama build, or a fast tier that resolves to something other
than `llama3.2:latest` (a Settings override or an `OLLAMA_FAST` pin bypasses auto-selection).
Re-run the harness rather than trusting the table.

