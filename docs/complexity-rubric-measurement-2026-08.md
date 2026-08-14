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

<!-- AFTER section appended in the implementation commit -->
