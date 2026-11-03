# Does a small model learn from corrections? The quick-add hint's learning curve (2 Nov 2026)

Follow-up to [quickadd-quality-tier-2026-11.md](quickadd-quality-tier-2026-11.md). Quick add now asks the
quality model (`gemma3n:e4b`), which is accurate but 15 to 20 times slower than the fast model it replaced.
The owner asked whether the hint could come back so the model learns from corrections, and whether a smaller
model would eventually learn enough to be both faster and accurate. This measures that. **The hint is not in
`main`**: #659 removed it, and the run was made on a branch with that removal reverted
(`exp/hint-learning-curve`, commit `4b3c15b7`). This change adds the measurement and nothing else; it does not
bring the hint back.

## Result in brief

- **Three of the six models learn: `qwen2.5:3b`, `gemma3:4b` and `gemma3n:e4b`.** Each went up three target titles
  of twelve (5 to 8, 2 to 5, 3 to 6) without losing a control, and all of it came by the third correction. The other
  three were **harmed** by the hint, each in its own way (below). The rule registered before the run reads D1:
  those three learn.
- **Faster and accurate: `qwen2.5:3b`, narrowly.** With 18 corrections it was right on 19 of the 24 held-out titles
  against 15 for the quality model with no hint (what quick add does today) and 18 for the quality model with the
  hint, at a median 0.94 s against 1.5 to 2.0 s. The registered gate passes (D2). Three cautions, below: the speed
  margin does not survive a quieter reference (about 1.6 times faster, not 2), a one-title difference is 4 points,
  and before it has any corrections it is worse than the quality model on natural titles (9 of 12 against 12 of 12).
- **"Eventually" is not what the curve shows.** The gain arrives at the first level that has a hint and then stays
  flat or wobbles: 18 corrections are no better than 3 to 9. No model learned the exercise convention at all
  (`qwen2.5:3b`: one title of four). The hint carries at most three lessons, one per value the owner corrects most.
- **Size does not tell you whether a model can use the hint.** `llama3.2:3b` (3.2B) broke where `qwen2.5:3b` (3.1B)
  worked. A size bar would have let `llama3.2:3b` through and shut out `gemma3:1b`, which is among the best on natural
  titles without a hint (11 of 12, behind only the two models that scored 12).
- **The model does not learn; the prompt does.** Nothing here updates weights. The corrections change what the model
  is shown, and whether that helps depends on the model reading it.

## What was measured

Written into the header of `server/test/classification-shape-live.test.ts` and committed before the run
(`4b3c15b7`); the code is the authority.

| | |
|---|---|
| Models | `qwen2.5:0.5b` (the default fast model), `gemma3:1b`, `qwen2.5:3b`, `llama3.2:3b`, `gemma3:4b`, and the reference `gemma3n:e4b`. The three 3B and 4B models were pulled for this (1.9, 2.0 and 3.4 GB); none is thinking-capable. The model is injected into every call |
| Owner | The invented owner of the earlier measurements: six categories and three conventions (exercise to leisure, freelance invoices and tax to career, therapy and journaling to growth). Eighteen training titles, taken in an order that interleaves the conventions |
| Levels | 0, 3, 6, 9, 12 and 18 corrections. To reach a level the new training titles go through the real `POST /api/tasks/quick/parse` (the model's own pick, with the hint last week's index gives it), then `POST /api/tasks` with the owner's category and the claim echoed (the wizard's Add), then one `calibrateClassification` with no embedder: a compressed weekly cycle. The model's own misses are the corrections |
| Measure | At each level, the 12 held-out target titles and the 12 control titles x 3 runs through the real parse route, so the prompt is the one the route sends, hint included once the index holds at least 2 corrections. A title is right when a strict majority of its 3 runs name the owner's category first |
| Noise | After the top level the owner is reset to nothing learned and level 0 is measured again |

Gates, as registered (`LEARN_GATES`):

- **L1 learns:** targets right at 18 corrections minus at 0 is at least +2 titles (inconclusive if level 0 against its
  repeat moves more than 2).
- **L2 no over-application:** controls at 18 at least controls at 0 minus 1.
- **L3 schema safety:** all nine keys no more than 5 points down, valid direction no more than 10 points down.
- **L4 faster and accurate** (not for the reference): titles right of 24 at 18 corrections at least the reference's at 0
  corrections, and route p50 at most half of the reference's level-0 p50.
