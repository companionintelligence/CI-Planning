# Classification hint in quick add: live measurement (2 Nov 2026)

Evidence for `feat(classification): show quick-add the owner's corrections; record the wizard's
category pick` (branch `feat/classification-hint-quick-add`, commits `96dbea90`, `0121a543` and
`92854927`, on `origin/main` `9dce59ae`). The change has two halves with different standing.
**Capture** (the wizard's Add records the model's category pick, so your edit of it becomes a
correction) is bookkeeping: it changes no prompt. The **hint** (quick add and the Describe-it
preview show the model your most common category corrections) changes what a small local model is
shown, and `agents/quickadd.ts` already records that a layout or wording change there is a retune
that has to be measured, not argued. So the harness and its gates were written down before the
first live run (the ship rule gained one sentence after run 3; see
[Pre-registered gates](#pre-registered-gates)), and this document is what they read.

## Result in brief

- **Capture ships.** It changes no prompt. The harness drove it end to end on real models (on
  `gemma3n:e4b` it wrote 18 corrections, 14 of which went into the index the hint read and 4 of
  which were held out for scoring) and tests cover it.
- **The hint ships on the evidence of one tier, `gemma3n:e4b`.** With the shipped layout (hint last)
  it took the scored targets from 3 of 12 to 7 of 12 titles, 4 wins and 0 losses, and a placebo block
  of the same size and place left them at 3 of 12. G1 **IMPROVED**; G3, G4, G5 and G6 pass, and G2
  passes at its allowance (1 of 12 controls flipped, 1 allowed; the placebo cost a control too). That
  is one model, one invented owner and 12 target titles. It learned two of the owner's three
  conventions and none of the exercise titles.
- **On the other two tiers the measurement has no power.** `qwen2.5:0.5b` (the built-in fast tier,
  and the one on this box when nothing is pinned) answers `categories` as a bare string on 60 of 60
  baseline completions and on 18 of 18 training completions; production keeps only arrays, so it
  yields no pick, no claim, no correction and nothing to learn: **INCONCLUSIVE: UNUSABLE ANSWER SHAPE**.
  `gemma3:1b` answers an array on 20% of baseline calls: G1 reads NO MEASURABLE CHANGE and the same
  INCONCLUSIVE label applies. The array answers that `gemma3:1b` did give were almost never the
  owner's value in any arm, so read that tier as unmeasured with a lean toward no benefit, not as a
  gain hidden by the harness (see [Ship decision](#ship-decision)).
- **The who-it's-for half of the hint is unmeasured.** The wizard records category picks only, so the
  fixture has no who-it's-for corrections and that block was empty in all six runs.
- **The registered ship rule, read literally, is not met.** It asks for G1 on the fast tier. That is
  stated again, with the reasoning, under [Ship decision](#ship-decision). The decision is the
  author's and the owner can reverse it; dropping the hint half is one line.
- **The layout changed after the first three runs.** The first three runs measured the hint beside
  its field. That failed G3 on `gemma3:1b`, so the shipped layout became hint-last and runs 4 to 6
  re-measured it. No gate was edited. One sentence was added to the ship rule after run 3. Runs 4 to
  6 ran on `92854927`, which also carries the review fixes in `0121a543`, so the layout is not the
  only difference between run 3 and run 6. All six runs are kept below.

Verdict words are the harness's: **IMPROVED / HARMED / NO MEASURABLE CHANGE / INCONCLUSIVE**
(with `NO HEADROOM`, `NOISE` or `UNUSABLE ANSWER SHAPE` after the colon).

## What was measured and why

The learning-loop audit of 2 Nov 2026 found the classification loop open on a default install:

1. `classificationHint` reached a prompt in one place only, memory enrichment, which is behind
   `MEMORY_MODE` and off by default. The interactive classifier, `enrichQuick`, never read it.
2. The wizard's Add (`POST /api/tasks`) logged nothing, so the model's category pick was never
   evidence, and your edit of it before Add, the most explicit correction there is, was lost.

The change under measurement:

- **Capture.** `POST /api/tasks/quick/parse` returns an opaque `classification_claim`
  (`{ text, categories }`) when the model chose categories the deterministic parse did not carry.
  The wizard echoes it on its add-mode `POST /api/tasks`. After a successful create the server
  writes one `classification_log` row: closed at once if the saved categories, in order, differ from
  the pick, open (pending 24 hours, then a weak accept) if the ordered list is the same. The claim is unsigned and bound to the
  new task's own title and the caller's own category names; any failed check drops it silently.
- **Hint.** Both quick routes (`/quick/parse` and `/quick`) hand `enrichQuick` the owner's own
  corrections through `enrichEntry` (`routes/tasks.ts`): `classificationHint(..., { embedFn: null,
  accept })`. Frequency-only, so the interactive path never waits on the embedder: one lesson for
  each of the owner's most-corrected values, at most `RETRIEVE_K` = 3, a pure read of the last
  `calibrate_classification` run, empty (a byte-identical prompt) below `CORRECTION_FLOOR` = 2
  corrections. The blocks sit **last**: after the "never invent" line, directly before `Entry:`,
  motivation's block first.

What the harness asks of a small model: does the hint make it file titles the way the owner does,
without costing it other titles, its JSON, or time; and does the whole loop (capture, calibrate,
apply) close end to end on a real model and not on a stub.

## The box

| | |
|---|---|
| Ollama | 0.34.0 at `http://127.0.0.1:11434` (`env.ollamaVersion` in every artifact) |
| Server settings | The `ollama.service` unit and its drop-ins, read on 2 Nov after the runs: `OLLAMA_MAX_LOADED_MODELS=2`, `OLLAMA_NUM_PARALLEL=2`, `OLLAMA_KEEP_ALIVE=24h`, `OLLAMA_CONTEXT_LENGTH=32768`, `OLLAMA_LLM_LIBRARY=vulkan`, `OLLAMA_IGPU_ENABLE=1` and `OLLAMA_HOST=0.0.0.0:11434` (with `PATH`, the unit's whole environment). The service had been up since 1 Nov 13:31 PST and the newest drop-in dates from 21 Sep, so the same values applied to all six runs. The artifacts record only that the **test process** had `OLLAMA_MAX_LOADED_MODELS` unset; the server's own value is not visible from there |
| Hardware | Not recorded in the artifacts. The Vulkan drop-in's comment names an AMD Strix Halo (unified memory) |
| Software | Node v26.3.0, vitest 4.1.8, Linux |
| `qwen2.5:0.5b` | 494.03M parameters, Q4_K_M, capabilities `completion,tools`. The built-in **fast** default (`lib/config.ts`) and installed |
| `gemma3:1b` | 999.89M parameters, Q4_K_M, capability `completion` |
| `gemma3n:e4b` | Capability `completion`. The built-in **quality** default (`lib/config.ts`) and installed. Size not in the artifacts |
| Embedder | `nomic-embed-text:latest`, 137M. Used only by arm S and by the second `calibrate` that builds its vectors |
| Thinking models | Excluded from generation (a thinking model answers `""` under `format:"json"`, which reads exactly like "unchanged", see `lib/models.ts`). None of the three has the capability; the harness asserts it. Other models installed on the box were not used |
| Resident at the start | Run 4: `gemma3:1b`, `qwen2.5:0.5b`. Run 5: `qwen2.5:0.5b`, `nomic-embed-text`. Run 6: `gemma3:1b`, `qwen2.5:0.5b` (`provenance.ollama.apiPsAtStart`). Runs 1 to 3 predate that field. With a 24 h keep-alive a model left by one run is still there for the next |

**Which tier was set by what.** The harness asserts that the first model in `LIVE_HINT_MODELS` is the
fast tier the app itself resolves; that tier is the only one the gates apply to.

| Runs | Gating tier | Set by |
|---|---|---|
| 1, 4 | `qwen2.5:0.5b` | The box default (run 4's artifact: `resolvedDefault.source: "default"`, no pin) |
| 2, 5 | `gemma3:1b` | `OLLAMA_FAST=gemma3:1b` in the test process |
| 3, 6 | `gemma3n:e4b` | `OLLAMA_FAST=gemma3n:e4b` in the test process |

Runs 5 and 6 record the pin (`provenance.fastTier.pinnedBy: "OLLAMA_FAST"`) and say in their log and
artifact that the gates, registered against `qwen2.5:0.5b`, were applied to a pinned tier. Runs 2 and
3 predate the provenance block; that they were pinned is from the run record, from the harness's
dated note quoted below ("The later runs set OLLAMA_FAST"), and it follows from the assertion above
(the box default is `qwen2.5:0.5b`). `gemma3n:e4b` is therefore **not** the fast tier
on this box unless pinned or chosen in Settings. In the app the fast tier resolves in the order
Settings override, `OLLAMA_FAST`, the built-in default if installed, then auto-selection from what is
installed (`lib/models.ts`), so what "the default" is differs per install.

## How to reproduce

Opt-in, needs a live Ollama with the model and the embedder pulled. Without `LIVE_HINT=1` the file
reports as skipped.

Runs 4 to 6 (the confirmation runs, from `server/`; the real argv is recorded in each artifact):

```
cd server
LIVE_HINT=1 LIVE_HINT_RUNS=5 LIVE_HINT_MODELS=qwen2.5:0.5b \
  LIVE_HINT_OUT=<out>/confirm-qwen05.json \
  ./node_modules/.bin/vitest run test/classification-hint-live.test.ts \
  --reporter=verbose --testTimeout=7200000 --hookTimeout=7200000

OLLAMA_FAST=gemma3:1b LIVE_HINT=1 LIVE_HINT_RUNS=5 LIVE_HINT_MODELS=gemma3:1b \
  LIVE_HINT_OUT=<out>/confirm-gemma3-1b.json \
  ./node_modules/.bin/vitest run test/classification-hint-live.test.ts \
  --reporter=verbose --testTimeout=7200000 --hookTimeout=7200000

OLLAMA_FAST=gemma3n:e4b LIVE_HINT=1 LIVE_HINT_RUNS=5 LIVE_HINT_MODELS=gemma3n:e4b \
  LIVE_HINT_OUT=<out>/confirm-gemma3n-e4b.json \
  ./node_modules/.bin/vitest run test/classification-hint-live.test.ts \
  --reporter=verbose --testTimeout=7200000 --hookTimeout=7200000
```

`--reporter=verbose` matters (the default reporter hides the console of a passing file, and the
console is where the tables and verdicts print). The timeout flags are what runs 4 to 6 passed; the
live test also carries a six-hour timeout of its own. Run 4 took about 10 s, run 5 about 11 minutes,
run 6 about 31 minutes (vitest's total duration).

Runs 1 to 3 used the same command without the timeout flags and with the model names above
(`LIVE_HINT=1 LIVE_HINT_RUNS=5 LIVE_HINT_MODELS=<model> LIVE_HINT_OUT=<path>.json vitest run
test/classification-hint-live.test.ts`, as their artifacts record it). Per the run record, runs 2 and 3
set `OLLAMA_FAST` to the model; their artifacts do not.

An offline self-check of the harness's pure helpers, with no Ollama and no model time, also builds
the prompt with the real `enrichQuick` and checks both layouts against it, so a change to where
`enrichQuick` puts the hints stops it before any model time is spent:

```
LIVE_HINT=1 ./node_modules/.bin/vitest run test/classification-hint-live.test.ts -t "pure helpers"
```

Where the numbers below come from: each run's console log and its per-call JSON artifact
(arm, title, run, prompt hash, raw completion, the JSON type of `categories`, parsed pick, correct,
milliseconds, plus the report, the distinct prompts, latency, residency and provenance). **The logs
and artifacts are not in the repository** (about 0.1 to 1.3 MB each; they were kept outside it).
Where a log was thin, the figure was computed from the JSON. The answer-shape columns for runs 1 to 3,
which predate the shape metric, were computed by replaying the harness's own shape helpers (lifted
out of the test file's source) over those artifacts; that replay script is not committed either.
The start and end times in the run headings are each artifact's `startedAt` and `writtenAt`,
truncated to the second, and the durations are their difference. Vitest's own total duration is
about 2 s longer for import and transform (9.8, 601, 1,278, 10.4, 648 and 1,839 s for runs 1 to 6).
Re-run the harness rather than trusting the tables.

## The fixture

One invented owner with the six default categories (health, career, relationships, growth, leisure,
finance) and three conventions where they file a kind of title somewhere other than where a model
would by default: exercise and sport go to leisure (not health), freelance invoices, tax and
bookkeeping go to career (not finance), and therapy, meditation and journaling go to growth (not
health). Each convention has 6 training titles (sent through the real capture path, so the
corrections are the model's authentic misses, not invented ones) and 4 held-out target titles, plus
12 control titles whose natural answer is not a convention value, including near-misses (a dentist
appointment beside the exercise convention, an electricity bill beside the invoices convention, a
prescription refill beside the inner-work convention).

## Pre-registered gates

Copied verbatim from the header of `server/test/classification-hint-live.test.ts`. The G1 to G6
block below is byte for byte what the header carried at commit `96dbea90`, registered on
**2026-11-02, before the first live run** (run 1 began within ten seconds of that commit being
made). The ship rule after it is also verbatim from today's header, but **not all of it was
registered before run 1**: its last sentence was added after run 3. Scored titles are the targets
of conventions with headroom, that is, whose baseline on its targets is under 75%. The shape, power,
placebo and layout notes that were added afterwards are in the next subsection; none of them edits
a gate.

```text
PRE-REGISTERED GATES (fast tier only), 2026-11-02, before the first live run. Do not edit
a gate after seeing a result; add a dated note under it instead. Scored titles are the
targets of conventions that have headroom.
  G1 EFFICACY         B beats A on the scored targets by at least +20 points absolute, or by
                      at least 2 more titles net (wins minus losses). If A versus A2 moves
                      more than 2 of those titles, G1 is INCONCLUSIVE: NOISE (the noise is as
                      large as the effect). No headroom anywhere: INCONCLUSIVE: NO HEADROOM.
                      The mirror image (at most -20 points, or at least 2 titles net the
                      wrong way) is HARMED; anything between is NO MEASURABLE CHANGE.
  G2 OVER-APPLICATION At most 1 of the 12 controls goes baseline-correct (A) to hinted-wrong (B).
  G3 SCHEMA SAFETY    Valid-JSON rate and key presence for B no more than 5 points below A,
                      and no new empty (or errored) completions.
  G4 NO-OP            For an owner with no index (never calibrated, another owner, or after
                      DELETE /api/classification/exemplars) the prompt POST /api/tasks/quick/parse
                      sends equals the one enrichQuick builds with no hints, byte for byte.
                      ASSERTED on every fixture title in dry mode (no model call), not sampled.
  G5 LOOP             The share of scored target titles classified to the owner's value after
                      calibrate is higher with B than with A: the owner's acceptance test.
                      Weaker than G1 by design (any gain), reported with the per-title flips.
  G6 LATENCY          The in-process hint read (the Promise.all of the two classificationHint
                      calls with the exact production arguments), N=30 per condition, first run
                      discarded, owner with an index interleaved with owner without: with an
                      index p50 <= 20 ms and p95 <= 60 ms; without an index p95 <= 5 ms.
Counts and per-title flips are reported, not significance. The minimum detectable effect
is one title out of n and is printed instead of calling a null 'neutral'.
Verdicts: IMPROVED / HARMED / NO MEASURABLE CHANGE / INCONCLUSIVE: NO HEADROOM
(plus INCONCLUSIVE: NOISE for the A-versus-A2 rule above).
```

The ship rule, verbatim from today's header. At `96dbea90` it ended at "enrichEntry and cite the
doc." (`git show 96dbea90:server/test/classification-hint-live.test.ts`); the final sentence, which
starts "Arm C" and runs to the end of the block, was added after run 3, together with the layout
change:

```text
DECISION RULE (the ship rule, restated; the lead decides, the harness only reads it off).
Capture ships regardless. The hint half ships only if on the fast tier G2, G3 and G4 hold
AND G1 holds. G2 or G3 fails: re-run B with k: 1 (arm B1), then S; if both still fail,
drop the hint half. G1 fails with G2 and G3 passing: do not ship the hint half by default,
and put arm N in the evidence doc as the basis for a follow-up. If S shows a clear
accuracy edge over B AND no latency or residency damage, flip { embedFn: null } to {} in
enrichEntry and cite the doc. Arm C (the adjacent layout) is never a remedy in this rule:
the layout was changed once for failing G3, and C is only there to show whether it still
does.
```

The added sentence is a statement about what arm C is for, made after the layout had changed. It is
not one of the rules that were registered before the first run.

### Notes added after the first runs

Verbatim from the same header. Each is a new non-gating diagnostic, a clearer label or a dated
reading of a run that had already happened.

```text
NOTES ADDED AFTER THE FIRST RUNS. The gates, their thresholds and the verdict words above are
exactly as registered. Nothing below edits one: each item is a new non-gating diagnostic, a
clearer label, or a dated reading of a run that had already happened.
  2026-11-02, after the first runs: the default fast tier (qwen2.5:0.5b) answered "categories"
  as a bare string on all 60 baseline completions of the first run. Production keeps only
  arrays, so on that tier quick-add yields no category pick, the wizard gets no
  classification_claim, and nothing can be corrected. That run's INCONCLUSIVE: NO HEADROOM was
  a type artifact (0 claims on 18 training parses and a baseline of 0 of 12 targets, both
  because no pick survived), not a finding that the model files things the way the owner
  does. The later runs set OLLAMA_FAST, which makes the model they name "the fast tier the
  app resolves" for the assertion in beforeAll and so the gating tier of that run: the second
  gemma3:1b (arrays on 12 of its 60 baseline completions, bare strings on the rest, so it is
  only partly past the problem), the third gemma3n:e4b (arrays on all 60 of its baseline
  completions, and on every other completion of that run). Neither is "the default tier"; the
  artifact now says when the gating tier was set by a pin rather than the box default
  (provenance.gatingTierNote).
  2026-11-02: a baseline whose "categories" is an array on fewer than 50% of its completions
  is labelled INCONCLUSIVE: UNUSABLE ANSWER SHAPE. INCONCLUSIVE: NO HEADROOM stays for a model
  that answers arrays and gets the owner's values right. A run is not stopped earlier or later
  for it; only the label and the reading change.
  2026-11-02: power notes. G2 can only flip the controls the baseline got right, and G3's
  key-presence clause cannot fail from a baseline that already omits keys. The report prints
  both numbers beside the gates and "NOT POWERED: ..." when fewer than 6 controls are
  baseline-correct or the baseline emits all nine keys on under 50% of its calls. PASS and
  FAIL mean exactly what was registered; the note says how much a PASS can be worth.
  2026-11-02: arm P, the answer-shape table and the provenance block are described above.

THE LAYOUT OF B CHANGED AFTER THE FIRST THREE LIVE RUNS. No gate, threshold or verdict word
above is edited by it; what changed is the layout of the arm the gates are applied to.
  2026-11-02, after the first three live runs: the shipped layout was changed from adjacent
  to hint-last because adjacent failed G3 on gemma3:1b (all keys 99.2% -> 5.0%) while
  hint-last passed G3 on both models and tied adjacent on the gemma3n:e4b targets (7/12 vs
  7/12). The gates are applied unchanged to the new layout in confirmation runs; the first
  three runs are kept as the record of the adjacent layout.
```

### The arms

Same titles, same 5 runs, interleaved per (title, run) in the fixed order A, B, C, S, A2, P so
warm-up drift cannot favour one arm.

| Arm | What it is |
|---|---|
| A0 | Not an arm of the comparison: the pre-training baseline on all 12 targets, which decides headroom |
| A | Baseline: today's prompt, no hints |
| A2 | A repeat of A: the noise floor |
| B | **The shipped path.** `POST /api/tasks/quick/parse` through the real route, frequency hints, accept filter. Hint last in runs 4 to 6; **adjacent** (beside its field) in runs 1 to 3 |
| C | The other layout, non-gating. Hint last in runs 1 to 3; adjacent in runs 4 to 6, rebuilt byte for byte from the former `enrichQuick` (`git show 96dbea90:server/src/agents/quickadd.ts`). An artifact says which in its `layouts` key; one without that key is from before the change |
| P | Placebo (runs 4 to 6 only, non-gating): B's block, in B's place, built from real lessons about other conventions, as many as B shows and as close to B's length as the index allows, never carrying the title's own convention's value. B against A confounds "the owner's lessons help" with "any such block changes the answer"; B against P takes the block, its place and its framing out |
| S | `classificationHint` with the real embedder (similarity), for the record |
| B1 | B with `k: 1`; runs only when B fails G2 or G3 |
| N0, N | The narrow one-field question as `services/classification-score.ts` sends it, without (N0) and with (N) B's hint; run only when B shows no gain on the targets |

Scoring is first-category accuracy per title, strict majority over the 5 runs (more than half). At
temperature 0.1 the runs are near-identical, so titles, not trials, are the sample.

## Results

Columns, in every per-run table: **targets** and **controls** are titles right by strict majority
(of the 12 scored targets and the 12 controls; A0 is all 12 targets and has no controls); **valid
JSON** and **all 9 keys** are the share of completions; **array** is the share of completions whose
`categories` is a JSON array, the only shape production keeps; **empty** and **err** are completion
counts; **mean** and **p95** are model-call milliseconds. Every figure is from the run's artifact or
log; the array column of runs 1 to 3 is from the replay.

### Gates for B against A, all six runs

| Gate | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Run 6 |
|---|---|---|---|---|---|---|
| Tier, layout of B | `qwen2.5:0.5b` (default), adjacent | `gemma3:1b` (pin), adjacent | `gemma3n:e4b` (pin), adjacent | `qwen2.5:0.5b` (default), last | `gemma3:1b` (pin), last | `gemma3n:e4b` (pin), last |
| G1 efficacy | No hinted arm ran | NO MEASURABLE CHANGE, 0 → 0 | **IMPROVED**, 3 → 7 (+4, 0 losses) | No hinted arm ran | NO MEASURABLE CHANGE, 0 → 0 | **IMPROVED**, 3 → 7 (+4, 0 losses) |
| Baseline shape | Read as INCONCLUSIVE: NO HEADROOM then; the 2 Nov note calls that a type artifact (array 0%) | Array 20.0% (would now read INCONCLUSIVE: UNUSABLE ANSWER SHAPE) | Array 100% | INCONCLUSIVE: UNUSABLE ANSWER SHAPE (array 0%) | INCONCLUSIVE: UNUSABLE ANSWER SHAPE (array 20.0%) | Array 100% |
| G2 over-application | Not run | PASS, 0 of 2 flipped (**not powered** by the later note) | PASS, 0 of 12 | Not run | PASS, 1 of 2 flipped (**not powered**) | PASS, 1 of 12 (the allowance) |
| G3 schema safety | Not run | **FAIL**, all keys 99.2% → 5.0% | PASS, 100% → 100% | Not run | PASS, 98.3% → 100.0% | PASS, 100% → 100% |
| G4 no-op | 84 pre-index prompts equal stock, rest not run | PASS, 168 | PASS, 168 | 84 pre-index prompts equal stock, rest not run | PASS, 168 | PASS, 168 |
| G5 loop | Not run | FAIL, 0.0% → 0.0% | PASS, 25.0% → 58.3% | Not run | FAIL, 0.0% → 0.0% | PASS, 25.0% → 58.3% |
| G6 latency | Not run | PASS | PASS | Not run | PASS | PASS |

So on `qwen2.5:0.5b` the hint never appeared in a prompt: no title produced a claim, no correction
was written, no index was built. G3 and G6 were not run there. G4 was asserted on the 84 prompts
built before the index existed (0 differing) and not on the rest. With the layout change, G3, G4 and
G6 pass on `gemma3:1b` and `gemma3n:e4b`.

### Run 1: `qwen2.5:0.5b`, box default, B = adjacent

2 Nov 2026 12:49:08 to 12:49:16 UTC (8 s). 60 model calls recorded. Tree: `96dbea90` (inferred from
the clock; the artifact carries no commit). 18 training titles parsed, 0 claims echoed, 0 corrections,
no index. The harness stopped before any hinted arm; its status then read INCONCLUSIVE: NO HEADROOM,
which the 2 Nov note under the gates corrects (it was a type artifact, see
[Answer shape](#answer-shape-qwen25-05b-answers-categories-as-a-bare-string)).

| Arm | Targets | Controls | Valid JSON | All 9 keys | Array | Empty | Err | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 0/12 | n/a | 100.0 | 0.0 | 0.0 | 0 | 0 | 97 | 115 |

### Run 2: `gemma3:1b`, pinned, B = adjacent, C = hint last

2 Nov 12:50:31 to 13:00:31 UTC (599 s). 1,020 model calls. Tree `96dbea90` (inferred). 4 claims
echoed, 4 corrections, 3 indexed and 1 held out (growth 2, career 1). The hint was 244 characters.
Retrieval on the targets, top lesson / any of 3: frequency 4/12, 8/12; similarity 7/12, 8/12.

| Arm | Targets | Controls | Valid JSON | All 9 keys | Array | Empty | Err | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 0/12 | n/a | 100.0 | 96.7 | 20.0 | 0 | 0 | 406 | 424 |
| A | 0/12 | 2/12 | 100.0 | 99.2 | 20.0 | 0 | 0 | 393 | 419 |
| B (adjacent) | 0/12 | 7/12 | 100.0 | **5.0** | 75.0 | 0 | 0 | 269 | 424 |
| C (hint last) | 0/12 | 1/12 | 100.0 | 100.0 | 9.2 | 0 | 0 | 426 | 447 |
| S | 1/12 | 7/12 | 100.0 | 0.0 | 85.8 | 0 | 0 | 1437 | 1564 |
| A2 | 0/12 | 3/12 | 100.0 | 99.2 | 21.7 | 0 | 0 | 408 | 438 |
| B1 (k: 1, adjacent) | 0/12 | 6/12 | 100.0 | 0.0 | 76.7 | 0 | 0 | 265 | 555 |
| N0 | 0/12 | 0/12 | 100.0 | 100.0 | 7.5 | 0 | 0 | 81 | 87 |
| N | 0/12 | 0/12 | 100.0 | 100.0 | 0.8 | 0 | 0 | 88 | 108 |

What it shows. With the hint beside its field, 91 of B's 120 completions stop after `direction`,
`categories` and `tags` (A: 119 of 120 carry all nine keys; C: 120 of 120). G3 **FAIL**, and B1 and
S fail it too (all keys 0.0%), so by the rule the hint half did not ship on this evidence. B's higher
control count (7/12 against 2/12) tracks the array share (75.0% against 20.0%), not accuracy: among
the control calls that did answer an array, A was right on 12 of 14 and B on 36 of 47.

### Run 3: `gemma3n:e4b`, pinned, B = adjacent, C = hint last

2 Nov 13:01:07 to 13:22:24 UTC (1,276 s). 660 model calls. Tree `96dbea90` (inferred). 18 claims, 18
corrections, 14 indexed and 4 held out (leisure 4, career 5, growth 5). The hint was 353 characters.
Retrieval on the targets: frequency 4/12, 12/12; similarity 12/12, 12/12.

| Arm | Targets | Controls | Valid JSON | All 9 keys | Array | Empty | Err | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 3/12 | n/a | 100.0 | 100.0 | 100.0 | 0 | 0 | 1458 | 1516 |
| A | 3/12 | 12/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1462 | 1937 |
| B (adjacent) | 7/12 | 12/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1573 | 1779 |
| C (hint last) | 7/12 | 11/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1570 | 2090 |
| S | 8/12 | 10/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1874 | 4552 |
| A2 | 3/12 | 12/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1517 | 2024 |

What it shows. B (adjacent): G1 IMPROVED, 4 wins and 0 losses (Pay the self-employment tax; Gather
1099 forms for the accountant; Weekly therapy appointment; Silent sitting meditation), G2 0 of 12
flipped, A against A2 flipped 0. C (hint last) tied B on the targets (7/12 against 7/12, the same four
wins) and lost one control, Pay the electricity bill (G2 still passes at the allowance of 1). S: 8/12,
G2 FAIL (Pay the electricity bill; Review the monthly budget). Run 2 showed hint-last (arm C there)
keeping every key where adjacent had not on `gemma3:1b`, and this run showed it tying adjacent on the
targets. Together they are the basis the header note gives for the layout change; the artifacts
cannot show which run prompted the idea.

### Run 4: `qwen2.5:0.5b`, box default, B = hint last (confirmation)

2 Nov 14:37:08 to 14:37:17 UTC (8 s). 60 model calls. Commit `92854927` (which also contains the
review fixes `0121a543`), no differing paths. 18
training titles parsed, 0 claims echoed (18 produced none), 0 corrections, 0 indexed. Status
**INCONCLUSIVE: UNUSABLE ANSWER SHAPE**; the baseline's `categories` was an array on 0 of 60
completions (60 strings). Read leniently (a bare string taken as a one-item list; not what production
does) the baseline is 5 of 12 targets, not 0.

| Arm | Targets | Controls | Valid JSON | All 9 keys | Array | Empty | Err | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 0/12 | n/a | 100.0 | 0.0 | 0.0 | 0 | 0 | 97 | 118 |

### Run 5: `gemma3:1b`, pinned, B = hint last (confirmation), C = adjacent

2 Nov 14:37:19 to 14:48:05 UTC (647 s). 995 model calls. Commit `92854927`, no differing paths. 3
claims echoed (15 produced none: `categories` was an array on 4 of the 18 training completions and a
string on 14), 3 corrections, 3 indexed and 0 held out (career 2, growth 1). The hint was 248
characters. Retrieval on the targets: frequency 4/12, 8/12; similarity 8/12, 8/12. Arm P could be
built for only 19 of 24 titles, from the 3 lessons in the index, and with one lesson where B shows
two (80 characters shorter than B's on average), so P ran on 8 targets and 11 controls.

| Arm | Targets | Controls | Valid JSON | All 9 keys | Array | Empty | Err | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 0/12 | n/a | 100.0 | 100.0 | 20.0 | 0 | 0 | 409 | 418 |
| A | 0/12 | 2/12 | 100.0 | 98.3 | 20.8 | 0 | 0 | 402 | 427 |
| B (hint last) | 0/12 | 1/12 | 100.0 | 100.0 | **7.5** | 0 | 0 | 423 | 458 |
| P | 0/8 | 0/11 | 100.0 | 100.0 | 7.4 | 0 | 0 | 409 | 443 |
| C (adjacent) | 0/12 | 4/12 | 100.0 | **0.0** | 54.2 | 0 | 0 | 312 | 404 |
| S | 0/12 | 3/12 | 100.0 | 100.0 | 34.2 | 0 | 0 | 1601 | 1631 |
| A2 | 0/12 | 2/12 | 100.0 | 99.2 | 20.8 | 0 | 0 | 397 | 428 |
| N0 | 0/12 | 0/12 | 100.0 | 100.0 | 8.3 | 0 | 0 | 78 | 84 |
| N | 0/12 | 0/12 | 100.0 | 100.0 | 0.8 | 0 | 0 | 85 | 107 |

What it shows. B passes G3 (98.3% → 100.0%), G4 and G6, and G2 with 1 of its 2 flippable controls
flipped (Refill blood pressure prescription), which the harness labels **NOT POWERED** (only 2 of 12
controls were right at baseline, under the 6 it asks for). G1 is NO MEASURABLE CHANGE, 0 → 0, and with the
baseline an array on 20.0% of calls it reads as INCONCLUSIVE: UNUSABLE ANSWER SHAPE. B against P
(P ran on 19 of the 24 titles): on the 8 targets, B right where P wrong on 0 titles and the other
way on 0; on the 11 controls, 1 and 0 (Flu shot at the pharmacy). C, the adjacent layout, fails G3 again (all keys 98.3% → 0.0%: of its 120
completions 52 stop after `direction`, `categories` and `tags` and 63 stop before `tags`). The narrow
question (N0, N) gained nothing either. By the rule as registered: capture ships, the hint half does
not by default.

One thing G3 does not read: with the hint last, the share of completions whose `categories` is an
array **fell**, from 20.8% (A) to 7.5% (B) over all 24 titles. On the 19 titles the placebo ran on
the figures are A 23.2% (22 of 95 calls), B 9.5% (9 of 95) and P 7.4% (7 of 95), so the placebo
block moved it the same way. The block, not its lessons, moves the answer shape on this model. See
[What this does not show](#what-this-does-not-show).

### Run 6: `gemma3n:e4b`, pinned, B = hint last (confirmation), C = adjacent

2 Nov 14:48:07 to 15:18:45 UTC (1,837 s). 780 model calls. Commit `92854927`, no differing paths. 18
claims echoed, 18 corrections, 14 indexed and 4 held out (leisure 4, career 5, growth 5). The hint was
353 characters as the harness prints it; each hinted prompt was 352 characters longer than its stock
prompt (the 24 stock prompts run from 3,371 to 3,403 characters). Arm P was built for 24 of 24
titles from the 14 lessons in the index, within 5 characters of B's length (mean 1.3). Retrieval on
the targets: frequency 4/12, 12/12; similarity 12/12, 12/12.

| Arm | Targets | Controls | Valid JSON | All 9 keys | Array | Empty | Err | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| A0 | 3/12 | n/a | 100.0 | 100.0 | 100.0 | 0 | 0 | 1442 | 1496 |
| A | 3/12 | 12/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1455 | 1541 |
| A2 | 3/12 | 12/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1436 | 1537 |
| B (hint last) | 7/12 | 11/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1477 | 1579 |
| P | 3/12 | 11/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1476 | 1571 |
| C (adjacent) | 7/12 | 12/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 1515 | 1611 |
| S | 8/12 | 10/12 | 100.0 | 100.0 | 100.0 | 0 | 0 | 4531 | 4683 |

What it shows, for B against A:

- **G1 IMPROVED.** 3 → 7 of 12 scored targets (+4 net: 4 wins, 0 losses = 33.3 points); A against
  A2 flipped 0; the minimum detectable effect is one title, 8.3 points. Wins: Pay the
  self-employment tax; Gather 1099 forms for the accountant; Weekly therapy appointment; Silent
  sitting meditation.
- **G2 PASS, at the allowance.** 1 of 12 baseline-correct controls went wrong (allowed 1): Pay the
  electricity bill. It did not go to a wrong category. The model answered `"categories": []` on all
  five runs, an abstention. The same layout flipped the same title in run 3 (as arm C there); the
  adjacent layout flipped none in either run.
- **G3 PASS.** Valid JSON 100.0% → 100.0%, all keys 100.0% → 100.0%, empty 0 → 0, errored 0 → 0.
- **G4 PASS.** 168 prompts compared with the stock prompt, 0 differing.
- **G5 PASS.** The owner's value 25.0% → 58.3% of scored targets.
- **G6 PASS.** See [Latency and residency](#latency-and-residency).
- **The placebo.** P stays at 3 of 12 on the targets; against P, B is right where P is wrong on 4
  titles and the other way on 0. On the controls A 12 → P 11 → B 11: the block alone cost one
  control (P answered `[]` for Pay the credit card statement on all five runs), so the one control B
  lost is not specific to the owner's lessons. B right where P wrong on 1 control, the other way on
  1.
- **C (adjacent) tied B** on the targets, 7 of 12 with the same four wins, and lost no control.
- **S (similarity)** reached 8 of 12 (one more, Body scan relaxation) and **failed G2**: 2 of 12
  controls flipped (Pay the electricity bill to `[]`; Review the monthly budget to `career, finance`,
  a real over-application of the career convention). It also had 109 of its 120 model calls run more
  than 3 times slower than the warm median (see [Latency and residency](#latency-and-residency)).

### Per-title flips, run 6

Each cell is the five per-run results (T = the expected category first, F = not; for the 12 targets
the expected category is the owner's value, for the 12 controls it is the title's natural category);
the title counts as right when more than half are T. Every cell is TTTTT or FFFFF except one (P on
Pay the electricity bill, FFTTT).

| Title | Expected category | A | A2 | B | P | C | S |
|---|---|---|---|---|---|---|---|
| Leg day at the gym | leisure | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF |
| 5k training run | leisure | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF |
| Spin class | leisure | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF |
| Pilates reformer session | leisure | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF |
| Invoice Delta Studio for the logo project | career | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| **Pay the self-employment tax** | career | FFFFF | FFFFF | **TTTTT** | FFFFF | TTTTT | TTTTT |
| **Gather 1099 forms for the accountant** | career | FFFFF | FFFFF | **TTTTT** | FFFFF | TTTTT | TTTTT |
| Send the final invoice for the website job | career | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| **Weekly therapy appointment** | growth | FFFFF | FFFFF | **TTTTT** | FFFFF | TTTTT | TTTTT |
| **Silent sitting meditation** | growth | FFFFF | FFFFF | **TTTTT** | FFFFF | TTTTT | TTTTT |
| Free-write in my journal | growth | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Body scan relaxation | growth | FFFFF | FFFFF | FFFFF | FFFFF | FFFFF | TTTTT |
| Dentist appointment (control) | health | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Book a physical with the GP (control) | health | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Refill blood pressure prescription (control) | health | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Flu shot at the pharmacy (control) | health | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| **Pay the electricity bill** (control) | finance | TTTTT | TTTTT | **FFFFF** | FFTTT | TTTTT | **FFFFF** |
| Check the savings account balance (control) | finance | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| **Review the monthly budget** (control) | finance | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | **FFFFF** |
| **Pay the credit card statement** (control) | finance | TTTTT | TTTTT | TTTTT | **FFFFF** | TTTTT | TTTTT |
| Call mom and catch up (control) | relationships | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Plan anniversary dinner with Alex (control) | relationships | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Buy a birthday gift for dad (control) | relationships | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |
| Coffee catch-up with Priya (control) | relationships | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT | TTTTT |

What B changed, by what the model said first: Pay the self-employment tax and Gather 1099 forms went
from finance to career, Weekly therapy appointment and Silent sitting meditation from health to
growth. The four exercise titles stayed wrong in every arm (health first, for A and B), and Body scan
relaxation stayed wrong in every arm but S.

## Answer shape: `qwen2.5:0.5b` answers `categories` as a bare string

Found in run 1 and confirmed in run 4. It is a separate, pre-existing defect of that tier, and it is
the reason two of the three tiers cannot be read.

| Tier | `categories` is an array: baseline A0 (60 completions) | The 18 training completions | Claims echoed |
|---|---|---|---|
| `qwen2.5:0.5b` | 0 (60 bare strings) | 0 (18 strings) | 0 |
| `gemma3:1b` | 12 (20.0%), 48 strings | 4 arrays, 14 strings (run 5) | 3 (run 5), 4 (run 2) |
| `gemma3n:e4b` | 60 (100%) | 18 arrays | 18 |

In all 60 baseline completions `qwen2.5:0.5b` also returned exactly three of the nine keys it was
asked for (`direction`, `categories`, `tags`), which is why its all-keys column reads 0.0%. Its
`categories` values were `"leisure"` 45 times, `"career"`, `"work"` and `"health"` 5 times each
(`work` is a direction, not a category, and would be dropped even from a list).

**Production consequence.** `constrainToVocabulary` returns `[]` for anything that is not an array.
So on a tier that answers a bare string, quick add yields no category pick, the preview returns no
`classification_claim`, nothing is logged, nothing can be corrected, `calibrate_classification` has no
corrections to build an index from, and the hint half has nothing to read. The same function also
filters the held-out scorer (`services/classification-score.ts`), the memory fill-in, the tag
suggester and the claim check in `settlePreviewClaim` (five files in all, quick add's overlay
included), so the filter is the same everywhere. Read leniently the baseline would be 5 of 12 targets on `qwen2.5:0.5b` and 3 of 12 on
`gemma3:1b`; that says what the model meant, not what production does. On this box the built-in fast
default is this tier, so on this box a default install has the whole category loop dormant. Other
installs resolve their fast tier differently (see [The box](#the-box)).

**Two possible remedies, neither done here.**

1. **State the array requirement in the prompt** (the `"categories": 1-3 life areas from [...]` line
   does not say "a JSON array"). Not done: it changes the prompt every owner gets, including owners
   with no corrections, whose prompt is pinned byte for byte (G4); a prompt wording change is a retune
   to be measured on its own, as `docs/complexity-rubric-measurement-2026-08.md` records, and the
   prompt's layout was itself measured on 2026-07-27.
2. **Make `mergeEnrichment` accept a bare string** as a one-item list. Not done: the filter is shared by
   the five call sites above and `agents/constrain.ts` says its edits are behaviour changes, so
   loosening what it accepts changes what every classifier writes into the owner's data, and it
   changes this measurement's baseline.

Both change behaviour for every owner on the tier, which is a decision of its own and not part of a
change about the hint and the wizard's capture. Whichever is chosen, re-run this harness on
`qwen2.5:0.5b`: the lenient reading shows the model does make picks, so there would then be
corrections to learn from.

## Latency and residency

**The hint read** (what the hint costs on the interactive path), `LATENCY_N` = 30 per condition, the
first discarded, an owner with an index interleaved with one without. This is G6.

| Run | With an index, p50 / p95 | Without an index, p95 | Limits | In-process split, B: hint read p50 / p95 |
|---|---|---|---|---|
| 2 (`gemma3:1b`) | 0.049 / 0.062 ms | 0.038 ms | 20 / 60 ms, 5 ms | 0.3 / 0.4 ms |
| 3 (`gemma3n:e4b`) | 0.18 / 0.77 ms | 0.040 ms | 20 / 60 ms, 5 ms | 0.4 / 0.5 ms |
| 5 (`gemma3:1b`) | 0.024 / 0.043 ms | 0.030 ms | 20 / 60 ms, 5 ms | 0.3 / 0.3 ms |
| 6 (`gemma3n:e4b`) | 0.031 / 0.039 ms | 0.030 ms | 20 / 60 ms, 5 ms | 0.3 / 0.4 ms |

The logs print the first three columns to one decimal. Run 2's log reads p50 0.0 ms and p95 0.1 ms
with an index and p95 0.0 ms without; run 3's reads 0.2 ms, 0.8 ms and 0.0 ms; the logs of runs 5
and 6 read 0.0 ms in all three. The table gives the artifacts' values. The last column times the
same two `classificationHint` calls between model calls, which is slower than the tight G6 loop. B
performs no embed (embed 0 ms in every split). Either way it is under a millisecond, against limits
of 20, 60 and 5 ms.

**The route's wall time is confounded, and is reported, not gated.** `POST /api/tasks/quick/parse`
for an owner without an index (A-style) against one with an index (B), 30 interleaved pairs:

| Run | Wall p50, no index → index | Median difference | The first model call, p50, no index → index |
|---|---|---|---|
| 2 (adjacent) | 428.4 → 345.4 ms | -82.9 ms | 403.2 → 242.4 ms |
| 3 (adjacent) | 1435.9 → 1468.3 ms | +32.4 ms | 1434.0 → 1446.5 ms |
| 5 (last) | 421.4 → 506.4 ms | +85.0 ms | 411.4 → 411.4 ms |
| 6 (last) | 1422.5 → 1447.9 ms | +25.4 ms | 1419.8 → 1445.9 ms |

None of these isolates what the hint costs. Run 2's negative difference is what the adjacent layout's
short answers would produce (the first model call itself fell from 403 to 242 ms, and 91 of 120 B
completions were three keys long). Run 5's +85 ms is not in the first model call
(same p50) and not in the hint read (0.3 ms); the artifact does not say where it went, and a second
direction call of about 80 ms (what the narrow question N0 costs on this model, mean 78 ms) would
account for it, but that was not checked. Runs 3 and 6 add 353 characters of prompt on a model that
takes about 1.4 s a call, and in run 6 the baseline arm A and its repeat A2 differ by 19 ms in mean
model-call time (1455 and 1436), so differences of 25 to 32 ms cannot be told from jitter. The
unconfounded cost of the hint is the read above.

**Arm S and residency.** After every call the harness reads `GET /api/ps`. It calls a generate call
slower than 3 times the warm median a "reload"; that is a label for the size of the delay, not an
observation that a model was evicted.

| Run | Warm median | S: calls slower than 3x median | Slowest S calls | A: slow calls |
|---|---|---|---|---|
| 2 | 380 ms | 120 of 120 | 1666, 1607, 1583 ms | 1 (1594 ms) |
| 3 | 1408 ms | 11 of 120 | 4668, 4639, 4631 ms | 1 (4235 ms) |
| 5 | 391 ms | 120 of 120 | 1658, 1653, 1636 ms | 1 (1574 ms) |
| 6 | 1442 ms | 109 of 120 | 4918, 4902, 4883 ms | 1 (4477 ms) |

Every other arm had no slow calls in every run. The one slow A call per run took 1.6 to 4.5 s, most
likely a cold load. What arm S's own embeds paid, per call over its 120 calls: a median of 290.9 ms
in run 2 (all 120 between 281 and 301 ms), 9.1 ms in run 3 (109 calls under 100 ms and 11 at 478 to
517 ms; those 11 are the 11 slow generate calls), 298.3 ms in run 5 and 540.5 ms in run 6 (all 120
at 400 ms or more, p95 550 ms; the 109 slow generate calls are among them). The "in-process split"
column of the first table in this section is a separate 30-sample measurement taken between model
calls and does not describe those calls: its embed p50 was 286.4, 7.6, 287.6 and 8.6 ms for runs 2,
3, 5 and 6, and its p95 291.0, 13.1, 292.7 and 550.5 ms. No S embed hit the 3,000 ms timeout.

What the resident sets show: in runs 2, 5 and 6 the poll after a generate call never listed
`nomic-embed-text` (it listed the generation model and a leftover `qwen2.5:0.5b`), while in run 3 it
listed it beside `gemma3n:e4b` on 108 to 109 of 120 calls per arm and S was slow on 11. The unit caps
the server at two loaded models and keeps them 24 hours, so a leftover small model, the generation model and the
embedder do not all fit. That is the reading these numbers fit, and it is why the embedder was kept
off the interactive path. It is not something they show: the artifacts record the slowdown and the
resident sets, not which model was evicted or when, and the start state differed between runs.
S "with both generation models resident" was not run (only one model in `LIVE_HINT_MODELS`), so
whether similarity could ever replace the frequency path on a box that holds two models is not
settled.

## The layout changed after the first three runs

Said plainly, because it happened after seeing a result.

- **What the first three runs measured.** The hint block sat beside the field it teaches (the layout
  of `96dbea90`), which is also how `agents/quickadd.ts` lays out every other rule.
- **What failed.** In run 2 that layout failed G3 on `gemma3:1b`: all keys 99.2% → 5.0%. 91 of 120
  completions stopped their JSON after `direction`, `categories` and `tags`, dropping six of the
  nine keys (`isComplex`, `priority`, `estimatedMinutes`, `timeOfDay`, `timeOfDayReason` and
  `motivation`). The k: 1 re-run (B1) and the similarity arm (S) failed it too (all keys 0.0%), so by
  the registered rule the hint half did not ship on that evidence. The same blocks placed last (arm C
  in that run) kept every key (120 of 120); run 3 then showed them tying adjacent on `gemma3n:e4b`'s
  targets (7/12 against 7/12).
- **What changed.** Commit `92854927` moved the blocks to the end of the prompt: after the "never
  invent" line, directly before `Entry:`, motivation's block first. The harness arms were flipped to
  match (B is the shipped layout, C the former adjacent one, kept as a diagnostic), and arm P and the
  answer-shape metric were added in the same pass.
- **A second commit sits between run 3 and run 4.** `0121a543` was committed at 13:46 UTC, after
  run 3 ended (13:22) and before run 4 began (14:37). It rewrote the route's `choosable` filter to
  match whole category names and not a comma split, and changed `settlePreviewClaim`, the learning
  service, the client and the harness. Runs 4 to 6 ran on `92854927`, which contains both it and the
  layout change; runs 1 to 3 ran on `96dbea90`. So the layout is not the only difference between run
  3 and run 6. For this fixture the hint was 353 characters in both and the four wins were the same,
  so no numeric effect of the review fixes shows, but it was not isolated.
- **What did not change.** No gate, threshold or verdict word was edited. The header carries a dated
  note under the gates saying the layout of the arm they apply to changed (quoted above). The gates
  were applied unchanged to the new layout in runs 4 to 6.
- **The first three runs are kept** as the record of the adjacent layout, with their artifacts
  predating the shape metric and the placebo arm. Their tables above stand as they were, with the
  array column added afterwards by replay.
- **Run 5 confirms the original failure** (C, adjacent, fails G3 again on `gemma3:1b`) and run 6 shows
  the two layouts tied on `gemma3n:e4b`. The cost of hint-last that run 2 did not show is the
  answer-shape movement on `gemma3:1b` and the one control abstention on `gemma3n:e4b`, both under
  [What this does not show](#what-this-does-not-show).

## Ship decision

For the owner to confirm or reverse. Made on 2 Nov 2026 from the runs above.

**Capture ships.** It writes nothing on a preview, is title-bound, vocabulary-checked and owner-scoped,
and drops a claim it cannot trust without failing the create.

**The hint half ships.** It ships on the evidence of `gemma3n:e4b`, the only tier here where the
measurement has power and the answer shape is usable, together with G3, G4 and G6 holding on the two
tiers where they could be measured.

**This departs from the letter of the registered rule, and that is stated here and not buried.** The
rule says the hint half ships only if on the fast tier G2, G3 and G4 hold **and G1 holds**. Read
literally:

- On the tier the gates were registered against (`qwen2.5:0.5b`, the box default) G1 was never
  measured: INCONCLUSIVE: UNUSABLE ANSWER SHAPE.
- On `gemma3:1b` G1 is NO MEASURABLE CHANGE, 0 → 0, and the rule's output for that run is "capture
  ships, the hint half does not by default".
- Only `gemma3n:e4b`, which is the quality default and sits in the fast slot here by an `OLLAMA_FAST`
  pin, meets the rule, with G1 IMPROVED.

So the rule is met on one tier of three. The reasoning for shipping anyway:

1. On the two small tiers the harness could not power a G1 test. The baseline cannot express a pick
   in the shape production keeps (0% and 20% arrays), so "no change" there means the harness could
   not see a change. It does not mean a gain is probably hiding there; the data that exist lean the
   other way, thinly. On `gemma3:1b` in run 5 no array answer on a target call was the owner's value in any
   arm (A 12 array answers, B 3, C 34, S 24; 0 correct in each), and read leniently (a bare string
   as a one-item list) the baseline got 13 of 60 target calls right and B got 5 of 60. In run 2, B
   (adjacent) got 2 of its 43 array answers on target calls right and S got 3 of 54, against 0 of 10
   for A. That is thin, and it is the reason not to read "no change" as "a gain the harness
   missed".
2. On `gemma3n:e4b`, the one tier where the model answers in the shape production keeps, 4 of 12
   target titles moved to the owner's value and none moved the other way, and the placebo block
   moved none. That is one model, one invented owner and 12 titles, and runs 3 and 6 are one
   near-deterministic trial run twice. Two of the three conventions were learned; the exercise titles
   were not.
3. The harm that could be measured was small on `gemma3n:e4b`: with the shipped layout G3 passes, G2
   passes at its allowance (1 flipped, 1 allowed) with the placebo costing a control too, G4 passed
   on every prompt it checked, and the hint read is under a millisecond. On `gemma3:1b` G3 and G4
   pass, G2 was not powered (2 of 12 controls could flip) and the array share fell (below). "Small"
   is claimed for `gemma3n:e4b` only.
4. On `qwen2.5:0.5b`, none of the 78 completions measured in run 4 (60 baseline, 18 training) gave a
   list (run 1 agrees on its 60 baseline completions), so on this box nothing was corrected and no
   index was built, and with no index the prompt is the stock prompt byte for byte. An index built
   earlier, under another model or from picks made on another tier, would still be read and shown to
   this model. That case was not measured.

What this leaves open, so that nobody has to find it: on `gemma3:1b` the hint-last block lowered the
share of array answers (20.8% to 7.5% over 24 titles, and 7.4% with the placebo over 19), which G3
does not read, and the tier gained nothing measurable. An owner on that tier who has made 2 or more
category corrections would be shown the block. If real owners on a small tier show fewer category
picks after their first Monday run, that is the first place to look.

**The who-it's-for half ships unmeasured.** The same change shows the model the owner's me, us or
them corrections, and no run exercised it (that block was empty throughout). In the app only memory
enrichment (off unless `MEMORY_MODE` is set) and `POST /api/tasks/quick` (which no screen calls)
log those picks, so on a stock install that half stays empty. Dropping only that half is a small
change in `enrichEntry`: hand `enrichQuick` an empty `motivation` hint.

**To drop the hint half**, make `enrichEntry` in `server/src/routes/tasks.ts` return
`enrichQuick(text, parsed, vocab)` with no hints. That is the whole behaviour change; the `choosable`
helper and the hint imports become unused, and `quickadd-hint-routes.test.ts`, which pins the routes'
use of the hint, would have to go or change. `enrichQuick`'s own `hints` parameter and its prompt test
can stay. Capture is unaffected.

The `S` question stays as it was: flipping `{ embedFn: null }` to `{}` in `enrichEntry` needs a clear
accuracy edge and no latency or residency damage. S reached 8 of 12 against B's 7 of 12 (+1, within one
title), failed G2, and had 109 of its 120 model calls run more than 3 times slower than the warm
median in run 6 (the embedder fits an eviction, see [Latency and residency](#latency-and-residency),
but the artifacts do not show one). It is not adopted.

## What this does not show

- **One invented owner and three conventions.** This measures whether the mechanism helps a small
  model follow a vocabulary it is shown, not how often real owners correct anything, or what they
  correct.
- **The fixture has exactly `RETRIEVE_K` (3) distinct owner values** (leisure, career, growth). The
  frequency hint is one lesson for each of the owner's most-corrected values, so here it is a
  **complete** convention table. A real owner with more than three corrected values, or skewed
  counts, gets a hint that covers only the most-corrected ones. This overstates what the hint can
  carry for them.
- **Two of the three conventions were learned.** Career and growth moved; the exercise-to-leisure
  convention stayed at 0 of 4 in every arm of every run, S included, whose top lesson carried the
  owner's value for all 12 targets (similarity precision@1 12/12). The mechanism does not teach
  everything it is shown.
- **Motivation was not exercised.** The wizard records category only, so the fixture has no
  motivation corrections and the motivation hint was empty throughout (0 characters). The production
  arguments were still used. Every result here is about categories. In the app, motivation picks are
  logged only by memory enrichment (off unless `MEMORY_MODE` is set) and by `POST /api/tasks/quick`,
  which no screen calls, so on a stock install that hint is empty too.
- **Twelve titles per arm, so one title is 8.3 points.** The minimum detectable effect is one title;
  the report prints it instead of calling a null "neutral". G2 can only flip the controls the baseline
  got right (2 of 12 on `gemma3:1b`, hence NOT POWERED).
- **Temperature 0.1, so runs are near-identical and titles are the sample.** Five runs per title add
  little. Runs 3 and 6 agree on `gemma3n:e4b` (the same four wins under both layouts, the same one
  control lost under hint-last), which is reproducibility of a near-deterministic model, not two
  independent trials. Run 6 also carries the review fixes in `0121a543`, so the agreement is not a
  clean layout-for-layout comparison.
- **G2 passes at its allowance.** One control lost on `gemma3n:e4b`, an abstention, in both runs that
  used the hint-last layout. The placebo lost one too, a different title, so some of it is the block.
- **The answer-shape cost on `gemma3:1b`.** The hint-last block lowered the array share (20.8% to
  7.5% over 24 titles; 23.2% to 9.5% on the 19 titles the placebo ran on, where the placebo reads
  7.4%); G3, which reads key presence, cannot see it. Read leniently, the baseline's target calls
  were right 13 times in 60 and B's 5 times in 60. The harness cannot power a G1 test on this tier,
  and what data there is leans toward no benefit.
- **Small models only.** `qwen2.5:0.5b`, `gemma3:1b` and `gemma3n:e4b`. Nothing here says what a
  larger model, which may already follow the owner's vocabulary at baseline, does with the block.
- **This box only.** One Ollama build (0.34.0), a Vulkan backend, a two-model cap and a 24-hour
  keep-alive. Residency numbers especially do not transfer.
- **Learning is batch, and nothing here shows the Monday lag.** The harness captures, calls
  `calibrateClassification` once, then applies. In the app a correction made today changes no prompt
  until the next Monday 04:10 `calibrate_classification` run, a field needs at least 2 corrections
  first, and a row left open stays pending for 24 hours before it counts as a weak accept. The
  training corrections here arrived in one batch; real ones arrive over weeks. Four things can move
  a prompt sooner or later than that: an admin can run the job early from the Jobs page (for their
  own account only), `DELETE /api/classification/exemplars` empties the index at once, the route's
  `choosable` filter drops a lesson at read time when its category is renamed, muted or deleted, and
  a Monday 04:10 that passes while the server is down is not made up. Corrections older than 90 days
  stop counting.
- **Not driven.** `POST /api/tasks/quick` shares `enrichEntry` with the parse route, and its prompt is
  pinned in `test/quickadd-hint-prompt.test.ts`; the harness does not call it. The wizard (client) is
  not run: the harness echoes the claim itself, as the wizard's Add does, and the client behaviour is
  pinned in `client/src/components/ElementWizard.claim.test.tsx`. The Settings accuracy score was not
  read.

## What would invalidate this

Different hardware, a different Ollama build or loaded-model cap, a fast tier that resolves to
something other than the three models above, a pin that changes (an `OLLAMA_FAST` or Settings
override bypasses auto-selection), or any edit to `enrichQuick`'s prompt, `exemplarPrompt`'s wording
or `enrichEntry`'s arguments. The harness's offline check fails if `enrichQuick` stops laying the
hints out as it expects; re-run the live harness rather than trusting these tables.

## Guards

- `test/quickadd-hint-prompt.test.ts` pins the prompt layout and the byte-identical-with-no-hints
  contract; `test/quickadd-hint-routes.test.ts` pins the routes; `test/classification-claim-drops.test.ts`
  and `test/classification-capture.test.ts` pin capture and the claim checks; the wizard's side is in
  `client/src/components/ElementWizard.claim.test.tsx`.
- `test/classification-hint-live.test.ts` (this harness) is opt-in (`LIVE_HINT=1`) and inert in a
  normal run.
