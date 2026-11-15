# Is qwen2.5:3b the better quick-add model? A head-to-head with gemma3n:e4b (3 Nov 2026)

Follow-up to [quickadd-hint-guard-2026-11.md](quickadd-hint-guard-2026-11.md). Quick add asks `gemma3n:e4b`. In the
hint measurements `qwen2.5:3b` learned from corrections and was faster, so the owner asked whether it is the best
option. On 12 natural titles it had looked less accurate, with a valid direction less often, and the two had been a
title apart on the combined score. This is the bigger comparison, with the gates written down first. **It changes no
product behaviour**: the PR holds the harness and this report only.

## Result in brief

- **The rule registered before the run reads D2: `qwen2.5:3b` is faster, and not an improvement.** `gemma3n:e4b` stays the
  right default; `qwen2.5:3b` is at most an opt-in, and that is the owner's call.
- **Speed is real.** Through the real parse route, median **0.96 s against 1.54 s** (0.62 times), p95 1.44 s against
  2.22 s, and the first call after the model is unloaded **3.1 s against 7.1 s**. The direction retry does not eat it:
  `qwen2.5:3b` retries on 33% of calls at 141 ms each, 46 ms per call, against 9% at 329 ms each, 30 ms per call.
- **Accuracy is not close.** On 120 natural titles (20 per category, each with an obvious category, 6 runs each)
  `qwen2.5:3b` got **83 right (69%)** and `gemma3n:e4b` **108 (90%)**. The gate allowed 6 below. Both get health and
  career right every time; the gaps are leisure (7 of 20 against 16), relationships (11 against 20), finance (15
  against 20) and growth (10 against 12).
- **Its direction answer is unreliable, its category answer sometimes absent.** A valid direction on 67% of first
  answers against 91% (it puts a category name in the direction field: `leisure` 96 times, `health` 74, `career`
  48), and on 87 of 720 calls it returned an empty list for the category (13 of 20 leisure titles had none).
- **It learns more but ends behind.** On a second owner with new conventions, targets went **3 to 12 of 18**
  (`gemma3n:e4b`: 11 to 15) and controls 11 to 15 of 18 (17 to 17), so it gained more from a much lower start, and
  at 18 corrections it was right on **27 of 36 titles against 32**. The gate allowed 3 below.
- **Residency did not separate them reliably.** Under the registered rule `qwen2.5:3b` passes (0 of 20 mix-probe route
  calls over three warm medians) and the reference would fail (17 of 20) in this run, but the same probe on the
  reference passed 19 of 20 earlier that evening at lower load. This server is shared; read it as "a smaller model reloads
  faster" (3 s cold against 7 s), not as a pass or fail.

## What was measured

Written into the header of `server/test/quickadd-model-h2h-live.test.ts` and committed before the run (`8e8d4adc`);
the code is the authority. No model is injected: the app resolves quick add's model itself. `gemma3n:e4b` ran on the
default path with no override anywhere; `qwen2.5:3b` was set as the owner's quality-tier model in Settings (how quick
add would be given it today), and the run asserted the app resolved it. The fast tier resolved to `qwen2.5:0.5b`.

| Phase | What |
|---|---|
| A, natural | 120 invented titles, 20 per category, an obvious category each (a dentist is health, an electricity bill is finance), no corrections and so no hint, x 6 runs, through `POST /api/tasks/quick/parse`. Scored by title: right when a strict majority of its 6 runs name the expected category first. Per call: the route's wall time, the first model call's time, how many model calls the route made (two is the direction retry), all nine keys, a valid direction |
| C, cold | 3 trials: unload the model (`keep_alive` 0, wait for `/api/ps` to drop it), then one route call |
| M, mix | 20 cycles of [a route parse] [a fast-tier call] [an embed], on a server with `OLLAMA_MAX_LOADED_MODELS=2` |
| B, learning | A second owner whose conventions the earlier measurements never used: reading and podcasts go to growth (not leisure), volunteering and charity to relationships, cooking and meal prep to health. 18 training titles, levels 0, 3, 6, 9, 12 and 18 corrections, 18 target and 18 control titles x 3 runs at each level, a noise pass at the end. Controls are natural career, finance and leisure titles |