- **Rule:** D1 a model learns when L1 to L3 hold; D2 a model other than the reference is small and learned when it learns and
  L4 holds; D3 otherwise.

## The curves

Targets / controls right, of 12 each. No hint reaches the prompt before the index holds 2 corrections, so level 3 is
the first with one (for `qwen2.5:0.5b` and `llama3.2:3b` the index was still short at level 3).

| Model | 0 | 3 | 6 | 9 | 12 | 18 | 0 again |
|---|---|---|---|---|---|---|---|
| `qwen2.5:0.5b` | 5 / 4 | 5 / 4 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 5 / 4 |
| `gemma3:1b` | 2 / 11 | 0 / 12 | 2 / 11 | 0 / 11 | 1 / 12 | 0 / 11 | 3 / 9 |
| `qwen2.5:3b` | 5 / 9 | 7 / 10 | 8 / 11 | 8 / 10 | 6 / 10 | 8 / 11 | 5 / 9 |
| `llama3.2:3b` | 1 / 7 | 1 / 6 | 0 / 4 | 0 / 2 | 0 / 1 | 0 / 1 | 1 / 6 |
| `gemma3:4b` | 2 / 12 | 4 / 12 | 3 / 12 | 5 / 12 | 5 / 12 | 5 / 12 | 2 / 12 |
| `gemma3n:e4b` (reference) | 3 / 12 | 7 / 12 | 7 / 12 | 8 / 11 | 6 / 12 | 6 / 12 | 3 / 12 |

| Model | All nine keys, 0 to 18 | Valid direction, 0 to 18 | Route p50, 0 (its repeat) to 18, ms | Claims echoed of 18 | Corrections / indexed at 18 |
|---|---|---|---|---|---|
| `qwen2.5:0.5b` | 0.0% to 90.3% | 100.0% to 100.0% | 149 (131) to 307 | 10 | 6 / 5 |
| `gemma3:1b` | 100.0% to 100.0% | 58.3% to 41.7% | 504 (466) to 542 | 14 | 12 / 9 |
| `qwen2.5:3b` | 100.0% to 100.0% | 75.0% to 75.0% | 875 (867) to 937 | 17 | 9 / 7 |
| `llama3.2:3b` | 100.0% to 100.0% | 100.0% to 100.0% | 714 (691) to 720 | 6 | 5 / 4 |
| `gemma3:4b` | 100.0% to 100.0% | 100.0% to 100.0% | 1,646 (2,546) to 1,527 | 18 | 9 / 7 |
| `gemma3n:e4b` | 100.0% to 100.0% | 87.5% to 91.7% | 1,958 (1,694) to 1,487 | 18 | 13 / 10 |

