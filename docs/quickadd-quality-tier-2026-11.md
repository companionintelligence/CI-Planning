# Quick add on the quality model: the measurement (2 Nov 2026)

Follow-up to [classification-shape-fix-2026-11.md](classification-shape-fix-2026-11.md). That one made the
built-in fast model's category answer *usable* and found it was not *good*: `qwen2.5:0.5b` named the right
category on 20 of 60 answers for obvious titles and returned 3 of the 9 fields it was asked for, so the Add
dialog's Describe-it line came pre-filled with a category that was mostly wrong. The owner's position: do
not use a model that small if the results are not good, use the best available. This measures the narrow
form of that: quick add's classification asks the **quality tier** (`gemma3n:e4b` by default, which a
default install already pulls) instead of the fast tier. Not the whole fast tier: see "What it moves".

## Result in brief

- **The change is recommended by the rule registered before the run (D1).** R1 (quality), R2 (latency) and R3
  (residency) all pass. The gates and the rule were committed (`3fcbb5d1`) before the first live run.
- **Quality.** Through the app's own parse route, 210 calls: a category on 100%, the right one on the 12
  obvious titles on **60 of 60** (the fast tier: 20 of 60), all nine keys on 100% (fast: 0%, it returns
  three), a valid direction on 93.3% (fast: 100%; see below).
- **Speed is the price.** The Describe-it preview's route took a median **1.4 to 1.8 s** (two runs of the
  same arm), p95 2.0 to 2.4 s, max 3.0 s, against **0.09 s** with the fast tier. The first call after the
  model was unloaded took **5.0 to 5.1 s** (3 trials). On a default Ollama the model is unloaded after 5
  minutes idle, so that is what the first quick add after a quiet spell pays.
- **On a server with two model slots the cost spreads to the other calls.** R3, as registered, counts quick
  add's own calls only and passes (1 of 20). The same probe shows the other two models paying for it: see
  "Residency". That is a finding outside the gate and it is stated as one.
- **Not measured, and a risk:** if `gemma3n:e4b` is not installed, the app's quality tier resolves to the
  largest installed model. On this box that would be `qwen3-coder:30b`. Quick add would then run on a 30B
  model with a 15 s ceiling. Installs that follow the compose file have `gemma3n:e4b`.

## What it moves, and what it does not

`server/src/agents/quickadd.ts` passes `tier: 'quality'` on both of its `generateJson` calls (the overlay
call and the single-field direction retry). The purpose, `classify`, is unchanged, so the temperature (0.1)
and the 15 s ceiling are what they were; the prompt is byte for byte what it was. `CALL_POLICY.classify` is
still the fast tier for every other caller (the tag suggester, the motivation pass, the Monday scorer). I
did not move the fast tier's default: planning's generator (`plan_generate`, fast) must not be its own
judge (`plan_judge`, quality), and every fast-tier call would get about 15 times slower. Tests:
`server/test/quickadd-tier.test.ts` pins the tier on both calls, that the purpose's numbers are unchanged,
and that the other rows are as they were (`llm-call-policy.test.ts` pins every row).

## What was measured

Written into the header of `server/test/classification-shape-live.test.ts` and committed before the run;
the code is the authority.

| | |
|---|---|
| Fixture | The same invented owner and 42 titles as the shape measurement: 18 training, 12 target, 12 control ("obvious") titles |
| Route | The real `POST /api/tasks/quick/parse`, owner with no corrections, **no model injected**: the app resolved its own tiers, asserted to be `qwen2.5:0.5b` (fast) and `gemma3n:e4b` (quality) |
| B | BEFORE: the seam forces tier `fast` on every call, which is what production sent before this change. 42 titles x 5 runs |
| Q | AFTER: the shipped code, untouched (tier `quality`). 42 x 5 |
| Q2 | A repeat of Q: the noise floor |
| COLD | 3 trials: unload `gemma3n:e4b` (`keep_alive` 0, then wait for `/api/ps` to stop listing it), then one route call. The unload is the only thing done to the server |
| MIX | 20 cycles of [a route parse] [one fast-tier `generateJson`, purpose `brainstorm`, a two-line prompt] [one embed]: a quick add, then a subtask suggestion and a dedupe embedding. `/api/ps` read after every call |