Gates (`H2H_GATES`), the candidate being `qwen2.5:3b` and the reference `gemma3n:e4b`:

- **H1 accuracy:** right on at least the reference's count minus 6 of the 120 titles (inconclusive if a model's two
  halves of runs disagree on more than 8 titles).
- **H2 speed:** route p50 at most 0.75 of the reference's, and p95 no higher.
- **H3 direction:** valid-direction share at least the reference's minus 10 points.
- **H4 learning:** at least +3 of 18 targets from level 0 to 18, at most 2 controls lost, keys within 5 points and
  direction within 10, and at least the reference's count of 36 minus 3 at level 18.
- **H5 cold:** all three cold calls ran the model inside the 15 s ceiling and the median is no slower than the
  reference's.
- **H6 residency:** at most 10% of the mix route calls over three warm medians.
- **Rule:** D1 all six hold: recommended. D2 H2 holds and H1 or H4 does not: a speed-for-accuracy trade. D3 H2 does
  not hold: no reason to move. D4 otherwise, with the failing gates named.

### What happened to the run

The first run died in `qwen2.5:3b`'s mix probe: its fast-tier call hit the 20 s ceiling in the fourth cycle (the Ollama
server is shared and was loaded), the probe was not guarded, and the model's whole run threw. That left its natural
titles (720 calls) and cold starts complete, the mix at 4 of 20 cycles and the learning curve not run; the reference
had completed everything. A dated note under the gates records it. The probes now log a failure instead of throwing,
and `LIVE_H2H_RESUME=<artifact>` re-runs only the phases a model has not completed (a half-finished one is discarded).
**Every `qwen2.5:3b` number below except its mix probe and learning curve, and every `gemma3n:e4b` number, is from the
first run;** those two phases are from the resumed run, about an hour later. No gate, threshold or rule moved. The
decision does not depend on them: H1 and H3 failed on the natural titles alone.

## Results

| Gate | Registered | Read | |
|---|---|---|---|
| H1 accuracy | within 6 titles of the reference | 83 against 108 of 120 (halves moved 1 and 0 titles) | **FAIL** |
| H2 speed | p50 at most 0.75, p95 no higher | p50 957 against 1,535 ms (0.62), p95 1,439 against 2,215 ms | **PASS** |
| H3 direction | within 10 points | 67.2% against 90.8% | **FAIL** |
| H4 learning | +3 targets, at most 2 controls lost, within 3 titles of the reference | targets 3 to 12 (+9), controls 11 to 15, direction 75.0% to 77.8%; 27 of 36 against 32 | **FAIL** (5 titles below the reference) |
| H5 cold | inside the ceiling, median no slower | 3,366, 3,058, 3,065 ms against 7,159, 7,093, 6,527 ms | **PASS** |
| H6 residency | at most 10% of mix route calls slow | 0 of 20 (2.4 to 2.6 s against a 2.87 s limit) | **PASS**, but see below |

D2: faster, but H1 and H4 fail.

### Natural titles

| | Right of 120 | Health | Career | Relationships | Growth | Leisure | Finance | A category returned | Valid direction | All nine keys |
|---|---|---|---|---|---|---|---|---|---|---|
| `qwen2.5:3b` | 83 | 20 | 20 | 11 | 10 | 7 | 15 | 87.4% | 67.2% | 100% |
| `gemma3n:e4b` | 108 | 20 | 20 | 20 | 12 | 16 | 20 | 100.0% | 90.8% | 100% |

When `qwen2.5:3b` was wrong on a title it mostly said nothing (an empty list on 87 calls, 13 of the 20 leisure titles),
or `career` for growth titles (9 of 20), `health` or `leisure` for relationship titles, `career` for finance ones.
`gemma3n:e4b`'s misses were growth titles answered `career` (7) and four leisure titles answered `growth`; those are
the labels most open to argument, and the labels are my judgement of "obvious" (an ambiguous title moves both models
alike).