What the rule read (the harness's own lines):

| Model | L1 | L2 | L3 | L4 | Result |
|---|---|---|---|---|---|
| `qwen2.5:0.5b` | FAIL (5 to 0) | FAIL (4 to 0) | PASS | FAIL (0 of 24) | harmed |
| `gemma3:1b` | FAIL (2 to 0) | PASS (11 to 11) | FAIL (direction 58 to 42) | FAIL (11 of 24) | harmed |
| `qwen2.5:3b` | PASS (5 to 8) | PASS (9 to 11) | PASS | **PASS** (19 of 24 against 15; 937 ms against 1,958) | learns; **small and learned (D2)** |
| `llama3.2:3b` | FAIL (1 to 0) | FAIL (7 to 1) | PASS | FAIL (1 of 24) | harmed |
| `gemma3:4b` | PASS (2 to 5) | PASS (12 to 12) | PASS | FAIL (17 of 24; 1,527 ms is not under half of 1,958) | learns, not faster |
| `gemma3n:e4b` | PASS (3 to 6) | PASS (12 to 12) | PASS | the reference | learns (18 of 24 at 18) |

### How the hint broke three models

- **`qwen2.5:0.5b`** answered `"categories": 1` (a number, as in "1-3 life areas") on 53 of 72 calls at level 18, so
  no pick, and with the hint it started returning nine keys instead of three. Only 10 of 18 training parses gave a
  claim, so the loop starved itself.
- **`gemma3:1b`** kept its picks on natural titles (11 of 12) but its valid direction fell from 58% to between 17% and
  42%, which sends more requests into the second, single-field direction call.
- **`llama3.2:3b`** answered `null` for the categories on 20 of 72 calls at level 18 and named none of the owner's
  categories on 58 of 72, controls 7 to 1, only 6 of 18 claims.

### What was learned

- On the three that learn, the gain is on **two of the three conventions**. `qwen2.5:3b`: growth 1 to 3 of 4, exercise 0
  to 1, career 4 of 4 before and after (it already filed freelance invoices under career). `gemma3:4b`: career 2 to 3,
  growth 0 to 2, exercise 0. `gemma3n:e4b`: career 2 to 4, growth 1 to 2, exercise 0. Nobody moved exercise to leisure.
- The gain is there at the first hinted level and the later levels do not add to it (`qwen2.5:3b` at levels 3 to 18:
  7, 8, 8, 6, 8; `gemma3n:e4b`: 7, 7, 8, 6, 6). The hint is at most three lessons, one for each value the owner
  corrects most, and this fixture has exactly three values, so past a few corrections there is nothing more for it to
  carry. Whether more lessons, or lessons chosen for the title, would keep improving it was not measured here (the
  earlier hint measurement had a similarity-retrieval arm and kept frequency-only for its latency cost).

## Designs compared

Level 0 is the stock prompt with no hint, which is what each model does without the loop. Controls are the 12 titles
with an obvious category.

| Model | Route p50 (ms) | Targets / controls right | All nine keys | Valid direction |
|---|---|---|---|---|
| `qwen2.5:0.5b` (the old fast default) | 149 | 5 / 4 | 0% | 100% |
| `gemma3:1b` | 504 | 2 / 11 | 100% | 58% |
| `qwen2.5:3b` | 875 | 5 / 9 | 100% | 75% |
| `llama3.2:3b` | 714 | 1 / 7 | 100% | 100% |
| `gemma3:4b` | 1,646 (repeat 2,546) | 2 / 12 | 100% | 100% |
| `gemma3n:e4b` (today's quick add) | 1,958 (steady 1,470 to 1,590) | 3 / 12 | 100% | 87.5% |

- **A mid-size model as the fast tier, without the hint, is not a better trade.** The 3B models give up a quarter to
  two fifths of natural-title accuracy (`qwen2.5:3b` 9 of 12, `llama3.2:3b` 7 of 12, against 12 of 12) for 40 to 60%
  less latency, and `gemma3:4b` is as accurate as the quality model and no faster here (a dense 3.9B model took as long as
  `gemma3n:e4b`, whose "e4b" is an effective 4B).
- **With the hint, `qwen2.5:3b` closes most of the gap.** After 3 corrections its targets match the quality model's
  (7 of 12 at level 3, 8 at level 6) and its controls are one to two titles short (10 and 11 of 12, against 12), at
  about 0.9 s. It spends its first weeks, before the index has 2 corrections and the first weekly run, being wrong on
  a quarter of natural titles, and the owner is the one who corrects them.
- **A size bar is a poor proxy.** Of the models below 4B, the one that is best on natural titles with no hint is the 1B
  one (11 of 12), the one that can use the hint is a 3B model, and a different 3B model is harmed by it. Whether a model
  is good enough, and whether it can use the hint, has to be measured per model, or checked at run time.
- **Deferred fill-in was not built.** The Add dialog's Describe-it line (`ElementWizard.parseNl`) awaits one
  `POST /api/tasks/quick/parse` and hydrates every field from it at once (title, date, time, priority, direction,
  categories, motivation, estimate, then a proposed time slot that depends on the direction's default duration and
  the best-time band, then the subtask ideas), and the wait is the model's 0.9 to 2 s (about 5 s after an idle
  unload). The route already works without a model (the deterministic parse), so a two-step design is feasible: the
  parse hydrates title, date, time and tags at once, and the model's fields fill in what the owner has not touched
  when they arrive (the dialog already tracks that for motivation). What it would give is a first fill in
  milliseconds and the AI fields no sooner than today. What it would not fix: a pick that is wrong, the model swaps
  on a two-slot server, a cold load, and the time slot is proposed twice (once with the default duration, once with
  the model's) so it can move under the owner. It needs a server flag, client work in a 100-line function and a
  browser check, so it is a separate piece of work whose benefit is perceived latency only.

## Bringing the hint back

The hint is one revert: `git revert d0692e47` (#659) on a branch off `main`. On the current `main` the code applies
without conflict: `enrichQuick(text, parsed, vocab, hints)`, `enrichEntry` in `routes/tasks.ts`, the Learning card's
three-places copy and the hint tests come back, alongside quick add's quality tier (#662) and the one-word reading
(#660). README and CHANGELOG conflict (the paragraphs #659 deleted), and the restored text has to be brought up to
date: it said the default model answers a bare word and never learns. What is not a revert and needs a decision:

1. **A guard.** Half the models measured are harmed by the hint, and the quality tier is not always `gemma3n:e4b`.
   Options: send the hint only to models measured to use it (an allow-list: `gemma3n:e4b`, `qwen2.5:3b`,
   `gemma3:4b`, and anything the owner adds); or send it and fall back to the stock prompt when the hinted answer is
   unreadable (one more model call on those, and a model that gives a wrong but readable answer is not caught). The
   allow-list is the safer one and is brittle; neither was built or measured.
2. **Which model.** On a default install quick add runs on `gemma3n:e4b` (#662), which learns: three target titles
   in this fixture, direction validity 87.5% to 91.7%, and a latency within noise of what it is without the hint. So
   restoring the hint for the default path has a measured benefit. `qwen2.5:3b` as a faster option is a second,
   separate decision, on one fixture and a margin of one or two titles.
3. **Whether more lessons or similarity retrieval would keep the curve rising.** Not measured.

## What this does not show

- One invented owner, three conventions and three lessons (the hint is a complete convention table here, and a real
  owner has more values and skewed counts), 12 target and 12 control titles, 3 runs at temperature 0.1: titles, not
  runs, are the sample, and one title is 4 points. `qwen2.5:3b`'s 19 against `gemma3n:e4b`'s 18 is one title.
- Category only (the wizard records no motivation). The weekly cycle compressed to one calibrate per level. One box,
  one server setting (`OLLAMA_MAX_LOADED_MODELS=2`), models switched between runs. Latency noise was large: the
  reference's level-0 p50 was 1,958 ms and 1,694 ms in its repeat, and 1,470 to 1,592 ms for every hinted level;
  `gemma3:4b`'s was 1,646 and 2,546 ms. The machine is shared with other sessions (a headless browser and another
  Ollama model were running, load average 11 to 16, when I re-ran the test suites afterwards), and I did not record load
  during the live run, so some of that noise may be theirs. L4's speed criterion passed against the 1,958 and would not against 1,490
  (937 over 1,490 is 0.63): read the speed-up as about 1.6 times, 1.5 to 2.1.
- Whether any model keeps improving past 18 corrections, and whether any model in the harmed group would be fixed
  by a different hint wording or layout.
- Real owners, other languages, or titles not like the fixture's.

## How to reproduce

The artifact (`learn-run-1.json`, with its log) is not in the repository; it was kept in
`~/.cache/ci-planning-shape-fix/` on the machine that ran it. It records the commit it ran on (`4b3c15b7`, on the
branch `exp/hint-learning-curve`) and that no tracked file differed from it. The live mode needs the hint in the tree
to have anything to measure:

```
git checkout -b exp/hint main
git revert -n d0692e47        # resolve README.md and CHANGELOG.md to main; the code applies cleanly
cd server
LIVE_LEARN=1 LIVE_SHAPE_MODELS=qwen2.5:0.5b,gemma3:1b,qwen2.5:3b,llama3.2:3b,gemma3:4b,gemma3n:e4b \
  LIVE_SHAPE_OUT=<out>/learn-run-1.json \
  ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose
```

The first model must be the fast tier the app resolves (`qwen2.5:0.5b`, do not pin `OLLAMA_FAST`); the four extra
models have to be pulled first (`ollama pull qwen2.5:3b llama3.2:3b gemma3:4b`). The run took 51 minutes. Do not run
the server test suite during it. The pure parts (the rule on invented calls) run in every test run.
