# Quick add on the small models: making the category pick usable (2 Nov 2026)

Follow-up to the classification hint measurement (PR #652, merged as `96009f91`; its write-up is
`docs/classification-hint-measurement-2026-11.md` on that commit, section "Answer shape", and on the
local branch `park/classification-hint-half`). That measurement found that the built-in fast model,
`qwen2.5:0.5b`, answers `"categories": "leisure"` (a bare string) where quick add kept only arrays, so a
default install got no category pick, no `classification_claim`, nothing to correct and nothing to
learn from. It named two remedies and did neither. This document measures them and records which one
ships and why.

## Result in brief

- **Ship the tolerant parse (b), not a reworded prompt (a).** That is what the rule registered before
  the first run reads off the calls. `mergeEnrichment` now reads a bare string for `categories` as one
  whole name (`categoryAnswer` in `server/src/agents/quickadd.ts`). The prompt is unchanged, byte for
  byte, for every owner.
- **The share of completions that name one of the owner's categories** (Y; 42 titles x 5 runs = 210
  completions per model) went from **0.0% to 80.0% on `qwen2.5:0.5b`** and from **21.4% to 91.0% on
  `gemma3:1b`**. `gemma3n:e4b` was already at 100.0%, and no title's modal first pick changed
  (A against A2, its own noise floor, moved none either).
