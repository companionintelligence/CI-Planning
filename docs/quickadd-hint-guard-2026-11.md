# The quick-add hint, back with a guard (2 Nov 2026)

Follow-up to [quick-add-hint-learning-curve-2026-11.md](quick-add-hint-learning-curve-2026-11.md). That
measurement found the hint (the owner's most-corrected category lessons, shown last in the quick-add prompt)
helped three of six models and made three answer **worse**, with no pattern in size. The owner asked for it back
with a guard. This records the guard and what measuring it showed.

## What changed

- **The hint is back.** `git revert d0692e47` (#659) on `main`: `enrichQuick(text, parsed, vocab, hints)`,
  `enrichEntry` in `routes/tasks.ts`, the first hint measurement's harness and tests. It sits beside quick add's
  quality tier (#662) and the one-word reading (#660), which it did not conflict with. README and CHANGELOG
  conflicted (the paragraphs #659 deleted) and were rewritten to say what is true now.
- **The guard** (`server/src/agents/quickadd-hint-models.ts`, used in `enrichEntry`). The hint is fetched and
  shown only when the model quick add will ask is on an allow-list: **`gemma3n:e4b`, `qwen2.5:3b`,
  `gemma3:4b`**, the three that gained from it. Any other model, one that cannot be resolved included, gets the
  stock prompt, byte for byte, as an owner with no corrections does. Quick add asks the quality tier, so the name
  checked is `resolveModel('quality')` for the owner (their Settings choice first, an env pin, the built-in
  default if installed, else auto-selected). `QUICK_ADD_HINT_MODELS` (comma-separated names) adds models for an
  owner who has measured their own. **There is no wildcard**: "every model" is the state that hurt half of the
  ones measured. Matching is by name, case-insensitive, a name with no tag is its `:latest`, and a tag is not a
  prefix match (`gemma3n:e4b-it-q4` is not `gemma3n:e4b`).
- The default is "no", not "yes unless known bad". A model nobody has measured gets no hint, and the hint costs
  that owner nothing they had before.

## What was measured

Registered in the harness header (`LIVE_GUARD=1`, `classification-shape-live.test.ts`) and committed before the
run (`c8333376`). It is the learning-curve run again (the same six models, owner, fixture, levels 0 to 18, noise
pass, real routes) with one change: **no model is injected**. The app resolves the model itself, the way an owner
chooses it: `gemma3n:e4b` with no override anywhere (the default path), every other model as the owner's
quality-tier model in Settings, with the run asserting that the app resolved it. Per call, whether the prompt the
route sent is the stock prompt for that title. 3,024 calls, no violations.

- **G1 no harm** (every model not on the list): no call carried a hint block, every prompt was the stock prompt,
  and L2 and L3 hold.
- **G2 no loss** (every model on the list): the hint was in at least 95% of the calls at every level where the
  index held 2 or more corrections, and L1, L2 and L3 hold.
- **G3 default:** `gemma3n:e4b` with no override meets G2.
- **Rule:** D1 recommended when G1 holds for every unlisted model and G2 and G3 for every listed one.

## Result: D1, recommended

Targets / controls right (of 12 each) at 0 and at 18 corrections; the first pair is the learning-curve run with
the hint sent to every model, the second is this run through the guard:

| Model | On the list | Unguarded, 0 to 18 | Guarded, 0 to 18 | Hint in the prompt (guarded) |
|---|---|---|---|---|
| `qwen2.5:0.5b` | no | 5 / 4 to **0 / 0** (answered a number for the category) | 5 / 4 to 5 / 4 | 0 of 504 calls |
| `gemma3:1b` | no | 2 / 11 to 0 / 11, valid direction 58% to 42% | 2 / 9 to 3 / 9, valid direction 60% to 58% | 0 of 504 |
| `llama3.2:3b` | no | 1 / 7 to **0 / 1** (answered null) | 0 / 5 to 1 / 6 | 0 of 504 |
| `qwen2.5:3b` | yes | 5 / 9 to 8 / 11 | 5 / 9 to 8 / 11 | 100% at every level with an index |
| `gemma3:4b` | yes | 2 / 12 to 5 / 12 | 2 / 12 to 4 / 12 | 100% |
| `gemma3n:e4b` (default, no override) | yes | 3 / 12 to 6 / 12 | 3 / 12 to 6 / 12 | 100% |

- **G1 passes for all three unlisted models:** the hint block was in 0 of 504 calls each, every prompt equalled the
  stock prompt, and the curves are flat (controls 4 to 4, 9 to 9 and 5 to 6; all nine keys and valid direction
  unchanged within the allowance). The three harms in the learning-curve run are gone.
- **G2 passes for all three listed models** and **G3 passes**: with no override anywhere, the default quality model
  gets the hint on every call once the index has 2 corrections, and learns what it learned unguarded (targets 3 to
  7 at 3 corrections, 6 at 18; controls 12 of 12 at every level but one, 11 at 9 corrections; valid direction
  87.5% to 91.7%).
- **`gemma3:4b` learned less this time** (2 to 4, a gain of two titles, the registered minimum; 2 to 5 in the first
  run). Controls on `gemma3:1b` and `llama3.2:3b` moved by one to two titles between the two runs with no hint in
  either guarded prompt, which is the noise on 12 titles.
- **Corrections still pile up for unlisted models.** The wizard's capture and the weekly index do not depend on the
  guard: `qwen2.5:0.5b` ended with 16 claims, 10 corrections and 8 indexed; `gemma3:1b` 15, 14 and 11;
  `llama3.2:3b` 7, 6 and 5. The hint is simply not shown. If the owner later switches the quality model to a listed
  one, the hint appears from the existing index at the next call.
- Route p50 at 18 corrections: `qwen2.5:3b` 1.10 s, `gemma3:4b` 1.45 s, `gemma3n:e4b` 1.56 s on a shared machine
  (the run's earlier medians were 0.94, 1.53 and 1.49 s). Not a gate; the hint adds a few hundred characters to a
  prompt and no model call.

## What this does not show

- **A model on neither list.** The guard answers "no" for it. That is chosen as the safe side, not measured: a
  larger model (`qwen3-coder:30b`), a sibling (`gemma3n:e2b`) or another family may use the hint well or badly.
  `QUICK_ADD_HINT_MODELS` is the way in once someone has measured it.
- **The allow-list is three names, not a rule about models.** The measurement does not say why `qwen2.5:3b` used
  the hint and `llama3.2:3b` did not.
- **One owner, three conventions, three lessons**, 12 + 12 titles, 3 runs at temperature 0.1, category only, one
  box, one server setting, a shared machine. The learning-curve doc's limits apply: the gain arrives by the third
  correction and does not grow, no model learned the exercise convention, and one title is 4 points.
- The Settings Learning card now says the Describe-it examples go only to the tested models; that copy was not
  user-tested.
- The who-it's-for half of the hint was not measured (the wizard records no motivation picks).

## How to reproduce

The artifact (`guard-run-1.json`, with its log) is not in the repository; it was kept in
`~/.cache/ci-planning-shape-fix/`. It records the commit it ran on (`c8333376`) and that nothing under `src/` or
the harness file differed from it (the README, CHANGELOG, Learning card copy and docs were edited while it ran). The three extra models have to be pulled first (`ollama pull qwen2.5:3b llama3.2:3b gemma3:4b`):

```
cd server
LIVE_GUARD=1 LIVE_SHAPE_MODELS=qwen2.5:0.5b,gemma3:1b,llama3.2:3b,qwen2.5:3b,gemma3:4b,gemma3n:e4b \
  LIVE_SHAPE_OUT=<out>/guard-run-1.json \
  ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose
```

The first model must be the fast tier the app resolves (`qwen2.5:0.5b`, do not pin `OLLAMA_FAST`), and the
default path needs `OLLAMA_QUALITY` unset. The run took 51 minutes (21:14 to 22:04 PST). Do not run the server test suite during
it. The guard's unit tests (the allow-list and the two routes, 11 of which fail without the guard line) run in every
test run.