The blocks ran in sequence, not interleaved, so each block saw its own model warm.

Gates, as registered (`TIER_GATES`), on arm Q; B is reported beside it and never gated:

- **R1 quality:** a category on at least 95% of calls; the right first category on at least 90% of the
  obvious-title calls; all nine keys on at least 90%; a valid direction on at least 90%.
- **R2 latency:** warm route p50 at most 2,500 ms and p95 at most 5,000 ms, every call ran the model
  overlay (`llm` true); cold: each of the 3 first calls after an unload ran it inside the 15 s ceiling.
- **R3 residency:** in MIX at most 10% of the route calls take longer than 3 x Q's warm median, and every
  one ran the overlay.
- **Rule:** R1 and R2 hold, recommend; R1 or R2 fails, do not; R3 failing with the other two holding is
  still a recommendation, with the swap stated.

The numeric thresholds are my judgement (a third of the 15 s ceiling for p95; 2.5 s for a preview a person
is watching), registered before the run, and the owner may weigh them differently.

## The run (14 minutes, 2 Nov 2026 16:05 to 16:19 PST)

Ollama 0.34.0; the service up since 1 Nov 13:31 PST with `OLLAMA_MAX_LOADED_MODELS=2`,
`OLLAMA_NUM_PARALLEL=2`, `OLLAMA_KEEP_ALIVE=24h` and the other settings recorded in the shape-fix doc
(read again before the run). Node v26.3.0, vitest 4.1.8. `violations: []`. Resident at the start:
`qwen2.5:0.5b` and `nomic-embed-text`.

| Arm | Calls | Category returned | Right on the 12 obvious titles | All nine keys | Valid direction | Route wall p50 / p95 / max |
|---|---|---|---|---|---|---|
| B (fast, before) | 210 | 85.7% | 20 of 60 (33.3%) | 0.0% | 100.0% | 94 / 107 / 124 ms |
| Q (quality, after) | 210 | 100.0% | 60 of 60 | 100.0% | 93.3% | 1,430 / 1,990 / 2,401 ms |
| Q2 (Q again) | 210 | 100.0% | 60 of 60 | 100.0% | 92.9% | 1,839 / 2,367 / 3,006 ms |

- Q and Q2 differ in p50 by 29% (1,430 and 1,839 ms): that is this box's noise on this run, so read the
  latency as a range, not a point. The modal pick of one title of 42 differs between them.
- B's 85.7% counts the one-word reading shipped in #660; without it B would be 0%.
- The direction: with the quality model 14 of 210 answers put a category name in the direction field
  (`relationships` 9, `health` 5), which sends `enrichQuick` to its single-field retry. That retry added
  at most 0.4 s to any call (the largest route time beyond its first model call was 393 ms).