- **On the real routes** (the wizard's path, 18 training titles, before and after): claims echoed 0 to 16
  of 18 on `qwen2.5:0.5b` and 3 to 15 on `gemma3:1b`; corrections written 0 to 10 and 3 to 15;
  `gemma3n:e4b` identical (18 claims, 18 corrections, 14 indexed, before and after). The Monday
  `calibrate_classification` run now has something to index on the default tier: 8 of 10 corrections
  indexed on `qwen2.5:0.5b`, against none.
- **Usable is not good.** On the 12 titles whose natural category is not in doubt, `qwen2.5:0.5b`
  named it on 20 of 60 completions (it said `leisure` for 126 of 210, 60%, whatever the title),
  `gemma3:1b` on 49 of 60, `gemma3n:e4b` on 60 of 60. So on the default model most of what the Add
  dialog is now pre-filled with will be wrong and need the owner's correction. That is the material the
  loop learns from, and it is also a visible change on a default install: an empty category picker
  becomes a mostly-wrong one. 42 of the 210 `qwen2.5:0.5b` answers still name no category after the fix
  (`"life areas"` 16 times, which is the prompt's own words, `"work"` 10, a direction, and a few
  made-up areas), and 19 of `gemma3:1b`'s 165 bare strings are `"work"`.
- **Rewording the prompt (a) failed its schema gate on `gemma3:1b`** and cost it keys: all nine on 93.3% of
  calls with today's prompt, 57.1% with W1 and 70.5% with W2. Both wordings did make both small models
  answer arrays (Y 94.3% and 64.3% on `qwen2.5:0.5b`, 81.0% and 90.5% on `gemma3:1b`), and on
  `qwen2.5:0.5b` W1 moved the answer from `leisure` to `career` for 119 of 210 calls without making it
  right more often (12 of 60 obvious titles). The parse changes nothing the model is shown.
- **The hint experiment's G1 to G6 were not re-run,** and the reasons are in
  [What was not done](#what-was-not-done).

Verdict words are the harness's. Counts and per-title flips are reported, not significance: the
sample is 42 titles from one invented owner.

## What was measured and why

The two candidates:

- **(a) A prompt wording.** Say in the `"categories"` line that the answer is a JSON array. This
  changes the stock prompt every owner gets, including owners with no corrections, so the golden
  prompt pins (`server/test/quickadd-hint-prompt.test.ts`) would have to be re-pinned deliberately and
  the change must not hurt `gemma3n:e4b`, the one tier that already answers arrays.
- **(b) A tolerant parse.** Let `mergeEnrichment` take a bare string for `categories` as one name. No
  prompt change. `constrainToVocabulary`, which the memory fill-in, the Monday scorer, the tag
  suggester and the claim check also call, is not touched.

The gates and the decision rule were written into the harness header and committed (`59e12b0e`)
**before any live run of this experiment**. They are repeated here as registered; the code
(`server/test/classification-shape-live.test.ts`, which carries the registered text verbatim) is the
authority. A first run was made from `59e12b0e`, inside `classification-hint-live.test.ts` as
`LIVE_HINT_SHAPE=1`; the measurement then moved to its own file with its readings, arms, gates and rule
unchanged, because the hint half that file measures is being dropped. The recorded run was replayed
through the new file (`LIVE_SHAPE_REPLAY`): it recomputes every reading from the raw completions, they
equal what the run recorded on all 2,520 calls, and it prints the same rule lines the run printed.

| | |
|---|---|
| Fixture | The same invented owner and 42 titles as the hint measurement: six categories (health, career, relationships, growth, leisure, finance), 18 training, 12 target and 12 control titles. The 30 training and target titles are ones the owner files against the models' habit (exercise to leisure, freelance invoices to career, therapy and journaling to growth), so a low score on them is expected and says nothing against a model; the 12 control titles (a dentist, an electricity bill, a call to mum) are the "obvious" ones |
| Owner state | No corrections, so no hint block: the stock prompt every default install sends |
| Calls | 42 titles x 5 runs per arm and model, interleaved per (title, run) in the order A, W1, W2, A2: 210 calls per arm and model, 2,520 in all (the run took 33 minutes) |
| A, A2 | Today's `enrichQuick`, untouched. A2 is a repeat of A: the noise floor |
| W1 | The stock prompt with the line `"categories": a JSON array of 1-3 life areas from [...], best fit first.` |
| W2 | The stock prompt with `"categories": 1-3 life areas from [...], best fit first, as a JSON array like ["<area>"].` (a placeholder, not one of the owner's names, which would bias the pick) |
| Every other byte | The stock prompt's, asserted for W1 and W2 and for every call |
| Readings | Four readings of each raw completion: `strict` (what production did: arrays only), `whole` (a bare string is one name, matched whole), `split` (as `whole`, then the comma-separated parts when the whole names nothing), `production` (the real `mergeEnrichment`, asserted equal to the shipped reading on every call) |
| Yield **Y** | The share of an arm's completions that name at least one of the owner's categories under a reading |

Gates, as registered (thresholds in `SHAPE_GATES`):

- **S1 yield.** A candidate raises Y over A read `strict` by at least +20 points on each small tier
  that ran (`qwen2.5:0.5b`, `gemma3:1b`).
- **S2 reference.** On `gemma3n:e4b`, at most 2 of the 42 titles have a different modal first pick from
  A read `strict`, and Y is not more than 5 points lower. If A against A2 moves more than 2 titles, S2
  is INCONCLUSIVE: NOISE.
- **S3 schema safety** (wordings only), on every tier: valid-JSON rate and all-nine-keys rate each no
  more than 5 points below A's, and no more empty or errored completions.
- **Rule.** Only (b) qualifies: ship (b). Only (a): ship the wording. Both: ship (b) alone, unless the
  wording with the parse lifts Y by at least 15 points on a small tier over (b). `split` is preferred
  to `whole` only if it adds at least 10 points on a small tier. Neither: ship no fix.

## The run (33 minutes, 2 Nov 2026 13:27 to 14:00 PST)

Three models, the first (`qwen2.5:0.5b`) the fast tier the app resolved (no pin). `violations: []`
(every prompt sent was the one built for its arm; no baseline completion was empty or errored; the real
`mergeEnrichment` equalled the shipped reading on every call).

| Model | Arm | `categories` array / string / other | Y strict | Y whole | Y split | Valid JSON | All nine keys | Valid `direction` |
|---|---|---|---|---|---|---|---|---|
| `qwen2.5:0.5b` | A | 0 / 210 / 0 | 0.0% | 80.0% | 80.0% | 100.0% | 0.0% | 100.0% |
| `qwen2.5:0.5b` | W1 | 210 / 0 / 0 | 94.3% | 94.3% | 94.3% | 100.0% | 13.3% | 100.0% |
| `qwen2.5:0.5b` | W2 | 205 / 5 / 0 | 64.3% | 66.7% | 66.7% | 100.0% | 8.1% | 100.0% |
| `qwen2.5:0.5b` | A2 | 0 / 210 / 0 | 0.0% | 79.5% | 79.5% | 100.0% | 0.0% | 100.0% |
| `gemma3:1b` | A | 45 / 165 / 0 | 21.4% | 91.0% | 91.0% | 100.0% | 93.3% | 58.1% |
| `gemma3:1b` | W1 | 210 / 0 / 0 | 81.0% | 81.0% | 81.0% | 100.0% | 57.1% | 62.4% |
| `gemma3:1b` | W2 | 210 / 0 / 0 | 90.5% | 90.5% | 90.5% | 100.0% | 70.5% | 53.3% |
| `gemma3:1b` | A2 | 43 / 167 / 0 | 19.5% | 91.9% | 91.9% | 100.0% | 93.3% | 60.0% |
| `gemma3n:e4b` | A | 210 / 0 / 0 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 95.2% |
| `gemma3n:e4b` | W1 | 210 / 0 / 0 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 93.3% |
| `gemma3n:e4b` | W2 | 210 / 0 / 0 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 95.2% |
| `gemma3n:e4b` | A2 | 210 / 0 / 0 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 95.2% |

What the rule read off (the harness's own lines, from the run and from the replay):

| Candidate | S1 (+20 points on both small tiers) | S2 (`gemma3n:e4b`) | S3 | Result |
|---|---|---|---|---|
| (b) parse, whole string | PASS: `qwen2.5:0.5b` 0.0 to 80.0, `gemma3:1b` 21.4 to 91.0 | PASS, 0 titles differ, A against A2 0 | n/a, no prompt change | **QUALIFIES** |
| (b) parse, whole else split | PASS, the same figures | PASS | n/a | qualifies; adds nothing (see below) |
| (a) W1 | PASS: 94.3 and 81.0 | PASS | **FAIL** (`gemma3:1b` keys 93.3 to 57.1) | does not qualify |
| (a) W2 | PASS: 64.3 and 90.5 | PASS | **FAIL** (`gemma3:1b` keys 93.3 to 70.5) | does not qualify |
| (a+b) with W1 or W2 | PASS | PASS | **FAIL**, as for the wordings | does not qualify |

D1: (b) qualifies as `whole`. `split` recovered no completion that `whole` did not, on either small tier
(Y equal in every row), because the bare strings were single words; so `split`, which would cut a name
that contains a comma in two, was not preferred. D2: (a) does not qualify. D3: ship (b) alone.

**What the answers look like** (arm A, a bare string, `whole` reading):

- `qwen2.5:0.5b` said `leisure` 126 times, `health` 30, `career` 12, and nothing that names a category
  42 times: `"life areas"` 16, `"work"` 10, `"business"` 5, `"credit card"` 5, `"community"` 4, `"home"` 1,
  `"family"` 1. On the 12 obvious titles it was right for every dentist and doctor title (20 of 20) and
  for none of the finance titles (10 `leisure`, 10 nothing) or the relationship titles (7 `career`, 1
  `leisure`, 12 nothing).
- `gemma3:1b` answered an array on 21.4% of calls and a bare string on the rest; the strings were
  `health` 73, `career` 36, `work` 19 (a direction, no category), `finance` 17, `relationships` 17,
  `growth` 2, `leisure` 1. Of its 60 obvious-title answers 49 named the right category.

How often the first pick was the owner's (call level, 5 runs per title; read `whole` for A, `strict` for
the wordings, which are arrays):

| Model | Arm | 30 convention titles (150 calls; low is expected) | 12 obvious titles (60 calls) |
|---|---|---|---|
| `qwen2.5:0.5b` | A | 51 | 20 |
| `qwen2.5:0.5b` | W1 | 60 | 12 |
| `qwen2.5:0.5b` | W2 | 39 | 24 |
| `gemma3:1b` | A | 23 | 49 |
| `gemma3:1b` | W1 | 10 | 35 |
| `gemma3:1b` | W2 | 13 | 49 |
| `gemma3n:e4b` | A | 35 | 60 |
| `gemma3n:e4b` | W1 | 35 | 60 |
| `gemma3n:e4b` | W2 | 37 | 60 |

## The wizard's path, before and after

`LIVE_CAPTURE=1`: the 18 training titles of the fixture through the real routes as the wizard sends them
(`POST /api/tasks/quick/parse`, the returned `classification_claim` echoed on `POST /api/tasks` with the
owner's category, then one `calibrateClassification` with no embedder). Asserted on every title, and
held: a claim echoed writes exactly one `classification_log` row that says what the claim and the saved
value say, and no claim writes none. Same file, same models, run before and after the change:

| Model | Claims echoed | Corrections written | Indexed by calibrate (of corrections) |
|---|---|---|---|
| `qwen2.5:0.5b`, before | 0 of 18 | 0 | 0 of 0 |
| `qwen2.5:0.5b`, after | 16 of 18 | 10 (6 picks equalled the owner's value, rows left open) | 8 of 10 |
| `gemma3:1b`, before | 3 of 18 | 3 | 3 of 3 |
| `gemma3:1b`, after | 15 of 18 | 15 | 12 of 15 |
| `gemma3n:e4b`, before | 18 of 18 | 18 | 14 of 18 |
| `gemma3n:e4b`, after | 18 of 18 | 18 | 14 of 18 |

These counts are what the loop's input looks like; they do not show that the loop helps a default
install (see below). Three of `gemma3:1b`'s 18 titles still gave no claim after the change. Its
"before" and "after" rows are not the same completions: it answers an array on about 1 call in 5, and its
answers differ from run to run at the margin (its A and A2 arms above differ by two array answers).

## What the change is, and what it leaves alone

`server/src/agents/quickadd.ts`: a private `categoryAnswer(raw)` wraps a string in a one-item list before
the existing `constrainToVocabulary` call in `mergeEnrichment`; everything else is passed on as it came.
So a bare string is read as one name, case-insensitive and trimmed, matched whole against the owner's
categories, and goes through the same never-invent rule as any list element. It is not split on commas,
because a category name may contain one (`"Health, Fitness"`), so `"health, leisure"` as a string names
nothing. Nothing is invented for a string that names no category.

Every caller, and whether the change widens it:

| Caller | Reads `categories` through | Changed? |
|---|---|---|
| Quick add (`/api/tasks/quick`, `/api/tasks/quick/parse`, so the Add dialog's Describe-it) | `mergeEnrichment`, the only caller of `categoryAnswer` | **Yes**: a bare string is one name |
| Memory fill-in (`services/task-enrich.ts`) | `constrainToVocabulary` directly | No: lists only |
| Monday held-out scorer (`services/classification-score.ts`) | `constrainToVocabulary` directly | No |
| Tag suggester (`agents/tags.ts`) | `constrainToVocabulary` directly, for tags | No |
| The wizard's claim check (`settlePreviewClaim` in `routes/tasks.ts`) | `constrainToVocabulary` on the client's claim | No: a claim sent as a bare string is still dropped (tested) |

`tags` and `direction` in quick add are not read any differently: a bare string for `tags` is still no
tag. The memory fill-in and the scorer send their own prompts to the same models and may or may not
elicit bare strings; that was not measured, so they were not loosened.

Tests: `server/test/quickadd-category-answer.test.ts` (the merge on every shape listed above, the real
`enrichQuick` on a scripted bare-string answer with the prompt line pinned, and the wizard path end to end
with only the model stubbed; the assertions that need the change fail without it), the shape file's pure
parts, and the Learning card's copy test (the card said the category part "only works when the model
answers categories as a list", which stopped being true; the CHANGELOG and README sentences to the same
effect are corrected too).

## What was not done

- **The hint experiment's G1 to G6 were not re-run.** The registered plan (D4) asked for it. Three
  reasons it was not: the hint half they gate is being dropped by a separate decision, so the instrument
  and what it measures are leaving `main`; this change shows every model exactly the prompt it was shown
  before (the stock-prompt pins in `quickadd-hint-prompt.test.ts` pass unchanged, and G4 was never at
  risk); and that harness reads a pick with `constrainToVocabulary` on the array only, so run on the
  default tier now it would score bare strings as misses unless it were edited to the new reading, in a
  file that is going away. What stands in for it: S2 on `gemma3n:e4b` (no title's modal pick moved, noise
  floor 0), the capture check (`gemma3n:e4b` identical before and after), and the unchanged prompt. That
  is a weaker statement than "G1 to G6 still hold", and it is the whole of it.
- **Whether the loop helps a default install.** Capture and the weekly index now work on the default
  tier. Whether anything reads the index back is the apply half, which is the hint, and the hint is being
  dropped; memory enrichment, the other reader, is off by default. This change makes the corrections
  appear; it does not show or claim that they improve quick add. The loop stays weekly: the Monday
  `calibrate_classification` run folds corrections in, and a field needs at least 2 first.
- **A pick that is mostly wrong on the default model.** Not fixed, and not a parse problem: see "Usable
  is not good". If the owner would rather have no suggestion than a wrong one on the smallest tier, the
  switch is `categoryAnswer` returning its argument unchanged; or a gate on the model's size, which was
  not designed or measured.
- **The other 20% of `qwen2.5:0.5b`'s answers, and its dropped keys.** It still returns three of nine
  keys on every call (all nine on 0.0%), and 42 of 210 answers name no category. Neither is touched.
- **Other wordings.** Two wordings were tried, one a plain statement and one with a placeholder. An
  example with a real category name, a few-shot answer, or a JSON-schema-constrained call were not tried.
- **What the harness cannot see:** a real owner's vocabulary (names that are not single common words, more
  or fewer than six, or a category that happens to be a word a model likes to answer), temperature, or
  the pick's effect on what the owner then does.

## The box

Unchanged from the hint measurement: Ollama 0.34.0 at `http://127.0.0.1:11434`, the service up since
1 Nov 13:31 PST with `OLLAMA_MAX_LOADED_MODELS=2`, `OLLAMA_NUM_PARALLEL=2`, `OLLAMA_KEEP_ALIVE=24h`,
`OLLAMA_CONTEXT_LENGTH=32768`, `OLLAMA_LLM_LIBRARY=vulkan` and `OLLAMA_IGPU_ENABLE=1` (read again on
2 Nov before the runs; the service was not restarted). Node v26.3.0, vitest 4.1.8. `qwen2.5:0.5b` is
the built-in fast default and was the fast tier the app resolved in the shape run (no pin;
`provenance.fastTier.pinnedBy` is null). `gemma3:1b` and `gemma3n:e4b` ran as the informational
models, the model injected into every call as in the hint measurement. The artifact records the
commit it ran on (`59e12b0e`), that no tracked file differed from it, and a hash of each source.

## How to reproduce

The artifacts (`shape-run-1.json`, `capture-before.json`, `capture-after.json`, with their logs) are not
in the repository; they were kept in `~/.cache/ci-planning-shape-fix/` on the machine that ran them.

```
cd server
LIVE_SHAPE=1 LIVE_SHAPE_RUNS=5 \
  LIVE_SHAPE_MODELS=qwen2.5:0.5b,gemma3:1b,gemma3n:e4b LIVE_SHAPE_OUT=<out>/shape-run-1.json \
  ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose

LIVE_CAPTURE=1 LIVE_SHAPE_MODELS=qwen2.5:0.5b,gemma3:1b,gemma3n:e4b LIVE_SHAPE_OUT=<out>/capture.json \
  ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose

LIVE_SHAPE_REPLAY=<out>/shape-run-1.json \
  ./node_modules/.bin/vitest run test/classification-shape-live.test.ts -t replay --reporter=verbose
```

`--reporter=verbose` matters (the default reporter hides the console of a passing file). The first
run was made with the earlier names of the same switches (`LIVE_HINT=1 LIVE_HINT_SHAPE=1`
`LIVE_HINT_RUNS` `LIVE_HINT_MODELS` `LIVE_HINT_OUT`) from `59e12b0e`; the capture checks ran from the
file as it now is, the "before" on the code without `categoryAnswer`. The pure parts, no model, run in
every test run.