### Speed and the direction retry

| | Route p50 | p95 | First model call p50 | Retry on | Each | Per call |
|---|---|---|---|---|---|---|
| `qwen2.5:3b` | 957 ms | 1,439 ms | 916 ms | 32.8% of calls | 141 ms | 46 ms |
| `gemma3n:e4b` | 1,535 ms | 2,215 ms | 1,520 ms | 9.2% | 329 ms | 30 ms |

The retry is the narrow single-field direction question after a first answer whose direction names none of the owner's.
It is 3.6 times as common on `qwen2.5:3b` and less than half the cost each, and costs 16 ms more per call overall, so the
speed advantage stands as measured. The first-pass direction is still wrong a third of the time, which is a quality
problem the retry mostly repairs and hides.

### Learning on the second owner

Targets / controls right (of 18 each), by corrections:

| Model | 0 | 3 | 6 | 9 | 12 | 18 | 0 again | Route p50 at 18 |
|---|---|---|---|---|---|---|---|---|
| `qwen2.5:3b` | 3 / 11 | 10 / 10 | 12 / 13 | 11 / 13 | 11 / 13 | 12 / 15 | 3 / 11 | 865 ms |
| `gemma3n:e4b` | 11 / 17 | 16 / 17 | 16 / 17 | 17 / 17 | 16 / 16 | 15 / 17 | 11 / 17 | 1,376 ms |

- Both learn, as on the first owner, and most of it comes by the third correction. `qwen2.5:3b` gained more because
  it started far lower: by convention, reading 1 to 2 of 6, volunteering 0 to 4, cooking 2 to 6; `gemma3n:e4b` reading
  3 to 5, volunteering 4 to 4 (already right), cooking 4 to 6.
- `qwen2.5:3b`'s controls rose from 11 to 15 of 18, including four leisure titles (a film, the cinema, a series, video
  games) that it had answered with no category before. The hint's lessons put category names in front of it, and that
  may be doing more than teaching the owner's rules; this was not tested.
- It echoed a claim for 15 of 18 training titles and logged 8 corrections; `gemma3n:e4b` echoed all 18 and logged 12.
  The loop has less to learn from when the model abstains.

### Cold start and the mix

Cold: `qwen2.5:3b` 3.1 s (three trials 3.1 to 3.4 s) against `gemma3n:e4b` 6.5 to 7.2 s. (The reference's cold start
was 5.0 to 5.1 s in the earlier quality-tier run; the box was less loaded then, and 7 s is what it cost this time.)

Mix probe, the quick-add route call with a fast-tier call and an embed between each, on a two-slot server:

| | Route p50 / p95 / max | Over three warm medians | Fast-tier probe p50 (max) | Embed p50 |
|---|---|---|---|---|
| `qwen2.5:3b` | 2.43 / 2.59 / 2.62 s (2.5 times its warm p50) | 0 of 20 | 98 ms (934 ms) | 294 ms |
| `gemma3n:e4b` | 4.97 / 7.11 / 7.15 s (3.2 times) | 17 of 20 | 133 ms (2.04 s) | 614 ms |

Under the registered rule the candidate passes and the reference would fail. **That is not a stable difference.** The same
probe on the reference in the quality-tier run (that evening at 16:05 PST, lower load) had one route call of twenty over the
limit, a median of 1.7 s, and a fast-tier probe median of 1.5 s; here its route calls were reloading `gemma3n:e4b` on most
cycles. This server is shared with other sessions' models, so what stays resident depends on what else is loaded. What the
two runs do agree on: a 1.9 GB model costs about 1.5 s to reload and a 7.5 GB one about 4 to 5 s.

## How quick add could use a model other than the quality tier

The harness gave `qwen2.5:3b` to quick add the only way the app offers today: by making it the owner's quality-tier
model. That is not a good way to adopt it. What each route costs:

| Option | What it changes | What it costs |
|---|---|---|
| **A. Set the quality model to `qwen2.5:3b`** (what the harness did, `OLLAMA_QUALITY` or Settings) | Every quality-tier call: source extraction (`extract`), briefing narration (`narrate`), the planning judge (`plan_judge`), the voice paragraph surfaces (`render-copy.ts`), and quick add | The judge and the writers become a 3B model, none of it measured; the generator-is-not-the-judge split holds only because the fast tier is smaller still |
| **B. Pin the fast tier to `qwen2.5:3b` and send quick add back to it** | Every fast-tier call (tags, motivation, subtasks, `plan_generate`, rationales, voice lines, the Monday scorer's narrow question): 0.9 s a call where it was 0.1 s, and more accurate | A slower app everywhere to speed up one screen; unmeasured outside quick add |
| **C. A dedicated quick-add model setting** | A new `quick_add_model` on `scheduling_prefs` (a migration after `0172`, the entity and schema, the GraphQL pref, a Settings row), resolved as owner choice, then an env pin, then the quality tier. The hint guard would check this resolved name instead of the quality tier's | The least blast radius and the most work; a fourth model in rotation when it differs from the fast, quality and embedding models, which on a two-slot server means more reloads |
| **D. Leave it** | `gemma3n:e4b` for quick add, as now | The 1.5 s preview and a 7 s first call after an idle spell |

If the owner wants a faster option, C is the right shape and A and B are the wrong ones. This measurement does not
argue for building it: the faster model is 21 percentage points less accurate on natural titles, and it is a nearer call only
if the owner values the second saved (0.6 s a preview, 4 s on a cold start) over a pre-filled category that is wrong
three times in ten. If C is built, the guard (`modelUsesHint`) must read the resolved quick-add model, and the
allow-list already contains `qwen2.5:3b`.

## What this does not show

- One box (an AMD Strix Halo, unified memory), **shared with other sessions** (load average 4 to 19 during the runs; the cold
  start and mix numbers moved between this run and the earlier quality-tier run for that reason). Two invented owners, 120 + 36
  titles, temperature 0.1. Two models, not `gemma3:4b` or any other.
- The 120 labels are my judgement of "obvious". A relabelled title would move both models alike, so the comparison holds
  better than the absolute percentages.
- The quality of the fields other than category (priority, minutes, time of day, who-it's-for) was not scored.
- What changing the quality model does to extraction, narration and the planning judge was not measured; the table above
  says which calls would change.
- The mix probe is not reproducible on a shared server (above).
- A resumed run: `qwen2.5:3b`'s mix probe and learning curve ran about an hour after the rest.

## How to reproduce

The artifacts (`h2h-run-1-first.json` and `h2h-run-2.json` with their logs) are not in the repository; they were kept in
`~/.cache/ci-planning-shape-fix/`. They record the command, the Node and Ollama versions and the models resident at the start;
the commits were `8e8d4adc` for the first run and `6bc8d140` for the resume (from the git history, not recorded in them).

```
cd server
LIVE_H2H=1 LIVE_H2H_OUT=<out>/h2h-run-1.json \
  ./node_modules/.bin/vitest run test/quickadd-model-h2h-live.test.ts --reporter=verbose
# if a model's run dies part-way, resume it (the phases it finished are kept):
LIVE_H2H=1 LIVE_H2H_RESUME=<out>/h2h-run-1.json LIVE_H2H_OUT=<out>/h2h-run-2.json \
  ./node_modules/.bin/vitest run test/quickadd-model-h2h-live.test.ts --reporter=verbose
```

Do not pin `OLLAMA_FAST` or `OLLAMA_QUALITY`, and do not run the server test suite during it. `qwen2.5:3b` and
`gemma3n:e4b` must be installed. The first run took 55 minutes, the resume 12. The pure parts, the fixtures and the rule on
invented calls, run in every test run.