- On the 30 titles the owner files against a model's habit (the "convention" titles) Q's first pick was
  the owner's value on 36 of 150 calls. That is what learning from corrections is for, and with the hint
  half removed (#659) nothing feeds corrections back into quick add: the quality model gives better
  generic picks and does not learn the owner's rules.

| Gate | Registered | Read | |
|---|---|---|---|
| R1 quality | pick >= 95%, obvious >= 90%, keys >= 90%, direction >= 90% | 100.0%, 100.0%, 100.0%, 93.3% | **PASS** |
| R2 latency, warm | p50 <= 2,500 ms, p95 <= 5,000 ms, overlay on every call | 1,430 ms, 1,990 ms, 100.0% | **PASS** |
| R2 latency, cold | 3 first calls after an unload, overlay, <= 15,000 ms | 5,034, 5,089, 5,095 ms, all with the overlay | **PASS** |
| R3 residency | at most 10% of MIX route calls over 3 x 1,430 = 4,289 ms | 1 of 20 (5.0%), all with the overlay | **PASS** |
| R4 no collateral | unit tests | pass | **PASS** |

D1: recommended.

## Residency: what R3 did not look at

The mix probe cycles three models (quick add on `gemma3n:e4b`, the fast tier on `qwen2.5:0.5b`, the
embedder `nomic-embed-text`) through a server with two slots. `/api/ps` after each call shows what happened:
`gemma3n:e4b` stays in one slot; `qwen2.5:0.5b` and `nomic-embed-text` take turns in the other, each
loading when called and pushing the other out.

| Call in the cycle | n | median | p95 | max | What it costs warm |
|---|---|---|---|---|---|
| Quick add route (`MIX_Q`) | 20 | 1,724 ms | 2,483 ms | 5,441 ms | 1,430 to 1,839 ms (Q, Q2) |
| Fast-tier call (`MIX_F`) | 20 | 1,483 ms | 1,604 ms | 1,669 ms | about 94 ms (B's model call) |
| Embed (`MIX_E`) | 20 | 296 ms | 551 ms | 555 ms | 6 ms when already resident (cycle 10) |

- Quick add's own calls mostly stayed warm, which is what R3 counts. One did not: in cycle 10
  `gemma3n:e4b` itself was pushed out, and cycle 11's route call took 5,441 ms, which is a cold load.
- The other two calls paid for the slots instead: the fast-tier call about 16 times its warm time, the
  embed 50 to 90 times its resident time, on most cycles.
- This is a property of a two-slot server and of three models in rotation, and it is not new in kind: the
  quality tier was already used by briefings and the planning judge. What this change adds is a model that
  the interactive path needs, so it is in the rotation whenever someone adds a task. The compose file sets
  no `OLLAMA_MAX_LOADED_MODELS`, so Ollama's own default applies there; I did not check what that is for
  the compose image, and the 2 is a setting of this box. I did not measure any other box.

## What this does not show

- One box (an AMD Strix Halo, unified memory), one invented owner, 42 titles, temperature 0.1 (five runs
  per title are near-identical, so titles, not runs, are the sample). No typical laptop, no CPU-only box,
  no GPU with less memory, no concurrent users. `gemma3n:e4b` is a 7.5 GB model. On a slower machine 1.4
  to 1.8 s is longer, and the cold load is slower than 5 s.
- The quality of the fields other than category (priority, minutes, time of day, complexity, who-it's-for)
  was not scored: only that the model returns them. The fast model returned none of them, so any answer is
  an addition; it is not shown to be right.
- It is not a measurement of a real owner's titles or categories. The 60 of 60 is on 12 titles whose
  category is obvious by construction.
- The resolver case (no `gemma3n:e4b` installed, so the quality tier is the largest installed model) was read
  from the resolver on this box's model list, not run: with `gemma3n:e4b` it resolves to itself, without it
  to `qwen3-coder:30b`, and without both the fast tier also becomes `qwen3-coder:30b`.
- The Add dialog was not driven in a browser; the route it calls was.

## Decisions that are the owner's

1. **Is 1.4 to 1.8 s (5 s after the model idles out) acceptable for the preview?** The registered limits
   were mine. The preview is a spinner a person watches; before it was about a tenth of a second.
2. **A server with two model slots.** Keep, or set `OLLAMA_MAX_LOADED_MODELS` higher where the memory
   allows, or accept the reloads.
3. **An install whose quality tier is a much larger model than `gemma3n:e4b`.** Quick add inherits it. A
   size cap, or a fallback to the fast tier above some size, would prevent a 30B model answering a
   preview; it was not designed or measured.
4. **How to undo it:** delete `tier: QUICK_ADD_TIER` from the two calls (or set the constant to `'fast'`).
   The one-word reading from #660 stays for models that answer one word.

## How to reproduce

The artifact (`tier-run-1.json`, with its log) is not in the repository; it was kept in
`~/.cache/ci-planning-shape-fix/` on the machine that ran it. It records the commit it ran on
(`3fcbb5d1`), that no tracked file differed from it, and a hash of each source.

```
cd server
LIVE_TIER=1 LIVE_SHAPE_RUNS=5 LIVE_SHAPE_MODELS=qwen2.5:0.5b,gemma3n:e4b LIVE_SHAPE_OUT=<out>/tier-run-1.json \
  ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose
```

Do not pin `OLLAMA_FAST` or `OLLAMA_QUALITY`: the run asserts that the app resolved `qwen2.5:0.5b` and
`gemma3n:e4b` itself. Do not run the server test suite during it (it skews latency), and note that the
COLD trials unload `gemma3n:e4b` from the Ollama server (it loads again on the next call). The pure parts
(the rule on invented calls) run in every test run.
