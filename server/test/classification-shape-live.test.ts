/**
 * Live measurement of the category answer shape in quick-add (follow-up to the classification
 * hint measurement of 2026-11-02, docs/classification-hint-measurement-2026-11.md, section
 * "Answer shape"; the write-up of this one is docs/classification-shape-fix-2026-11.md).
 *
 * THE QUESTION. The built-in fast tier (qwen2.5:0.5b) answers "categories" as a bare string, and
 * quick-add kept only arrays, so a default install got no category pick, no classification_claim
 * and nothing to learn from. Which is the smallest change that makes the picks usable?
 *
 * OPT-IN. Inert unless LIVE_SHAPE=1 (the measurement) or LIVE_CAPTURE=1 (the end-to-end capture
 * check below); needs a running Ollama with the models named. The pure parts at the bottom run in
 * every test run: they pin the readings, the prompt swap and the registered rule, with no model.
 *
 *   cd server
 *   LIVE_SHAPE=1 LIVE_SHAPE_RUNS=5 LIVE_SHAPE_MODELS=qwen2.5:0.5b,gemma3:1b,gemma3n:e4b \
 *     LIVE_SHAPE_OUT=<out>/shape-run-1.json ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose
 *   LIVE_CAPTURE=1 LIVE_SHAPE_MODELS=qwen2.5:0.5b LIVE_SHAPE_OUT=<out>/capture.json \
 *     ./node_modules/.bin/vitest run test/classification-shape-live.test.ts --reporter=verbose
 *   LIVE_SHAPE_REPLAY=<out>/shape-run-1.json ./node_modules/.bin/vitest run test/classification-shape-live.test.ts -t replay --reporter=verbose
 *   --reporter=verbose matters: the default reporter hides the console of a file that passes.
 *   The first model must be the fast tier the app resolves (asserted); set OLLAMA_FAST to pin another.
 *
 * Env, read by this file only: LIVE_SHAPE (measurement), LIVE_CAPTURE (capture check),
 * LIVE_SHAPE_RUNS (calls per title and arm, default 5), LIVE_SHAPE_MODELS (comma list, default the
 * three below), LIVE_SHAPE_OUT (per-call JSON artifact, rewritten as the run proceeds),
 * LIVE_SHAPE_REPLAY (recompute the readings and the rule from a saved artifact, offline).
 *
 * WHERE THIS CAME FROM. The measurement was first written, pre-registered and run inside
 * server/test/classification-hint-live.test.ts as `LIVE_HINT_SHAPE=1` (commit 59e12b0e, which holds the
 * registered text below byte for byte; the first live run's artifact records that commit and the hash of that
 * file). It moved here, with its readings, arms, gates and rule unchanged, because the hint half of
 * #652 that file measures is being dropped and this experiment does not use it. What changed in the
 * move: the file, the env names (LIVE_HINT_* became LIVE_SHAPE_*), and one added mode (the capture check).
 * The registered text below still says LIVE_HINT_SHAPE where it was written; nothing in it was edited.
 * LIVE_SHAPE_REPLAY re-reads the recorded run with this file's code and must print the rule's reading
 * the run printed.
 *
 * THE CAPTURE CHECK (LIVE_CAPTURE=1). Not a gated experiment: the end-to-end proof that the loop can
 * start. For each model, the 18 training titles of the fixture go through the REAL routes, as the wizard
 * sends them: POST /api/tasks/quick/parse, the returned classification_claim echoed on POST /api/tasks with
 * the owner's category, then one calibrateClassification. Reported: titles parsed, claims echoed,
 * corrections written, the JSON type of "categories" in each completion, and what calibrate indexed.
 * Hard-asserted (a failure means the capture path is broken, not that the model is poor): when a claim
 * was echoed exactly one classification_log row is written and it says what the claim and the saved
 * value say; when none was, none is.
 *
 * WHAT THIS DOES NOT SHOW. See the header of the registered text below, and the write-up.
 *
 * Models for the default run: qwen2.5:0.5b (the built-in fast tier), gemma3:1b, gemma3n:e4b (the
 * reference tier: it answers arrays on every call so far).
 */

/**
 * THE REGISTERED TEXT, moved verbatim from classification-hint-live.test.ts (commit 59e12b0e).
 * ("above" in it means the hint experiment's gates G1 to G6, in that file; they are not part of this one.)
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * SHAPE-FIX MEASUREMENT (LIVE_HINT_SHAPE=1). PRE-REGISTERED 2026-11-02, written and committed
 * BEFORE its first live run. Do not edit a gate, a threshold or a rule below after seeing a
 * result; add a dated note under it instead. The G1 to G6 above are a different experiment and
 * are not touched by this one.
 *
 * THE QUESTION. The built-in fast tier (qwen2.5:0.5b) answers "categories" as a bare string
 * ("leisure"), where quick-add keeps only arrays (constrainToVocabulary returns [] for anything
 * else), so a default install gets no category pick, the wizard no classification_claim, and
 * the loop never starts. Which is the smallest change that makes the picks usable, and does it
 * leave the one tier that answers arrays (gemma3n:e4b) alone?
 *
 * WHAT RUNS. LIVE_HINT_SHAPE=1 replaces the main experiment (it does not run alongside it):
 * for each model in LIVE_HINT_MODELS, every one of the 42 fixture titles (18 training, 12
 * target, 12 control) x RUNS completions, for an owner with no corrections (no hint block:
 * the stock prompt every default install sends), interleaved per (title, run) in the fixed
 * order A, W1, W2, A2. No server route is driven: enrichQuick is called as it stands (A, A2) or
 * is handed the same stock prompt with ONE line changed (W1, W2). The model under test is
 * injected (the same seam as above), and the first model must be the fast tier the app resolves.
 *   A    the stock prompt, today's enrichQuick, untouched.
 *   A2   a repeat of A: the noise floor.
 *   W1   the stock prompt with the "categories" line worded as a JSON array:
 *          "categories": a JSON array of 1-3 life areas from [...], best fit first.
 *   W2   the same, with the shape shown as a placeholder (a vocabulary name would bias the pick):
 *          "categories": 1-3 life areas from [...], best fit first, as a JSON array like ["<area>"].
 *   Every other byte of W1 and W2 is the stock prompt's (asserted).
 * Each completion is read four ways, from the same raw text, so candidate (b) costs no extra calls:
 *   strict      what production did before this change: only a JSON array is kept (constrainToVocabulary).
 *   whole       a bare string is taken as one name, matched as a WHOLE string against the owner's
 *               categories (a name may contain a comma); an array is read exactly as in `strict`.
 *   split       as `whole`, and when the whole string names nothing, split on ',' and keep each part
 *               that does (what the lenient score above does).
 *   production  the real mergeEnrichment run on the completion: the check that what is shipped is
 *               what was measured (equal to `strict` before the change, to the chosen reading after).
 * A completion YIELDS when its reading names at least one of the owner's categories. Yield Y is the
 * share of an arm's completions that yield (n = 42 x RUNS per arm and model).
 *
 * CANDIDATES. (a) a prompt wording (W1 or W2), read `strict`; (b) a tolerant parse of the stock
 * prompt's answer (A read `whole`, or `split`); (a+b) a wording read `whole`. Tiers: SMALL are
 * qwen2.5:0.5b and gemma3:1b; REFERENCE is gemma3n:e4b (answers arrays on every call so far).
 *
 *   S1 YIELD         A candidate raises Y over A read `strict` by at least +20 points absolute on EACH
 *                    small tier that was run. (A tier that was not run cannot pass: no verdict.)
 *   S2 REFERENCE     On the reference tier, the candidate leaves the picks alone: the number of titles
 *                    whose modal first pick (the most frequent first category over the runs, ties to the
 *                    first seen, none = no pick) differs from A read `strict` is at most 2 of 42, and its
 *                    Y is not more than 5 points below A's. If A against A2 moves more than 2 titles on
 *                    that tier, S2 is INCONCLUSIVE: NOISE for every candidate (the noise is as large as
 *                    the effect). By construction a pure parse (b) leaves every array answer as it was.
 *   S3 SCHEMA SAFETY A wording (W1, W2) on EVERY tier: valid-JSON rate and the all-nine-keys rate each
 *                    no more than 5 points below A's, and no more empty or errored completions than A.
 *                    (b) changes no prompt, so it has nothing to fail here.
 * Reported, never gated: array / string / missing / other shares per arm; accuracy of the first pick on
 * the targets and on the controls, call level; the direction validity of every arm (a wording that
 * lowers it makes more requests wait for a second model call); Y of each reading; the bare strings the
 * `whole` reading cannot recover but `split` can.
 *
 * RULE (the lead decides; the harness reads it off and prints each line).
 *   D1  (b) QUALIFIES when S1 and S2 hold for it. `split` is preferred over `whole` only when it
 *       lifts Y over `whole` by at least 10 points on a small tier; otherwise `whole`.
 *   D2  (a) QUALIFIES when S1 and S2 hold for it and S3 holds on every tier.
 *   D3  Only (b) qualifies: ship (b), no prompt change for any owner. Only (a) qualifies: ship the
 *       wording that qualifies (W1 if both do). Both qualify: ship (b) ALONE, unless (a+b) with a
 *       wording that qualifies lifts Y over (b) by at least 15 points on a small tier (S2 and S3
 *       holding for it as for (a)): then (a+b). Neither (a) nor (b) qualifies: ship no fix, unless an
 *       (a+b) candidate qualifies (S1, S2 and S3 holding), then that one (W1 first); if none does, say
 *       so and leave the defect documented.
 *   D4  After a candidate ships, the main experiment above is re-run on the three tiers with the shipped
 *       code. The shape fix is not judged by those G1 to G6 on the small tiers (their G1 has never been
 *       readable); what must hold is that the reference tier's verdicts do not move, that G2 to G4 and G6
 *       hold on every tier that runs, and that the default tier now yields claims and corrections.
 * NOT SHOWN, whatever the result: one invented owner, 42 titles, temperature 0.1 so five runs per title
 * are near-identical (titles, not runs, are the sample); three models; a yield is a pick the model made,
 * not a pick the owner would have made; no real owner's data.
 */

/**
 * THE QUALITY-TIER MEASUREMENT (LIVE_TIER=1). PRE-REGISTERED 2026-11-02, written and committed BEFORE its first
 * live run, with the same discipline as the shape measurement above: no gate, threshold or rule below is edited
 * after a result; a dated note goes under it.
 *
 * THE QUESTION. The shape measurement found the default fast model (qwen2.5:0.5b) gives a category that is
 * mostly wrong (right on 20 of 60 answers for obvious titles) and returns 3 of the 9 requested keys, while
 * gemma3n:e4b, the quality-tier default that every default install already pulls (docker-compose.yml), was right
 * on 60 of 60 and returned all nine. Should quick add's classification (enrichQuick: the overlay call and its
 * direction retry) run on the QUALITY tier? Not the whole fast tier: planning's generator (plan_generate, fast) must
 * not be its own judge (plan_judge, quality), and every other fast-tier call would get slower.
 *
 * WHAT CHANGES. agents/quickadd.ts passes tier 'quality' on both of its generateJson calls. The purpose
 * ('classify': temperature 0.1, ceiling 15 s) and the prompt, byte for byte, are as they were.
 *
 * WHAT RUNS. The REAL parse route (POST /api/tasks/quick/parse) end to end for an owner with no corrections, with NO
 * model injected: the app resolves its own tiers, and the fast tier must resolve to qwen2.5:0.5b and the quality tier
 * to gemma3n:e4b (asserted; the run is not valid otherwise). The 42 fixture titles x LIVE_SHAPE_RUNS (5), in BLOCKS
 * (not interleaved, so each block sees its own model warm), in this order:
 *   B    BEFORE: the seam forces tier 'fast' on every call, which is what production sent before the change.
 *   Q    AFTER: the shipped code, untouched (tier 'quality').
 *   Q2   a repeat of Q: the noise floor.
 * Then COLD: 3 trials of: unload gemma3n:e4b (POST /api/generate with keep_alive 0, then wait up to 15 s for GET
 * /api/ps to stop listing it), then ONE route call. The unload is the only thing done to the server. Default Ollama
 * unloads an idle model after 5 minutes (docker-compose.yml sets no OLLAMA_KEEP_ALIVE), so a cold call is what the
 * first quick add after a quiet spell pays. Then MIX: 20 cycles of [a route parse (Q)] [one fast-tier generateJson
 * (purpose brainstorm, a two-line prompt)] [one embed], which is what a quick add followed by a subtask suggestion
 * and a dedupe embedding asks of the models, with GET /api/ps after every call, on a server whose slot count
 * (OLLAMA_MAX_LOADED_MODELS) is recorded beside the result. Three models rotate through it.
 * Per route call: wall time, the first model call's own time, whether the model overlay ran (`llm` true), the raw
 * first completion, strict-JSON validity, all nine keys, a valid direction, and the categories the route returned.
 *
 * GATES (on arm Q; B is reported beside it and never gated):
 *   R1 QUALITY    Of Q's 210 calls: the route returned a category on at least 95%; on the 12 obvious (control)
 *                 titles the first category is the right one on at least 90% of calls (54 of 60); all nine keys
 *                 are present on at least 90%; the direction names one of the owner's on at least 90%.
 *   R2 LATENCY    WARM: Q's route wall time p50 <= 2,500 ms and p95 <= 5,000 ms, and every call ran the overlay (a
 *                 timeout or a failure leaves `llm` false). COLD: each of the 3 first calls after an unload ran the
 *                 overlay, inside the 15 s ceiling.
 *   R3 RESIDENCY  In MIX, at most 10% of the route calls take longer than 3 x Q's warm route median, and every one
 *                 ran the overlay.
 *   R4 NO COLLATERAL  Not live: a unit test asserts that enrichQuick sends tier 'quality' on both calls and that
 *                 every other purpose's tier is unchanged.
 *
 * RULE (the lead decides; the harness reads it off and prints each line).
 *   D1  R1 and R2 hold: the change is recommended. R3 is reported with the slot count as a condition.
 *   D2  R1 or R2 fails: not recommended; the verdict and the numbers are the PR's whole content.
 *   D3  R3 fails with R1 and R2 holding: still D1, and the PR and the CHANGELOG say that on a box with fewer model
 *       slots than models in rotation quick add then pays a model swap.
 * NOT SHOWN, whatever the result: one box (AMD Strix Halo, unified memory, the server settings of docs/classification-
 * shape-fix-2026-11.md), one invented owner, 42 titles; no typical laptop, no CPU-only box, no concurrent users, no
 * real owner's data. The quality of the fields other than category (priority, minutes, time of day, who-it's-for) is
 * not scored, only whether the model returns them. The shape measurement's gemma3n:e4b numbers came from a model
 * injected into every call; this one lets the app resolve it.
 *
 * NOTES ADDED AFTER THE FIRST RUN (2026-11-02, 16:05 to 16:19 PST). Nothing below edits a gate; R1 to R3 read as
 * registered (all PASS, D1: recommended).
 *   - R3 watches quick add's own route calls, as registered. The MIX probe also timed the two other calls of each
 *     cycle, and they paid for a server with two model slots (OLLAMA_MAX_LOADED_MODELS=2, three models rotating): the
 *     fast-tier call took a median 1,483 ms where a warm qwen2.5:0.5b call is about 94 ms, and the embed took 6 ms
 *     when nomic-embed-text was resident and 290 to 555 ms when it was not. GET /api/ps shows qwen2.5:0.5b and
 *     nomic-embed-text taking turns in the slot gemma3n:e4b does not hold; once (cycle 10) gemma3n:e4b itself was
 *     evicted and the next route call paid its reload (5,441 ms). So an R3 PASS means quick add's own calls mostly
 *     stayed warm, not that three models fit in two slots: the cost moved to the other calls.
 *   - Q and Q2, the same arm twice, differ in route wall p50 by 29% (1,430 and 1,839 ms). That is the noise of this
 *     box on this run; the gates' margins are wider than it, and it is the reason to quote a range, not a point.
 */

/**
 * THE LEARNING-CURVE MEASUREMENT (LIVE_LEARN=1). PRE-REGISTERED 2026-11-02, written and committed BEFORE its first live
 * run, with the same discipline as the measurements above: no gate, threshold or rule below is edited after a result; a
 * dated note goes under it.
 *
 * THE QUESTION. The quick-add hint (the owner's most-corrected category lessons, shown last in the prompt, read from
 * the weekly calibrate run) was removed in #659: the one model it was measured on that could use it was gemma3n:e4b,
 * because the default model answered a bare string and the loop never started. With the one-word reading (#660) it can
 * start on small models. Does a SMALL model learn the owner's conventions from corrections, how many corrections does it
 * need, and does it end up both faster than and as accurate as the quality model? The hint is back for this experiment
 * only (a revert of #659 on a branch off main); nothing here restores it to main.
 *
 * WHAT RUNS. For each model in LIVE_SHAPE_MODELS (the model is injected into every call; the first must be the fast
 * tier the app resolves), through the REAL routes, on a fresh owner with the fixture's six categories and three
 * conventions (exercise to leisure, freelance invoices and tax to career, therapy and journaling to growth):
 *   LEVELS k = 0, 3, 6, 9, 12, 18 corrections. The 18 training titles are taken in a fixed order that interleaves the
 *   three conventions. To reach a level, the new training titles go through POST /api/tasks/quick/parse (the model's own
 *   pick, with whatever hint last week's index gives it), then POST /api/tasks with the owner's category and the claim
 *   echoed (the wizard's Add), then ONE calibrateClassification with no embedder: a compressed weekly cycle in which
 *   this week's parses use last week's index. The model's own misses are the corrections.
 *   MEASURE at each level: the 12 target titles (held out from training, same conventions) and the 12 control titles
 *   (natural answer is not a convention value) x 3 runs, through POST /api/tasks/quick/parse, so the prompt is the one
 *   the route really sends, hint included once the index holds at least 2 corrections.
 *   NOISE: after the top level the owner is reset to nothing learned (no corrections, no index) and level 0 is measured
 *   again on the same titles: the repeat of level 0, which is what an unchanged prompt does from one pass to the next.
 * Per call: route wall time, the categories returned, the raw first completion, strict-JSON validity, all nine keys, a
 * valid direction, and whether the prompt carried a hint block. Per level: corrections, indexed.
 * Scoring is by TITLE: a title is right when a strict majority of its 3 runs name the owner's category first.
 *
 * GATES (per model; the quality model, gemma3n:e4b, is the reference for L4):
 *   L1 LEARNS      targets right at k=18 minus targets right at k=0 is at least +2 titles. If level 0 against its repeat
 *                  moves more than 2 target titles, L1 is INCONCLUSIVE: NOISE.
 *   L2 NO OVER-APPLICATION  controls right at k=18 are at least controls right at k=0 minus 1.
 *   L3 SCHEMA SAFETY        all nine keys at k=18 no more than 5 points below k=0, and a valid direction no more than 10
 *                  points below k=0.
 *   L4 FASTER AND ACCURATE  (not for the reference itself) titles right of the 24 (12 targets + 12 controls) at k=18 at
 *                  least those of the reference at k=0 (what the quality tier does today with no hint), and the route
 *                  wall p50 over this model's k=18 calls at most half the reference's p50 over its k=0 calls.
 *   Reported, never gated: the whole curve (targets, controls, keys, direction, hinted share, p50 per level); the
 *   smallest level at which targets are +2 over k=0 ("needs k corrections"); the reference at k=18.
 * RULE (the lead decides; the harness reads it off and prints each line).
 *   D1  A model LEARNS when L1, L2 and L3 hold.
 *   D2  A model other than the reference is SMALL AND LEARNED when it LEARNS and L4 holds.
 *   D3  No model other than the reference is SMALL AND LEARNED: say that no small model reaches the quality model
 *       through the hint on this fixture, with the nearest one's numbers.
 * NOT SHOWN, whatever the result: one invented owner with exactly three conventions and three lessons (the hint can be a
 * complete convention table here and a real owner has more values and skewed counts); 12 target and 12 control titles,
 * 3 runs at temperature 0.1 (titles, not runs, are the sample; one title is 8 points); category only (no motivation);
 * the weekly cycle compressed to one calibrate per level; one box and one server setting; whether any model keeps
 * improving past 18 corrections.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Installs the SQLite store; model resolution reads the per-owner Settings override.
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { parseQuick } from '../src/engine/quickadd.js';
import { enrichQuick, mergeEnrichment, type QuickVocab } from '../src/agents/quickadd.js';
import { constrainToVocabulary, constrainOne, type EnrichOut } from '../src/agents/constrain.js';
import { generateJson, generate, embed, parseJsonLoose, type ModelTier } from '../src/mcp/ollama.js';
import {
  setInstalledModels, parseParamB, resolveModel, matchInstalled, explainModel, explainModelDefault, type ResolvedModel,
} from '../src/lib/models.js';
import { suggestibleVocabulary, type TagVocabulary } from '../src/services/tags.js';
import { calibrateClassification } from '../src/services/classification-learning.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const LIVE = process.env.LIVE_SHAPE === '1';
const CAPTURE = process.env.LIVE_CAPTURE === '1';
const TIER = process.env.LIVE_TIER === '1';
const LEARN = process.env.LIVE_LEARN === '1';
const REPLAY = process.env.LIVE_SHAPE_REPLAY ?? '';
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}
const RUNS = LIVE ? envPositiveInt('LIVE_SHAPE_RUNS', 5) : 5;
const MODELS = (process.env.LIVE_SHAPE_MODELS ?? 'qwen2.5:0.5b,gemma3:1b,gemma3n:e4b').split(',').map((m) => m.trim()).filter(Boolean);
const OUT = process.env.LIVE_SHAPE_OUT ?? '';
const OWNER = SYSTEM_OWNER;
/** The fast tier the measurement was registered against: the box default in lib/config.ts. */
const REGISTERED_FAST_DEFAULT = 'qwen2.5:0.5b';


// ── The model seam ────────────────────────────────────────────────────────────

interface SeamCall {
  prompt: string;
  raw: string;
  ms: number;
  model: string;
  /** A dry call never reached Ollama: it only captures the prompt (see dryPrompt). */
  dry: boolean;
  error?: string;
}

const rec = vi.hoisted(() => ({
  calls: [] as SeamCall[],
  /** Injected into every generate call that names no model of its own. */
  model: '',
  dry: false,
  /**
   * Completions handed out in order instead of reaching Ollama (the offline checks only, to
   * drive the real enrichQuick through chosen answers). Null in every live run.
   */
  script: null as string[] | null,
  /** The quality-tier measurement's BEFORE arm: forces this tier on every call, as production sent before. '' = leave the call's own. */
  tier: '' as '' | ModelTier,
}));

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return {
    ...real,
    // Same call, but the model under test is injected and the prompt and the raw
    // completion are retained before parsing. In dry mode nothing reaches Ollama.
    generateJson: async (prompt: string, opts: Parameters<typeof real.generate>[1] = {}) => {
      if (rec.script) {
        // Parsed the way the real call parses a completion, so an unreadable one throws as it would.
        const raw = rec.script.shift() ?? '{}';
        rec.calls.push({ prompt, raw, ms: 0, model: '', dry: true });
        return real.parseJsonLoose(raw);
      }
      if (rec.dry) {
        rec.calls.push({ prompt, raw: '{}', ms: 0, model: '', dry: true });
        return {};
      }
      const model = opts.model ?? rec.model;
      const t0 = performance.now();
      let raw: string;
      try {
        raw = await real.generate(prompt, { ...opts, ...(rec.tier ? { tier: rec.tier } : {}), model: model || undefined, json: true });
      } catch (err) {
        rec.calls.push({ prompt, raw: '', ms: performance.now() - t0, model, dry: false, error: (err as Error).message });
        throw err;
      }
      rec.calls.push({ prompt, raw, ms: performance.now() - t0, model, dry: false });
      return real.parseJsonLoose(raw);
    },
  };
});

// ── Fixture ───────────────────────────────────────────────────────────────────

const CATEGORIES = ['health', 'career', 'relationships', 'growth', 'leisure', 'finance'];
const DIRECTIONS = ['work', 'home', 'community'];
const OTHERS = ['email', 'errands'];

type ConventionId = 'exercise-leisure' | 'invoices-career' | 'inner-work-growth';

interface Convention {
  id: ConventionId;
  /** The category the owner files these titles under. */
  owner: string;
  rule: string;
  /** What the fixture ASSUMES the model says by default; measured, never trusted. */
  modelDefault: string;
  train: string[];
  targets: string[];
}

// No title may carry a date or time word ("evening", "March", "quarter", "morning"):
// chrono would lift it out of the title and the claim text would no longer be the title.
// fixtureProblems() checks that against the parser.
const CONVENTIONS: readonly Convention[] = [
  {
    id: 'exercise-leisure',
    owner: 'leisure',
    rule: 'exercise and sport titles go to leisure, not health',
    modelDefault: 'health',
    train: [
      'Gym workout with the lifting group',
      'Go for a run along the river',
      'Swim laps at the community pool',
      'Yoga class at the studio',
      'Bike ride on the coastal trail',
      'Bouldering at the climbing gym',
    ],
    targets: ['Leg day at the gym', '5k training run', 'Spin class', 'Pilates reformer session'],
  },
  {
    id: 'invoices-career',
    owner: 'career',
    rule: 'freelance invoices, tax and bookkeeping go to career, not finance',
    modelDefault: 'finance',
    train: [
      'Send the Acme invoice for the rebrand',
      'Chase the overdue Brightside invoice',
      'File quarterly estimated taxes',
      'Prepare invoices for the retainer clients',
      'Send receipts to the accountant',
      'Reconcile business expenses with the bank feed',
    ],
    targets: [
      'Invoice Delta Studio for the logo project',
      'Pay the self-employment tax',
      'Gather 1099 forms for the accountant',
      'Send the final invoice for the website job',
    ],
  },
  {
    id: 'inner-work-growth',
    owner: 'growth',
    rule: 'therapy, meditation and journaling go to growth, not health',
    modelDefault: 'health',
    train: [
      'Therapy session with Dr. Lee',
      'Meditate for fifteen minutes',
      'Write three pages in the journal',
      'Breathing exercises before bed',
      'Gratitude journaling',
      'Guided mindfulness session',
    ],
    targets: ['Weekly therapy appointment', 'Silent sitting meditation', 'Free-write in my journal', 'Body scan relaxation'],
  },
];

interface Control { title: string; expected: string; besides?: ConventionId }
const CONTROLS: readonly Control[] = [
  { title: 'Dentist appointment', expected: 'health', besides: 'exercise-leisure' },
  { title: 'Book a physical with the GP', expected: 'health' },
  { title: 'Refill blood pressure prescription', expected: 'health', besides: 'inner-work-growth' },
  { title: 'Flu shot at the pharmacy', expected: 'health' },
  { title: 'Pay the electricity bill', expected: 'finance', besides: 'invoices-career' },
  { title: 'Check the savings account balance', expected: 'finance' },
  { title: 'Review the monthly budget', expected: 'finance' },
  { title: 'Pay the credit card statement', expected: 'finance' },
  { title: 'Call mom and catch up', expected: 'relationships' },
  { title: 'Plan anniversary dinner with Alex', expected: 'relationships' },
  { title: 'Buy a birthday gift for dad', expected: 'relationships' },
  { title: 'Coffee catch-up with Priya', expected: 'relationships' },
];

interface FixtureItem {
  title: string;
  kind: 'train' | 'target' | 'control';
  convention: ConventionId | null;
  expected: string;
  besides?: ConventionId;
}

const ITEMS: readonly FixtureItem[] = [
  ...CONVENTIONS.flatMap((c) => c.train.map((title) => ({ title, kind: 'train' as const, convention: c.id, expected: c.owner }))),
  ...CONVENTIONS.flatMap((c) => c.targets.map((title) => ({ title, kind: 'target' as const, convention: c.id, expected: c.owner }))),
  ...CONTROLS.map((c) => ({ title: c.title, kind: 'control' as const, convention: null, expected: c.expected, besides: c.besides })),
];
const TRAIN_ITEMS = ITEMS.filter((i) => i.kind === 'train');
const TARGET_ITEMS = ITEMS.filter((i) => i.kind === 'target');
const CONTROL_ITEMS = ITEMS.filter((i) => i.kind === 'control');


// ── Types and small helpers ──────────────────────────────────────────────────

type CategoriesType = 'array' | 'string' | 'missing' | 'other';

/** The keys enrichQuick's prompt asks for (categories included: the owner has them). */
const WIDE_KEYS = [
  'direction', 'isComplex', 'priority', 'estimatedMinutes', 'timeOfDay', 'timeOfDayReason',
  'motivation', 'categories', 'tags',
] as const;

const pct = (num: number, den: number): number => (den === 0 ? NaN : (100 * num) / den);
const fmt1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Most frequent non-null value; ties go to the one seen first. */
function modalPick(picks: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const p of picks) if (p !== null) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [value, n] of counts) if (n > bestN) { best = value; bestN = n; }
  return best;
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

// ── Answer shape ──────────────────────────────────────────────────────────────

/**
 * The JSON type of "categories" in a raw completion, read with the parser production reads
 * it with (generateJson goes through parseJsonLoose), so "array" here means what
 * constrainToVocabulary will keep.
 */
function categoriesTypeOf(raw: string): CategoriesType {
  let obj: unknown;
  try { obj = parseJsonLoose(raw); } catch { return 'missing'; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !('categories' in obj)) return 'missing';
  const v = (obj as { categories: unknown }).categories;
  return Array.isArray(v) ? 'array' : typeof v === 'string' ? 'string' : 'other';
}

/** The first category the model meant: a bare string is read as a (comma-separated) list. Not production's reading. */
function lenientPickOf(raw: string, vocabulary: string[]): string | null {
  let obj: Record<string, unknown> | null = null;
  try { obj = parseJsonLoose<Record<string, unknown>>(raw); } catch { return null; }
  const c = obj?.categories;
  return constrainToVocabulary(typeof c === 'string' ? c.split(',') : c, vocabulary, 3)[0] ?? null;
}

interface ShapeStats { n: number; array: number; string: number; missing: number; other: number; arrayPct: number }
function shapeStats(calls: readonly { categoriesType: CategoriesType }[]): ShapeStats {
  const count = (t: CategoriesType): number => calls.filter((c) => c.categoriesType === t).length;
  return {
    n: calls.length, array: count('array'), string: count('string'), missing: count('missing'), other: count('other'),
    arrayPct: pct(count('array'), calls.length),
  };
}


// ── The readings, the arms, the gates and the rule (pre-registered in the header) ──────

type ShapeArm = 'A' | 'W1' | 'W2' | 'A2';
/** The fixed interleave order inside one (title, run) cell. */
const SHAPE_ARMS: readonly ShapeArm[] = ['A', 'W1', 'W2', 'A2'];
/** How a completion's "categories" is read; see the header. `production` is the real mergeEnrichment. */
type Reading = 'strict' | 'whole' | 'split' | 'production';
const READINGS: readonly Reading[] = ['strict', 'whole', 'split', 'production'];
/**
 * The reading the SHIPPED mergeEnrichment must equal on every completion. 'strict' = nothing shipped
 * yet; 'whole' since 2026-11-02, when the rule (D3) shipped the whole-string parse (agents/quickadd.ts
 * categoryAnswer). Moved only by a change that ships another reading, with a dated note.
 */
const SHIPPED_READING: 'strict' | 'whole' | 'split' = 'whole';

const SHAPE_GATES = {
  /** S1: Y over A read strict, absolute points, on each small tier that ran. */
  s1MinPoints: 20,
  /** S2: titles (of 42) whose modal first pick may differ from A read strict, on the reference tier. */
  s2MaxTitleDiffs: 2,
  /** S2: Y may be at most this many points below A's. */
  s2MaxYieldDropPoints: 5,
  /** S2: A against A2 moving more titles than this makes S2 INCONCLUSIVE: NOISE. */
  s2NoiseTitleDiffs: 2,
  /** S3: valid-JSON rate and all-keys rate, points below A. */
  s3MaxDropPoints: 5,
  /** D1: `split` over `whole`, points of Y on a small tier. */
  splitMinExtraPoints: 10,
  /** D3: (a+b) over (b), points of Y on a small tier. */
  withBMinExtraPoints: 15,
} as const;
const SMALL_TIERS: readonly string[] = ['qwen2.5:0.5b', 'gemma3:1b'];
const REFERENCE_TIER = 'gemma3n:e4b';

type Wording = 'stock' | 'W1' | 'W2';
/**
 * The "categories" line of enrichQuick's prompt (stock) and the two pre-registered wordings. The
 * line ends with the newline that closes it, so that replacing it moves no other byte.
 */
function categoriesLine(categories: readonly string[], wording: Wording): string {
  const list = JSON.stringify(categories);
  if (wording === 'W1') return `"categories": a JSON array of 1-3 life areas from ${list}, best fit first.\n`;
  if (wording === 'W2') return `"categories": 1-3 life areas from ${list}, best fit first, as a JSON array like ["<area>"].\n`;
  return `"categories": 1-3 life areas from ${list}, best fit first.\n`;
}

/** The stock prompt with its one "categories" line worded as `wording`; nothing else moves. */
function swapCategoriesLine(stock: string, categories: readonly string[], wording: 'W1' | 'W2'): string {
  const from = categoriesLine(categories, 'stock');
  if (occurrences(stock, from) !== 1) throw new Error('swapCategoriesLine: the stock categories line is not in the prompt exactly once');
  return stock.replace(from, () => categoriesLine(categories, wording));
}

/**
 * The owner's categories a completion names, read as `reading`. `strict` is what production did before
 * the shape fix (only an array is kept), `whole` takes a bare string as one name matched whole (a
 * name may contain a comma), `split` falls back to the comma-separated parts when the whole names
 * nothing. An array is read the same way in all three. Never throws.
 */
function readCategories(raw: string, categories: string[], reading: 'strict' | 'whole' | 'split'): string[] {
  let obj: unknown;
  try { obj = parseJsonLoose(raw); } catch { return []; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const c = (obj as { categories?: unknown }).categories;
  if (typeof c !== 'string' || reading === 'strict') return constrainToVocabulary(c, categories, 3);
  const whole = constrainToVocabulary([c], categories, 3);
  if (whole.length > 0 || reading === 'whole') return whole;
  return constrainToVocabulary(c.split(','), categories, 3);
}

/** What the real mergeEnrichment makes of a completion for this title: the check on what ships. Never throws. */
function productionCategories(raw: string, title: string, vocab: QuickVocab): string[] {
  let out: EnrichOut;
  try { out = parseJsonLoose<EnrichOut>(raw); } catch { return []; }
  try { return mergeEnrichment(parseQuick(title), out, vocab).categories ?? []; } catch { return []; }
}

interface ShapeCall {
  arm: ShapeArm;
  model: string;
  title: string;
  kind: FixtureItem['kind'];
  expected: string;
  run: number;
  promptSha: string;
  raw: string;
  error: string | null;
  ms: number;
  categoriesType: CategoriesType;
  validJson: boolean;
  allKeys: boolean;
  empty: boolean;
  direction: { valid: boolean; secondChance: boolean };
  /** The owner's categories the completion names, by reading. */
  picks: Record<Reading, string[]>;
}

const shapeArmCalls = (calls: readonly ShapeCall[], model: string, arm: ShapeArm): ShapeCall[] =>
  calls.filter((c) => c.model === model && c.arm === arm);
const yields = (c: ShapeCall, reading: Reading): boolean => c.picks[reading].length > 0;
const firstPickOf = (c: ShapeCall, reading: Reading): string | null => c.picks[reading][0] ?? null;

/** Y: the share of completions that name at least one of the owner's categories under `reading`. */
const yieldPct = (calls: readonly ShapeCall[], reading: Reading): number =>
  pct(calls.filter((c) => yields(c, reading)).length, calls.length);

/** The most frequent first pick over a title's runs under `reading` (ties to the first seen, runs in order); null = no pick. */
function modalFirstPick(calls: readonly ShapeCall[], model: string, arm: ShapeArm, reading: Reading, title: string): string | null {
  return modalPick(
    shapeArmCalls(calls, model, arm).filter((c) => c.title === title).sort((a, b) => a.run - b.run).map((c) => firstPickOf(c, reading)),
  );
}

/** Titles whose modal first pick differs between two (arm, reading) cells. */
function shapeTitleDiffs(
  calls: readonly ShapeCall[], model: string, a: { arm: ShapeArm; reading: Reading }, b: { arm: ShapeArm; reading: Reading },
  titles: readonly string[],
): string[] {
  return titles.filter((t) => modalFirstPick(calls, model, a.arm, a.reading, t) !== modalFirstPick(calls, model, b.arm, b.reading, t));
}

interface Candidate { id: string; label: string; arm: ShapeArm; reading: Reading; changesPrompt: boolean; wording: 'W1' | 'W2' | null }
const CANDIDATES: readonly Candidate[] = [
  { id: 'b', label: '(b) tolerant parse, whole string', arm: 'A', reading: 'whole', changesPrompt: false, wording: null },
  { id: 'b-split', label: '(b) tolerant parse, whole string else split on commas', arm: 'A', reading: 'split', changesPrompt: false, wording: null },
  { id: 'a-W1', label: '(a) wording W1, array only', arm: 'W1', reading: 'strict', changesPrompt: true, wording: 'W1' },
  { id: 'a-W2', label: '(a) wording W2, array only', arm: 'W2', reading: 'strict', changesPrompt: true, wording: 'W2' },
  { id: 'a+b-W1', label: '(a+b) wording W1 and the whole-string parse', arm: 'W1', reading: 'whole', changesPrompt: true, wording: 'W1' },
  { id: 'a+b-W2', label: '(a+b) wording W2 and the whole-string parse', arm: 'W2', reading: 'whole', changesPrompt: true, wording: 'W2' },
];
const candidate = (id: string): Candidate => CANDIDATES.find((c) => c.id === id)!;

const ranModels = (models: readonly string[], wanted: readonly string[]): string[] => models.filter((m) => wanted.includes(m));

/** S1 on every small tier that ran. `pass` is null when no small tier ran: there is no verdict then. */
function s1Yield(calls: readonly ShapeCall[], models: readonly string[], c: Candidate) {
  const perTier = ranModels(models, SMALL_TIERS).map((model) => {
    const base = yieldPct(shapeArmCalls(calls, model, 'A'), 'strict');
    const cand = yieldPct(shapeArmCalls(calls, model, c.arm), c.reading);
    return { model, base, cand, delta: cand - base, pass: cand - base >= SHAPE_GATES.s1MinPoints };
  });
  return { perTier, pass: perTier.length === 0 ? null : perTier.every((t) => t.pass) };
}

type S2Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE: NOISE' | 'NOT RUN';
/** S2 on the reference tier: the candidate leaves its picks alone, unless A against A2 says the noise is as large. */
function s2Reference(calls: readonly ShapeCall[], models: readonly string[], c: Candidate) {
  if (!models.includes(REFERENCE_TIER)) return { verdict: 'NOT RUN' as S2Verdict, diffs: NaN, noise: NaN, yieldDrop: NaN };
  const titles = ITEMS.map((i) => i.title);
  const base = { arm: 'A' as ShapeArm, reading: 'strict' as Reading };
  const noise = shapeTitleDiffs(calls, REFERENCE_TIER, base, { arm: 'A2', reading: 'strict' }, titles).length;
  const diffs = shapeTitleDiffs(calls, REFERENCE_TIER, base, c, titles).length;
  const yieldDrop = yieldPct(shapeArmCalls(calls, REFERENCE_TIER, 'A'), 'strict') - yieldPct(shapeArmCalls(calls, REFERENCE_TIER, c.arm), c.reading);
  const verdict: S2Verdict = noise > SHAPE_GATES.s2NoiseTitleDiffs ? 'INCONCLUSIVE: NOISE'
    : diffs <= SHAPE_GATES.s2MaxTitleDiffs && yieldDrop <= SHAPE_GATES.s2MaxYieldDropPoints ? 'PASS' : 'FAIL';
  return { verdict, diffs, noise, yieldDrop };
}

/** S3 for a wording arm on every tier that ran (a candidate that changes no prompt has nothing to fail). */
function s3Schema(calls: readonly ShapeCall[], models: readonly string[], c: Candidate) {
  if (!c.changesPrompt) return { pass: true, perTier: [] as { model: string; pass: boolean; valid: number[]; keys: number[]; empties: number[] }[] };
  const perTier = models.map((model) => {
    const a = shapeArmCalls(calls, model, 'A');
    const w = shapeArmCalls(calls, model, c.arm);
    const rate = (xs: readonly ShapeCall[], f: (x: ShapeCall) => boolean): number => pct(xs.filter(f).length, xs.length);
    const valid = [rate(a, (x) => x.validJson), rate(w, (x) => x.validJson)];
    const keys = [rate(a, (x) => x.allKeys), rate(w, (x) => x.allKeys)];
    const empties = [a.filter((x) => x.empty || x.error).length, w.filter((x) => x.empty || x.error).length];
    const pass = valid[0] - valid[1] <= SHAPE_GATES.s3MaxDropPoints && keys[0] - keys[1] <= SHAPE_GATES.s3MaxDropPoints && empties[1] <= empties[0];
    return { model, pass, valid, keys, empties };
  });
  return { pass: perTier.length > 0 && perTier.every((t) => t.pass), perTier };
}

/** Reads the pre-registered rule (D1 to D3) off the calls. The lead decides; this prints what the rule says. */
function shapeDecision(calls: readonly ShapeCall[], models: readonly string[]) {
  const lines: string[] = [];
  const evals = new Map(CANDIDATES.map((c) => [c.id, { c, s1: s1Yield(calls, models, c), s2: s2Reference(calls, models, c), s3: s3Schema(calls, models, c) }]));
  const qualifies = (id: string): boolean => {
    const e = evals.get(id)!;
    return e.s1.pass === true && e.s2.verdict === 'PASS' && e.s3.pass;
  };
  for (const { c, s1, s2, s3 } of evals.values()) {
    lines.push(`${c.label}: S1 ${s1.pass === null ? 'NO VERDICT (no small tier ran)' : s1.pass ? 'PASS' : 'FAIL'} `
      + `[${s1.perTier.map((t) => `${t.model} Y ${fmt1(t.base)}% -> ${fmt1(t.cand)}% (${t.delta >= 0 ? '+' : ''}${fmt1(t.delta)})`).join('; ') || '-'}], `
      + `S2 ${s2.verdict}${s2.verdict === 'NOT RUN' ? '' : ` [${s2.diffs} titles differ, A against A2 ${s2.noise}, Y change ${fmt1(-s2.yieldDrop)} points]`}, `
      + `S3 ${c.changesPrompt ? (s3.pass ? 'PASS' : 'FAIL') : 'n/a (no prompt change)'}`
      + ` => ${qualifies(c.id) ? 'QUALIFIES' : 'does not qualify'}`);
  }
  const extraOverWhole = ranModels(models, SMALL_TIERS).map((m) =>
    yieldPct(shapeArmCalls(calls, m, 'A'), 'split') - yieldPct(shapeArmCalls(calls, m, 'A'), 'whole'));
  const splitLifts = extraOverWhole.some((x) => x >= SHAPE_GATES.splitMinExtraPoints);
  const bId = qualifies('b-split') && (splitLifts || !qualifies('b')) ? 'b-split' : qualifies('b') ? 'b' : null;
  const wordings = (['W1', 'W2'] as const).filter((w) => qualifies(`a-${w}`));
  const aqualifies = wordings.length > 0;
  const liftOverB = (id: string): boolean => bId !== null && ranModels(models, SMALL_TIERS).some((m) =>
    yieldPct(shapeArmCalls(calls, m, candidate(id).arm), candidate(id).reading) - yieldPct(shapeArmCalls(calls, m, 'A'), candidate(bId).reading)
      >= SHAPE_GATES.withBMinExtraPoints);
  const abWordings = (['W1', 'W2'] as const).filter((w) => qualifies(`a+b-${w}`));
  let ship: string;
  if (bId !== null && !aqualifies) ship = `${bId}: the tolerant parse alone, no prompt change`;
  else if (bId === null && aqualifies) ship = `a-${wordings[0]}: the wording alone`;
  else if (bId !== null && aqualifies) {
    const lift = abWordings.find((w) => liftOverB(`a+b-${w}`));
    ship = lift ? `a+b-${lift}: wording and parse (it lifts Y over (b) by ${SHAPE_GATES.withBMinExtraPoints}+ points on a small tier)` : `${bId}: the tolerant parse alone (the wording adds under ${SHAPE_GATES.withBMinExtraPoints} points over it)`;
  } else if (abWordings.length > 0) ship = `a+b-${abWordings[0]}: neither alone qualifies, the pair does`;
  else ship = 'NONE: no candidate qualifies; ship no fix and leave the defect documented';
  lines.push(`D1 (b) ${bId ? `qualifies as ${bId}` : 'does not qualify'}; D2 (a) ${aqualifies ? `qualifies (${wordings.join(', ')})` : 'does not qualify'}.`);
  lines.push(`D3 the rule says: ship ${ship}.`);
  return { lines, ship, evals };
}


// ── Direction ─────────────────────────────────────────────────────────────────

/**
 * What enrichQuick does with one completion's "direction", read the way production reads it
 * (mergeEnrichment: constrainOne against the owner's direction names, trimmed and
 * case-insensitive). `valid`: it names one of them. `secondChance`: the completion parsed but
 * named none, so enrichQuick asks its second, single-field direction question, one more
 * sequential model call before the quick-add answer returns. A completion that cannot be read
 * (empty, errored, not JSON) fails the FIRST pass, which the caller catches, and a JSON null
 * throws inside mergeEnrichment (`out.estimatedMinutes` on null): neither reaches the second
 * question. The fixture's titles carry no direction tag of their own (fixtureProblems), so the
 * parse never supplies one.
 */
function directionOf(raw: string, directions: readonly string[]): { valid: boolean; secondChance: boolean } {
  let out: unknown;
  try { out = parseJsonLoose(raw); } catch { return { valid: false, secondChance: false }; }
  if (out === null || out === undefined) return { valid: false, secondChance: false };
  const valid = constrainOne((out as { direction?: unknown }).direction, [...directions]) !== null;
  return { valid, secondChance: !valid && directions.length > 0 };
}



// ── Provenance ────────────────────────────────────────────────────────────────

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CRED/i;
const redactUrl = (v: string): string => v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1[redacted]@');

/** The variables of `env` that start with `prefix`, sorted, with anything credential-shaped redacted. */
function envWithPrefix(env: NodeJS.ProcessEnv, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const v = env[key];
    if (key.startsWith(prefix) && v !== undefined) out[key] = SECRET_NAME.test(key) ? '[redacted]' : redactUrl(v);
  }
  return out;
}

const quoteArg = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a));

/**
 * The command line that started this run. Vitest runs a test file in a worker whose own
 * argv is the worker script, so the starter's argv is taken from the parent process when it
 * can be read (Linux /proc) and names vitest. A string assembled from the harness's own
 * variables would be a description of what was meant, not a record of what was run.
 */
function pickCommand(own: readonly string[], parent: readonly string[] | null): { argv: string[]; command: string; source: string } {
  const useParent = parent !== null && parent.some((a) => /vitest/i.test(a));
  const argv = [...(useParent ? parent : own)];
  return { argv, command: argv.map(quoteArg).join(' '), source: useParent ? 'parent process (/proc cmdline)' : 'this process (process.argv)' };
}

function readParentArgv(): string[] | null {
  try {
    return readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Where the gating tier came from, said plainly: a pin is a later choice, not the tier the gates were registered against. */
function gatingTierNote(a: { resolved: ResolvedModel; pinned: boolean; pinVar: string | null; registeredDefault: string }): string {
  const { resolved, pinned, pinVar, registeredDefault } = a;
  const isDefault = resolved.name.toLowerCase() === registeredDefault.toLowerCase();
  if (resolved.source === 'override') {
    return `The gating tier ${resolved.name} comes from the owner's Settings override, not from the box default (${registeredDefault}) the gates were registered against.`;
  }
  if (pinned) {
    const by = pinVar ?? 'an OLLAMA_* pin';
    return isDefault
      ? `The gating tier ${resolved.name} was set by ${by}; it is also the box default (${registeredDefault}) the gates were registered against.`
      : `The gating tier ${resolved.name} was set by ${by}, NOT by the box default. The gates were registered against ${registeredDefault}; `
        + `this artifact is the gates applied to ${resolved.name}, and a run of the default tier is a different artifact.`;
  }
  return isDefault
    ? `The gating tier is the box default, ${resolved.name} (resolved as: ${resolved.source}).`
    : `The gating tier ${resolved.name} was resolved as '${resolved.source}', not by the box default (${registeredDefault}) the gates were registered against.`;
}

const git = (args: string[], cwd: string): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n+$/, '');
  } catch {
    return null;
  }
};

const fileSha12 = (rel: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(new URL(rel, import.meta.url))).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
};

/**
 * What code ran. The commit alone would be misleading in a worktree with edits on top, so the paths
 * that differ from it and a hash of the sources under test are recorded too. Best effort.
 */
function harnessProvenance() {
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  const status = git(['status', '--porcelain', '--', 'src', 'test/classification-shape-live.test.ts'], serverDir);
  return {
    commit: git(['rev-parse', 'HEAD'], serverDir),
    differingFromCommit: status === null ? null : status.split('\n').filter(Boolean).slice(0, 40),
    sha256Prefix: Object.fromEntries([
      'test/classification-shape-live.test.ts', 'src/agents/quickadd.ts', 'src/agents/constrain.ts', 'src/routes/tasks.ts',
    ].map((rel) => [rel, fileSha12(`../${rel}`)])),
  };
}

/** Everything wrong with the fixture, checked against the real parser. Empty means usable. */
function fixtureProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of ITEMS) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) problems.push(`duplicate title: ${item.title}`);
    seen.add(key);
    if (item.title !== item.title.trim() || item.title.length === 0 || item.title.length > 120) {
      problems.push(`title not usable as a lesson line: ${JSON.stringify(item.title)}`);
    }
    if (!CATEGORIES.includes(item.expected)) problems.push(`${item.title}: expected ${item.expected} is not a category`);
    const p = parseQuick(item.title);
    if (p.title !== item.title || p.scheduledFor || p.dueAt || p.taskTime || p.tags.length) {
      problems.push(`${item.title}: the deterministic parse changes it (${JSON.stringify(p)})`);
    }
  }
  const ownerValues = new Set(CONVENTIONS.map((c) => c.owner));
  for (const c of CONVENTIONS) {
    if (c.train.length !== 6) problems.push(`${c.id}: ${c.train.length} training titles, wanted 6`);
    if (c.targets.length !== 4) problems.push(`${c.id}: ${c.targets.length} targets, wanted 4`);
    if (c.owner === c.modelDefault) problems.push(`${c.id}: the owner's value is the assumed default, there is nothing to learn`);
  }
  if (CONTROLS.length !== 12) problems.push(`${CONTROLS.length} controls, wanted 12`);
  for (const c of CONTROLS) {
    if (ownerValues.has(c.expected)) problems.push(`control ${c.title}: its natural answer ${c.expected} is a convention value`);
  }
  return problems;
}


// ── Live plumbing ─────────────────────────────────────────────────────────────

const say = (line = ''): void => {
  // eslint-disable-next-line no-console
  console.log(line);
};

let srv: TestServer;
const distinctPrompts = new Map<string, string>();
const violations: string[] = [];
const startedAt = new Date().toISOString();
let ollamaVersion = '';
/** What this run was and ran on; filled in beforeAll, written into every artifact flush. */
let provenance: Record<string, unknown> = {};
const violate = (model: string, message: string): void => { violations.push(`[${model}] ${message}`); };

type Vocab = TagVocabulary;

function parseViaRoute(text: string) {
  return api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text } });
}

function seedVocabulary(owner: string): void {
  const insert = sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`);
  for (const name of DIRECTIONS) insert.run(name, owner, 'direction');
  for (const name of CATEGORIES) insert.run(name, owner, 'category');
  for (const name of OTHERS) insert.run(name, owner, 'intention');
}

/** A clean slate for one model: the owner, the vocabulary, no tasks, no evidence. */
function resetWorld(): void {
  resetDb();
  seedVocabulary(OWNER);
}

async function warm(model: string): Promise<void> {
  await generate('Reply with the single word: ok', { model, timeoutMs: 180_000, think: false });
}

async function seamOf<T>(fn: () => Promise<T>): Promise<{ value: T | undefined; thrown: string | null; calls: SeamCall[] }> {
  const from = rec.calls.length;
  let value: T | undefined;
  let thrown: string | null = null;
  try {
    value = await fn();
  } catch (err) {
    thrown = (err as Error).message;
  }
  return { value, thrown, calls: rec.calls.slice(from) };
}

/** The first prompt `fn` puts in front of the model, without calling the model. */
async function dryPrompt(fn: () => Promise<unknown>): Promise<string> {
  rec.dry = true;
  try {
    return (await seamOf(fn)).calls[0]?.prompt ?? '';
  } finally {
    rec.dry = false;
  }
}

/** Which variable pinned the fast tier, named the way config.ts reads them: OLLAMA_FAST, else the old OLLAMA_SMALL. */
const fastPinVar = (pinned: boolean, env: NodeJS.ProcessEnv): string | null =>
  !pinned ? null : env.OLLAMA_FAST !== undefined ? 'OLLAMA_FAST' : 'OLLAMA_SMALL';

async function apiPs(): Promise<unknown> {
  try {
    return await (await fetch(`${config.ollamaUrl}/api/ps`)).json();
  } catch {
    return null;
  }
}


const shapeCalls: ShapeCall[] = [];

function shapeFlush(): void {
  if (!OUT) return;
  writeFileSync(OUT, JSON.stringify({
    harness: 'classification-shape-live', mode: 'shape-fix', startedAt, writtenAt: new Date().toISOString(),
    command: provenance.command ?? null,
    env: { runs: RUNS, models: MODELS, ollamaUrl: redactUrl(config.ollamaUrl), ollamaVersion, ollamaInTestProcess: envWithPrefix(process.env, 'OLLAMA_'), liveShape: envWithPrefix(process.env, 'LIVE_SHAPE') },
    provenance,
    shapeGates: SHAPE_GATES, smallTiers: SMALL_TIERS, referenceTier: REFERENCE_TIER, shippedReading: SHIPPED_READING,
    wordings: Object.fromEntries((['stock', 'W1', 'W2'] as const).map((w) => [w, categoriesLine(CATEGORIES, w)])),
    fixture: { conventions: CONVENTIONS, controls: CONTROLS },
    violations, prompts: Object.fromEntries(distinctPrompts), calls: shapeCalls,
  }, null, 2));
}

function shapeRecord(arm: ShapeArm, model: string, item: FixtureItem, run: number, seam: SeamCall | undefined, vocab: Vocab): ShapeCall {
  const raw = seam?.raw ?? '';
  const prompt = seam?.prompt ?? '';
  let strict: Record<string, unknown> | null = null;
  try {
    const j: unknown = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) strict = j as Record<string, unknown>;
  } catch { /* not strict JSON */ }
  const sha = sha12(prompt);
  if (prompt) distinctPrompts.set(sha, prompt);
  const call: ShapeCall = {
    arm, model, title: item.title, kind: item.kind, expected: item.expected, run,
    promptSha: sha, raw, error: seam?.error ?? null, ms: seam?.ms ?? NaN,
    categoriesType: categoriesTypeOf(raw), validJson: strict !== null, allKeys: strict !== null && WIDE_KEYS.every((k) => k in strict!),
    empty: raw.trim() === '', direction: directionOf(raw, vocab.directions),
    picks: {
      strict: readCategories(raw, vocab.categories, 'strict'),
      whole: readCategories(raw, vocab.categories, 'whole'),
      split: readCategories(raw, vocab.categories, 'split'),
      production: productionCategories(raw, item.title, vocab),
    },
  };
  shapeCalls.push(call);
  return call;
}

/** One model: 42 titles x RUNS x the four arms, for an owner with no corrections. */
async function runShape(model: string): Promise<void> {
  rec.model = model;
  say(`\n=== ${model} (shape-fix measurement${SMALL_TIERS.includes(model) ? ', small tier' : model === REFERENCE_TIER ? ', reference tier' : ''}) ===`);
  await warm(model);
  resetWorld();
  const vocab = await suggestibleVocabulary(OWNER);
  for (const item of ITEMS) {
    const parsed = parseQuick(item.title);
    const stock = await dryPrompt(() => enrichQuick(item.title, parsed, vocab));
    if (!stock) { violate(model, `shape "${item.title}": enrichQuick put no prompt in front of the model`); continue; }
    const worded = { W1: swapCategoriesLine(stock, vocab.categories, 'W1'), W2: swapCategoriesLine(stock, vocab.categories, 'W2') };
    for (let run = 0; run < RUNS; run++) {
      for (const arm of SHAPE_ARMS) {
        const direct = arm === 'A' || arm === 'A2';
        const { calls, thrown } = await seamOf(() => (direct
          ? enrichQuick(item.title, parsed, vocab)
          : generateJson(worded[arm as 'W1' | 'W2'], { purpose: 'classify' })));
        const seam = calls.find((c) => !c.dry);
        const call = shapeRecord(arm, model, item, run, seam, vocab);
        if (thrown && !seam?.error) violate(model, `shape ${arm} "${item.title}" run ${run}: ${thrown}`);
        if (seam && seam.prompt !== (direct ? stock : worded[arm as 'W1' | 'W2'])) violate(model, `shape ${arm} "${item.title}": the prompt sent is not the one built for the arm`);
        if (direct && (call.empty || call.error)) violate(model, `shape ${arm} "${item.title}" run ${run}: empty or errored completion of a baseline arm ${call.error ?? ''}`);
        if (call.picks.production.join('|') !== call.picks[SHIPPED_READING].join('|')) {
          violate(model, `shape ${arm} "${item.title}" run ${run}: the shipped mergeEnrichment reads ${JSON.stringify(call.picks.production)}, the ${SHIPPED_READING} reading ${JSON.stringify(call.picks[SHIPPED_READING])}`);
        }
      }
    }
    shapeFlush();
  }
  printShape(model);
}

function printShape(model: string): void {
  const score = (calls: readonly ShapeCall[], kind: 'target' | 'control', reading: Reading): string => {
    const mine = calls.filter((c) => (kind === 'control' ? c.kind === 'control' : c.kind === 'target' || c.kind === 'train'));
    return `${mine.filter((c) => (firstPickOf(c, reading) ?? '').toLowerCase() === c.expected.toLowerCase()).length}/${mine.length}`;
  };
  say('arm  calls  array%  string  missing  other | yield%: strict  whole  split  shipped | json%  keys%  empty | direction ok% | first pick right: titles(strict, whole)  controls(strict, whole)');
  for (const arm of SHAPE_ARMS) {
    const calls = shapeArmCalls(shapeCalls, model, arm);
    if (calls.length === 0) continue;
    const s = shapeStats(calls);
    const dir = pct(calls.filter((c) => c.direction.valid).length, calls.length);
    say(`${arm.padEnd(4)} ${String(s.n).padStart(5)}  ${fmt1(s.arrayPct).padStart(6)}  ${String(s.string).padStart(6)}  ${String(s.missing).padStart(7)}  ${String(s.other).padStart(5)} | `
      + `${fmt1(yieldPct(calls, 'strict')).padStart(15)} ${fmt1(yieldPct(calls, 'whole')).padStart(6)} ${fmt1(yieldPct(calls, 'split')).padStart(6)} ${fmt1(yieldPct(calls, 'production')).padStart(8)} | `
      + `${fmt1(pct(calls.filter((c) => c.validJson).length, calls.length)).padStart(5)} ${fmt1(pct(calls.filter((c) => c.allKeys).length, calls.length)).padStart(6)} ${String(calls.filter((c) => c.empty || c.error).length).padStart(5)} | `
      + `${fmt1(dir).padStart(13)} | ${score(calls, 'target', 'strict')}, ${score(calls, 'target', 'whole')}   ${score(calls, 'control', 'strict')}, ${score(calls, 'control', 'whole')}`);
  }
  const strings = shapeArmCalls(shapeCalls, model, 'A').filter((c) => c.categoriesType === 'string');
  const splitOnly = strings.filter((c) => c.picks.whole.length === 0 && c.picks.split.length > 0).length;
  const neither = strings.filter((c) => c.picks.split.length === 0).length;
  say(`A, bare strings: ${strings.length}; the whole string names a category on ${strings.filter((c) => c.picks.whole.length > 0).length}, only the comma split does on ${splitOnly}, no reading does on ${neither}.`);
  const names = new Map<string, number>();
  for (const c of strings) {
    const v = ((): string => { try { return String((parseJsonLoose(c.raw) as { categories: unknown }).categories); } catch { return '?'; } })();
    names.set(v, (names.get(v) ?? 0) + 1);
  }
  say(`A, the bare strings said: ${[...names].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${JSON.stringify(v)} x${n}`).join(', ') || '-'}`);
}


/** Shared by the live suites: installed models, the fast-tier assertion, provenance, the fixture check, the test server. */
async function prepareLive(): Promise<void> {
  expect(MODELS.length, 'LIVE_SHAPE_MODELS names no model').toBeGreaterThan(0);
  // vitest sets NODE_ENV=test, which stops ollama.status() from filling the installed cache, so do it
  // here: with the cache filled, resolveModel() performs the SAME auto-selection production does.
  const res = await fetch(`${config.ollamaUrl}/api/tags`);
  const data = (await res.json()) as {
    models?: { name: string; capabilities?: string[]; details?: { parameter_size?: string } }[];
  };
  setInstalledModels((data.models ?? []).map((m) => ({
    name: m.name, capabilities: m.capabilities ?? [], paramB: parseParamB(m.details?.parameter_size),
  })));
  try {
    ollamaVersion = ((await (await fetch(`${config.ollamaUrl}/api/version`)).json()) as { version?: string }).version ?? '';
  } catch { /* the version is a note, not a precondition */ }

  // The empty-response trap: no model under test may be thinking-capable (a thinking model answers ""
  // under format:"json"). And the first is the fast tier the app resolves.
  for (const model of MODELS) {
    const picked = matchInstalled(model);
    expect(picked, `${model} is not installed`).toBeTruthy();
    expect(picked!.capabilities, `${model} is thinking-capable`).not.toContain('thinking');
    say(`[live-shape] ${model} resolves to ${picked!.name} (caps: ${picked!.capabilities.join(',') || 'none listed'})`);
  }
  const fast = await resolveModel('fast');
  expect(matchInstalled(fast)?.name, `LIVE_SHAPE_MODELS[0] must be the fast tier the app resolves (${fast})`)
    .toBe(matchInstalled(MODELS[0])?.name);
  const fastDefault = explainModelDefault('fast');
  let fastForOwner: ResolvedModel | null = null;
  try { fastForOwner = await explainModel('fast'); } catch { /* a note, not a precondition */ }
  const pinVar = fastPinVar(config.pins.ollama.fast, process.env);
  const note = gatingTierNote({ resolved: fastForOwner ?? fastDefault, pinned: config.pins.ollama.fast, pinVar, registeredDefault: REGISTERED_FAST_DEFAULT });
  const start = pickCommand(process.argv, readParentArgv());
  provenance = {
    command: start.command,
    commandSource: start.source,
    argv: { starter: start.argv, thisProcess: process.argv, execArgv: process.execArgv },
    cwd: process.cwd(), node: process.version, platform: process.platform,
    fastTier: {
      registeredDefault: REGISTERED_FAST_DEFAULT, configuredName: config.ollamaFastModel,
      resolvedDefault: fastDefault, resolvedForOwner: fastForOwner, pins: config.pins.ollama, pinnedBy: pinVar,
    },
    gatingTierNote: note,
    ollama: { url: redactUrl(config.ollamaUrl), version: ollamaVersion, apiPsAtStart: await apiPs() },
    harness: harnessProvenance(),
  };
  say(`[live-shape] fast tier ${fast}; ${note}`);
  say(`[live-shape] command: ${start.command} (${start.source})`);
  expect(fixtureProblems()).toEqual([]);
  srv = await startTestServer();
}

// ── The capture check, live ──────────────────────────────────────────────────

interface CaptureReport {
  model: string;
  parsed: number;
  claims: number;
  noClaim: number;
  /** The claim named exactly the owner's value. */
  exact: number;
  /** The claim's first category was the owner's value. */
  firstMatch: number;
  /** The claim differed from the saved set: a row born closed, a correction. */
  corrections: number;
  shapes: Record<CategoriesType, number>;
  calibrate: { decided: number; corrections: number; indexed: number; heldOut: number } | null;
}
const captureReports: CaptureReport[] = [];

function captureFlush(): void {
  if (!OUT) return;
  writeFileSync(OUT, JSON.stringify({
    harness: 'classification-shape-live', mode: 'capture', startedAt, writtenAt: new Date().toISOString(),
    command: provenance.command ?? null,
    env: { models: MODELS, ollamaUrl: redactUrl(config.ollamaUrl), ollamaVersion, ollamaInTestProcess: envWithPrefix(process.env, 'OLLAMA_'), liveShape: envWithPrefix(process.env, 'LIVE_') },
    provenance, shippedReading: SHIPPED_READING, violations, reports: captureReports, prompts: Object.fromEntries(distinctPrompts),
  }, null, 2));
}

/** The wizard's path, on one model: 18 training titles through the real routes, then one calibrate. */
async function runCapture(model: string): Promise<void> {
  rec.model = model;
  say(`\n=== ${model} (capture check) ===`);
  await warm(model);
  resetWorld();
  const report: CaptureReport = {
    model, parsed: 0, claims: 0, noClaim: 0, exact: 0, firstMatch: 0, corrections: 0,
    shapes: { array: 0, string: 0, missing: 0, other: 0 }, calibrate: null,
  };
  captureReports.push(report);
  for (const item of TRAIN_ITEMS) {
    const { value: parsed, calls } = await seamOf(() => parseViaRoute(item.title));
    report.parsed++;
    const seam = calls.find((c) => !c.dry);
    if (seam) {
      report.shapes[categoriesTypeOf(seam.raw)]++;
      distinctPrompts.set(sha12(seam.prompt), seam.prompt);
    }
    const claim = parsed?.body?.classification_claim as { text: string; categories: string[] } | undefined;
    const title = (parsed?.body?.parsed?.title as string | undefined) ?? item.title;
    const created = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title, categories: [item.expected], ...(claim ? { classification_claim: claim } : {}) },
    });
    if (created.status !== 201) { violate(model, `capture "${item.title}": POST /api/tasks answered ${created.status}`); continue; }
    const rows = sqlite.prepare(
      `SELECT llm_value, final_value, corrected_at FROM classification_log WHERE task_id = ? AND field = 'category'`,
    ).all(created.body.task.id) as { llm_value: string; final_value: string | null; corrected_at: string | null }[];
    if (!claim) {
      report.noClaim++;
      if (rows.length !== 0) violate(model, `capture "${item.title}": no claim was sent but a log row was written`);
      continue;
    }
    report.claims++;
    const claimed = claim.categories.join(', ');
    const differs = claimed !== item.expected;
    if (claim.categories.length === 1 && !differs) report.exact++;
    if (claim.categories[0] === item.expected) report.firstMatch++;
    if (differs) report.corrections++;
    const row = rows[0];
    const wanted = differs ? { final: item.expected, closed: true } : { final: null, closed: false };
    if (rows.length !== 1 || row.llm_value !== claimed || row.final_value !== wanted.final || (row.corrected_at !== null) !== wanted.closed) {
      violate(model, `capture "${item.title}": the log row is not what the echoed claim should write (${JSON.stringify(rows)})`);
    }
  }
  say(`Capture: ${report.parsed} titles parsed, ${report.claims} claims echoed (${report.noClaim} with none: no category pick survived the route), `
    + `${report.exact} exactly the owner's value, ${report.firstMatch} with the owner's value first, ${report.corrections} corrections written. `
    + `"categories" in those ${report.parsed} completions: array ${report.shapes.array}, string ${report.shapes.string}, missing ${report.shapes.missing}, other ${report.shapes.other}. `
    + `The shipped reading is ${SHIPPED_READING}.`);
  const cal = await calibrateClassification(OWNER, new Date(), { embedFn: null });
  const category = cal.fields.find((f) => f.field === 'category');
  report.calibrate = category
    ? { decided: category.decided, corrections: category.corrections, indexed: category.indexed, heldOut: category.corrections - category.indexed }
    : null;
  say(`Calibrate (no embedder): ${JSON.stringify(report.calibrate)}`);
  captureFlush();
}

describe.skipIf(!CAPTURE)('classification shape · capture on a real model', () => {
  beforeAll(prepareLive);

  afterAll(async () => {
    await srv?.close();
  });

  for (const model of MODELS) {
    it(`${model}: the wizard's path on ${TRAIN_ITEMS.length} training titles, then calibrate`, async () => {
      await runCapture(model);
    }, 60 * 60_000);
  }

  it('the capture path held on every title (the counts are reported, never asserted)', () => {
    captureFlush();
    say(`\n[live-shape] capture: ${captureReports.length} models${OUT ? `, artifact at ${OUT}` : ' (set LIVE_SHAPE_OUT to keep them)'}.`);
    expect(violations, `mechanism violations:\n${violations.join('\n')}`).toEqual([]);
    expect(captureReports.length, 'no model ran').toBe(MODELS.length);
  });
});

// ── The quality-tier measurement, live (LIVE_TIER=1; the gates are pre-registered in the header) ──────

type TierArm = 'B' | 'Q' | 'Q2' | 'COLD' | 'MIX_Q' | 'MIX_F' | 'MIX_E';
const TIER_GATES = {
  /** R1, on arm Q. */
  r1MinPickPct: 95,
  r1MinObviousPct: 90,
  r1MinAllKeysPct: 90,
  r1MinDirectionPct: 90,
  /** R2: warm route wall time, ms. */
  r2WarmP50Ms: 2_500,
  r2WarmP95Ms: 5_000,
  /** The ceiling a call is held to (CALL_POLICY.classify.timeoutMs); also the cold limit. */
  ceilingMs: 15_000,
  /** R3: the share of MIX route calls slower than r3SlowFactor x Q's warm median, at most. */
  r3MaxSlowPct: 10,
  r3SlowFactor: 3,
  coldTrials: 3,
  mixCycles: 20,
} as const;

interface TierCall {
  arm: TierArm;
  title: string;
  kind: FixtureItem['kind'] | 'probe';
  expected: string;
  run: number;
  /** The whole call: the route's, or for MIX_F and MIX_E the one model call's. */
  wallMs: number;
  /** The first model call's own time inside a route call (the seam); null elsewhere. */
  modelMs: number | null;
  /** Whether the model overlay ran (the route's `llm`); null for a probe. */
  llm: boolean | null;
  status: number | null;
  raw: string;
  validJson: boolean;
  allKeys: boolean;
  directionValid: boolean;
  /** The categories the route returned. */
  categories: string[];
  /** GET /api/ps after the call; null when it could not be read. */
  resident: string[] | null;
}
const tierCalls: TierCall[] = [];

/** Nearest-rank percentile, p in 0..100; NaN for an empty sample. */
function percentileOf(sample: readonly number[], p: number): number {
  if (sample.length === 0) return NaN;
  const sorted = [...sample].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

interface ArmSummary {
  n: number;
  pickPct: number;
  obviousPct: number;
  allKeysPct: number;
  directionPct: number;
  overlayPct: number;
  p50: number;
  p95: number;
  max: number;
}
function summariseArm(calls: readonly TierCall[]): ArmSummary {
  const obvious = calls.filter((c) => c.kind === 'control');
  const right = obvious.filter((c) => (c.categories[0] ?? '').toLowerCase() === c.expected.toLowerCase()).length;
  const wall = calls.map((c) => c.wallMs);
  return {
    n: calls.length,
    pickPct: pct(calls.filter((c) => c.categories.length > 0).length, calls.length),
    obviousPct: pct(right, obvious.length),
    allKeysPct: pct(calls.filter((c) => c.allKeys).length, calls.length),
    directionPct: pct(calls.filter((c) => c.directionValid).length, calls.length),
    overlayPct: pct(calls.filter((c) => c.llm === true).length, calls.length),
    p50: percentileOf(wall, 50), p95: percentileOf(wall, 95), max: wall.length ? Math.max(...wall) : NaN,
  };
}

/** Reads R1 to R3 and the rule (D1 to D3) off the calls. The lead decides; this prints what the rule says. */
function tierReadOff(calls: readonly TierCall[]) {
  const arm = (a: TierArm): TierCall[] => calls.filter((c) => c.arm === a);
  const q = summariseArm(arm('Q'));
  const r1 = {
    pass: q.n > 0 && q.pickPct >= TIER_GATES.r1MinPickPct && q.obviousPct >= TIER_GATES.r1MinObviousPct
      && q.allKeysPct >= TIER_GATES.r1MinAllKeysPct && q.directionPct >= TIER_GATES.r1MinDirectionPct,
  };
  const cold = arm('COLD');
  const warmOk = q.n > 0 && q.p50 <= TIER_GATES.r2WarmP50Ms && q.p95 <= TIER_GATES.r2WarmP95Ms && q.overlayPct === 100;
  const coldOk = cold.length === TIER_GATES.coldTrials && cold.every((c) => c.llm === true && c.wallMs <= TIER_GATES.ceilingMs);
  const r2 = { pass: warmOk && coldOk, warmOk, coldOk };
  const mix = arm('MIX_Q');
  const slowAbove = TIER_GATES.r3SlowFactor * q.p50;
  const slow = mix.filter((c) => c.wallMs > slowAbove).length;
  const slowPct = pct(slow, mix.length);
  const r3 = { pass: mix.length > 0 && slowPct <= TIER_GATES.r3MaxSlowPct && mix.every((c) => c.llm === true), slow, slowPct, of: mix.length, slowAbove };
  const lines: string[] = [];
  const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
  for (const a of ['B', 'Q', 'Q2'] as const) {
    const s = summariseArm(arm(a));
    if (s.n === 0) continue;
    lines.push(`${a.padEnd(2)} n ${s.n}: pick ${f(s.pickPct)}%, obvious titles right ${f(s.obviousPct)}%, all nine keys ${f(s.allKeysPct)}%, direction ok ${f(s.directionPct)}%, overlay ran ${f(s.overlayPct)}%, `
      + `route wall p50 ${f(s.p50)} / p95 ${f(s.p95)} / max ${f(s.max)} ms`);
  }
  lines.push(`R1 QUALITY ${r1.pass ? 'PASS' : 'FAIL'} (Q: pick ${f(q.pickPct)}% of >= ${TIER_GATES.r1MinPickPct}, obvious ${f(q.obviousPct)}% of >= ${TIER_GATES.r1MinObviousPct}, `
    + `keys ${f(q.allKeysPct)}% of >= ${TIER_GATES.r1MinAllKeysPct}, direction ${f(q.directionPct)}% of >= ${TIER_GATES.r1MinDirectionPct})`);
  lines.push(`R2 LATENCY ${r2.pass ? 'PASS' : 'FAIL'} (warm p50 ${f(q.p50)} ms of <= ${TIER_GATES.r2WarmP50Ms}, p95 ${f(q.p95)} ms of <= ${TIER_GATES.r2WarmP95Ms}, overlay on ${f(q.overlayPct)}% of calls; `
    + `cold ${cold.length} trials ${cold.map((c) => `${c.wallMs.toFixed(0)} ms${c.llm === true ? '' : ' NO OVERLAY'}`).join(', ') || 'none'}, limit ${TIER_GATES.ceilingMs} ms)`);
  lines.push(`R3 RESIDENCY ${r3.pass ? 'PASS' : 'FAIL'} (${r3.slow} of ${r3.of} MIX route calls over ${f(r3.slowAbove)} ms = ${TIER_GATES.r3SlowFactor} x Q's warm median, ${f(r3.slowPct)}% of <= ${TIER_GATES.r3MaxSlowPct}%)`);
  const decision = !(r1.pass && r2.pass) ? 'D2: not recommended (R1 or R2 failed)'
    : r3.pass ? 'D1: recommended' : 'D1 with D3: recommended, and R3 failed, so on a box with fewer model slots than models in rotation quick add pays a model swap';
  lines.push(`D the rule says: ${decision}.`);
  return { q, r1, r2, r3, lines, decision };
}

function tierFlush(): void {
  if (!OUT) return;
  writeFileSync(OUT, JSON.stringify({
    harness: 'classification-shape-live', mode: 'quality-tier', startedAt, writtenAt: new Date().toISOString(),
    command: provenance.command ?? null,
    env: { runs: RUNS, models: MODELS, ollamaUrl: redactUrl(config.ollamaUrl), ollamaVersion, ollamaInTestProcess: envWithPrefix(process.env, 'OLLAMA_'), liveShape: envWithPrefix(process.env, 'LIVE_') },
    provenance, tierGates: TIER_GATES, fixture: { conventions: CONVENTIONS, controls: CONTROLS },
    violations, prompts: Object.fromEntries(distinctPrompts), calls: tierCalls,
  }, null, 2));
}

async function residentNames(): Promise<string[] | null> {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/ps`);
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name).sort();
  } catch {
    return null;
  }
}

/** One route call, timed, with what the seam saw of its first model call. */
async function routeCall(arm: TierArm, item: { title: string; kind: TierCall['kind']; expected: string }, run: number, record = true): Promise<TierCall> {
  const t0 = performance.now();
  const { value: res, calls } = await seamOf(() => parseViaRoute(item.title));
  const wallMs = performance.now() - t0;
  const seam = calls.find((c) => !c.dry);
  const raw = seam?.raw ?? '';
  if (seam?.prompt) distinctPrompts.set(sha12(seam.prompt), seam.prompt);
  let strict: Record<string, unknown> | null = null;
  try {
    const j: unknown = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) strict = j as Record<string, unknown>;
  } catch { /* not strict JSON */ }
  const call: TierCall = {
    arm, title: item.title, kind: item.kind, expected: item.expected, run, wallMs, modelMs: seam ? seam.ms : null,
    llm: typeof res?.body?.llm === 'boolean' ? res.body.llm : null, status: res?.status ?? null,
    raw, validJson: strict !== null, allKeys: strict !== null && WIDE_KEYS.every((k) => k in strict!),
    directionValid: directionOf(raw, DIRECTIONS).valid,
    categories: Array.isArray(res?.body?.parsed?.categories) ? (res!.body.parsed.categories as string[]) : [],
    resident: await residentNames(),
  };
  if (record) tierCalls.push(call);
  return call;
}

/** Unload the quality model, then wait up to 15 s for /api/ps to stop listing it. True when it is gone. */
async function unloadQuality(model: string): Promise<boolean> {
  await fetch(`${config.ollamaUrl}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }),
  });
  const gone = (names: string[] | null): boolean => names !== null && !names.some((n) => matchInstalled(n)?.name === matchInstalled(model)?.name);
  for (let i = 0; i < 30; i++) {
    if (gone(await residentNames())) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runTier(): Promise<void> {
  rec.model = '';
  resetWorld();
  const quality = await resolveModel('quality');
  say(`\n=== quality-tier measurement: fast ${await resolveModel('fast')}, quality ${quality} ===`);
  for (const arm of ['B', 'Q', 'Q2'] as const) {
    rec.tier = arm === 'B' ? 'fast' : '';
    for (const w of ITEMS.slice(0, 2)) await routeCall(arm, w, -1, false); // load this block's model, unrecorded
    for (const item of ITEMS) {
      for (let run = 0; run < RUNS; run++) await routeCall(arm, item, run);
    }
    tierFlush();
    const s = summariseArm(tierCalls.filter((c) => c.arm === arm));
    say(`${arm}: ${s.n} route calls, pick ${s.pickPct.toFixed(1)}%, obvious right ${s.obviousPct.toFixed(1)}%, keys ${s.allKeysPct.toFixed(1)}%, route wall p50 ${s.p50.toFixed(0)} / p95 ${s.p95.toFixed(0)} ms`);
  }
  rec.tier = '';
  for (let trial = 0; trial < TIER_GATES.coldTrials; trial++) {
    const gone = await unloadQuality(quality);
    if (!gone) violate('tier', `cold trial ${trial}: ${quality} was still listed by /api/ps 15 s after the unload`);
    const item = ITEMS[trial];
    const c = await routeCall('COLD', item, trial);
    say(`cold ${trial}: unloaded ${gone}, first route call ${c.wallMs.toFixed(0)} ms (model ${c.modelMs?.toFixed(0)} ms), overlay ${c.llm}`);
  }
  for (let cycle = 0; cycle < TIER_GATES.mixCycles; cycle++) {
    const item = ITEMS[cycle % ITEMS.length];
    const qc = await routeCall('MIX_Q', item, cycle);
    const t1 = performance.now();
    await seamOf(() => generateJson('Give two short subtasks for "Plan a trip". Reply with JSON {"subtasks": ["...", "..."]}.', { purpose: 'brainstorm' }));
    const fMs = performance.now() - t1;
    tierCalls.push({ arm: 'MIX_F', title: 'fast-tier probe', kind: 'probe', expected: '', run: cycle, wallMs: fMs, modelMs: null, llm: null, status: null, raw: '', validJson: false, allKeys: false, directionValid: false, categories: [], resident: await residentNames() });
    const t2 = performance.now();
    try { await embed('Plan the quarterly review', 20_000); } catch { /* the call is timed either way */ }
    const eMs = performance.now() - t2;
    tierCalls.push({ arm: 'MIX_E', title: 'embed probe', kind: 'probe', expected: '', run: cycle, wallMs: eMs, modelMs: null, llm: null, status: null, raw: '', validJson: false, allKeys: false, directionValid: false, categories: [], resident: await residentNames() });
    if (cycle % 5 === 4) say(`mix ${cycle + 1}/${TIER_GATES.mixCycles}: last route ${qc.wallMs.toFixed(0)} ms, fast-tier ${fMs.toFixed(0)} ms, embed ${eMs.toFixed(0)} ms, resident ${JSON.stringify(tierCalls[tierCalls.length - 1].resident)}`);
  }
  tierFlush();
}

// ── The learning-curve measurement, live (LIVE_LEARN=1; the gates are pre-registered in the header) ──────

const LEARN_LEVELS = [0, 3, 6, 9, 12, 18] as const;
const LEARN_RUNS = 3;
const LEARN_GATES = {
  /** L1: targets right at the top level over level 0, titles. */
  l1MinNetTitles: 2,
  /** L1: level 0 against its repeat may move at most this many target titles. */
  l1NoiseTitles: 2,
  /** L2: controls may lose at most this many titles. */
  l2MaxLostControls: 1,
  /** L3: points the all-nine-keys and valid-direction shares may fall. */
  l3MaxKeysDropPoints: 5,
  l3MaxDirectionDropPoints: 10,
  /** L4: the model's p50 over the reference's p50 at most. */
  l4MaxP50Share: 0.5,
} as const;
/** The first line of exemplarPrompt's block: present in a prompt exactly when a hint reached it. */
const HINT_MARKER = 'This user has corrected you before.';
const LEARN_TOP = LEARN_LEVELS[LEARN_LEVELS.length - 1];

interface LearnCall {
  model: string;
  level: number;
  pass: 'curve' | 'noise';
  title: string;
  kind: 'target' | 'control';
  expected: string;
  run: number;
  wallMs: number;
  categories: string[];
  raw: string;
  validJson: boolean;
  allKeys: boolean;
  directionValid: boolean;
  hinted: boolean;
  llm: boolean | null;
}
interface LearnLevel { model: string; level: number; captured: number; claims: number; corrections: number; indexed: number }
const learnCalls: LearnCall[] = [];
const learnLevels: LearnLevel[] = [];

const learnSet = (calls: readonly LearnCall[], model: string, level: number, pass: 'curve' | 'noise'): LearnCall[] =>
  calls.filter((c) => c.model === model && c.level === level && c.pass === pass);

/** Titles of `kind` whose strict majority of runs named the owner's category first. */
function learnTitlesRight(set: readonly LearnCall[], kind: 'target' | 'control'): string[] {
  const titles = [...new Set(set.filter((c) => c.kind === kind).map((c) => c.title))];
  return titles.filter((t) => {
    const runs = set.filter((c) => c.title === t);
    const right = runs.filter((c) => (c.categories[0] ?? '').toLowerCase() === c.expected.toLowerCase()).length;
    return 2 * right > runs.length;
  });
}

interface LearnPoint { targets: number; controls: number; keysPct: number; directionPct: number; hintedPct: number; p50: number; n: number }
function learnPoint(set: readonly LearnCall[]): LearnPoint {
  return {
    targets: learnTitlesRight(set, 'target').length, controls: learnTitlesRight(set, 'control').length,
    keysPct: pct(set.filter((c) => c.allKeys).length, set.length), directionPct: pct(set.filter((c) => c.directionValid).length, set.length),
    hintedPct: pct(set.filter((c) => c.hinted).length, set.length), p50: percentileOf(set.map((c) => c.wallMs), 50), n: set.length,
  };
}

/** Reads L1 to L4 and the rule (D1 to D3) off the calls. The lead decides; this prints what the rule says. */
function learnReadOff(calls: readonly LearnCall[], models: readonly string[]) {
  const lines: string[] = [];
  const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
  const per = new Map<string, {
    k0: LearnPoint; top: LearnPoint; l1: 'PASS' | 'FAIL' | 'INCONCLUSIVE: NOISE'; l2: boolean; l3: boolean; learns: boolean; needs: number | null; noiseFlips: number;
  }>();
  for (const model of models) {
    const at = (level: number, pass: 'curve' | 'noise' = 'curve') => learnSet(calls, model, level, pass);
    const k0 = learnPoint(at(0)), top = learnPoint(at(LEARN_TOP));
    if (k0.n === 0 || top.n === 0) { lines.push(`${model}: no data at level 0 and ${LEARN_TOP}`); continue; }
    const right0 = new Set(learnTitlesRight(at(0), 'target'));
    const repeat = new Set(learnTitlesRight(at(0, 'noise'), 'target'));
    const noiseFlips = at(0, 'noise').length === 0 ? 0 : [...new Set([...right0, ...repeat])].filter((t) => right0.has(t) !== repeat.has(t)).length;
    const net = top.targets - k0.targets;
    const l1 = noiseFlips > LEARN_GATES.l1NoiseTitles ? 'INCONCLUSIVE: NOISE' : net >= LEARN_GATES.l1MinNetTitles ? 'PASS' : 'FAIL';
    const l2 = top.controls >= k0.controls - LEARN_GATES.l2MaxLostControls;
    const l3 = top.keysPct >= k0.keysPct - LEARN_GATES.l3MaxKeysDropPoints && top.directionPct >= k0.directionPct - LEARN_GATES.l3MaxDirectionDropPoints;
    const needs = LEARN_LEVELS.find((k) => k > 0 && learnPoint(at(k)).n > 0 && learnPoint(at(k)).targets - k0.targets >= LEARN_GATES.l1MinNetTitles) ?? null;
    per.set(model, { k0, top, l1, l2, l3, learns: l1 === 'PASS' && l2 && l3, needs, noiseFlips });
    lines.push(`${model}: curve (targets/12, controls/12, all-nine-keys %, valid direction %, hinted %, route p50 ms) ${LEARN_LEVELS.map((k) => {
      const q = learnPoint(at(k));
      return q.n === 0 ? `k${k} -` : `k${k} ${q.targets}/${q.controls}/${f(q.keysPct)}/${f(q.directionPct)}/${f(q.hintedPct)}/${f(q.p50)}`;
    }).join('  ')}`);
    lines.push(`${model}: L1 ${l1} (targets ${k0.targets} to ${top.targets}, net ${net}, level 0 against its repeat moved ${noiseFlips}), L2 ${l2 ? 'PASS' : 'FAIL'} (controls ${k0.controls} to ${top.controls}), `
      + `L3 ${l3 ? 'PASS' : 'FAIL'} (keys ${f(k0.keysPct)} to ${f(top.keysPct)}%, direction ${f(k0.directionPct)} to ${f(top.directionPct)}%), needs ${needs === null ? 'more than ' + LEARN_TOP + ' corrections or never' : needs + ' corrections'}`);
  }
  const ref = per.get(REFERENCE_TIER);
  const refTotal0 = ref ? ref.k0.targets + ref.k0.controls : NaN;
  const small: string[] = [];
  for (const [model, r] of per) {
    if (model === REFERENCE_TIER) continue;
    const total = r.top.targets + r.top.controls;
    const l4 = ref !== undefined && total >= refTotal0 && r.top.p50 <= LEARN_GATES.l4MaxP50Share * ref.k0.p50;
    lines.push(`${model}: L4 ${ref === undefined ? 'NOT RUN (no reference)' : l4 ? 'PASS' : 'FAIL'} (${total}/24 right at k${LEARN_TOP} against the reference's ${f(refTotal0)}/24 at k0; route p50 ${f(r.top.p50)} ms against ${ref ? f(ref.k0.p50) : 'n/a'} ms, limit ${LEARN_GATES.l4MaxP50Share} of it)`);
    if (r.learns && l4) small.push(model);
  }
  if (ref) lines.push(`${REFERENCE_TIER} (the reference) at k${LEARN_TOP}: ${ref.top.targets + ref.top.controls}/24 right, p50 ${f(ref.top.p50)} ms`);
  const learners = [...per].filter(([, r]) => r.learns).map(([m]) => m);
  lines.push(`D1 learns (L1, L2, L3): ${learners.join(', ') || 'none'}.`);
  lines.push(small.length ? `D2 small and learned (learns and L4): ${small.join(', ')}.` : 'D3 no model other than the reference is small and learned: none reaches the quality model through the hint on this fixture.');
  return { per, lines, learners, small };
}

function learnFlush(): void {
  if (!OUT) return;
  writeFileSync(OUT, JSON.stringify({
    harness: 'classification-shape-live', mode: 'learning-curve', startedAt, writtenAt: new Date().toISOString(),
    command: provenance.command ?? null,
    env: { models: MODELS, runs: LEARN_RUNS, ollamaUrl: redactUrl(config.ollamaUrl), ollamaVersion, ollamaInTestProcess: envWithPrefix(process.env, 'OLLAMA_'), liveShape: envWithPrefix(process.env, 'LIVE_') },
    provenance, learnGates: LEARN_GATES, levels: LEARN_LEVELS, fixture: { conventions: CONVENTIONS, controls: CONTROLS },
    violations, prompts: Object.fromEntries(distinctPrompts), levelsRun: learnLevels, calls: learnCalls,
  }, null, 2));
}

/** The 18 training titles, the three conventions interleaved. */
const LEARN_ORDER: FixtureItem[] = Array.from({ length: 6 }, (_, i) =>
  CONVENTIONS.map((c) => TRAIN_ITEMS.find((t) => t.title === c.train[i])!)).flat();

async function learnMeasure(model: string, level: number, pass: 'curve' | 'noise'): Promise<void> {
  for (const item of [...TARGET_ITEMS, ...CONTROL_ITEMS]) {
    for (let run = 0; run < LEARN_RUNS; run++) {
      const t0 = performance.now();
      const { value: res, calls } = await seamOf(() => parseViaRoute(item.title));
      const wallMs = performance.now() - t0;
      const seam = calls.find((c) => !c.dry);
      const raw = seam?.raw ?? '';
      const prompt = seam?.prompt ?? '';
      if (prompt) distinctPrompts.set(sha12(prompt), prompt);
      let strict: Record<string, unknown> | null = null;
      try {
        const j: unknown = JSON.parse(raw);
        if (j && typeof j === 'object' && !Array.isArray(j)) strict = j as Record<string, unknown>;
      } catch { /* not strict JSON */ }
      learnCalls.push({
        model, level, pass, title: item.title, kind: item.kind === 'control' ? 'control' : 'target', expected: item.expected, run, wallMs,
        categories: Array.isArray(res?.body?.parsed?.categories) ? (res!.body.parsed.categories as string[]) : [],
        raw, validJson: strict !== null, allKeys: strict !== null && WIDE_KEYS.every((k) => k in strict!),
        directionValid: directionOf(raw, DIRECTIONS).valid, hinted: prompt.includes(HINT_MARKER),
        llm: typeof res?.body?.llm === 'boolean' ? res.body.llm : null,
      });
    }
  }
}

/** The wizard's path for one training title: the model's own pick, then the owner's category with the claim echoed. */
async function learnCapture(model: string, item: FixtureItem): Promise<boolean> {
  const { value: parsed, calls } = await seamOf(() => parseViaRoute(item.title));
  const seam = calls.find((c) => !c.dry);
  if (seam) distinctPrompts.set(sha12(seam.prompt), seam.prompt);
  const claim = parsed?.body?.classification_claim as { text: string; categories: string[] } | undefined;
  const title = (parsed?.body?.parsed?.title as string | undefined) ?? item.title;
  const created = await api(srv.url, '/api/tasks', {
    method: 'POST', json: { title, categories: [item.expected], ...(claim ? { classification_claim: claim } : {}) },
  });
  if (created.status !== 201) violate(model, `learn capture "${item.title}": POST /api/tasks answered ${created.status}`);
  return claim !== undefined;
}

async function runLearn(model: string): Promise<void> {
  rec.model = model;
  rec.tier = '';
  say(`\n=== ${model} (learning curve) ===`);
  await warm(model);
  resetWorld();
  let captured = 0;
  let claims = 0;
  for (const level of LEARN_LEVELS) {
    while (captured < level) {
      if (await learnCapture(model, LEARN_ORDER[captured])) claims++;
      captured++;
    }
    let corrections = 0;
    let indexed = 0;
    if (level > 0) {
      const cal = await calibrateClassification(OWNER, new Date(), { embedFn: null });
      const cat = cal.fields.find((f) => f.field === 'category');
      corrections = cat?.corrections ?? 0;
      indexed = cat?.indexed ?? 0;
    }
    learnLevels.push({ model, level, captured, claims, corrections, indexed });
    await learnMeasure(model, level, 'curve');
    learnFlush();
    const q = learnPoint(learnSet(learnCalls, model, level, 'curve'));
    say(`${model} k${level}: captured ${captured}, claims ${claims}, corrections ${corrections}, indexed ${indexed}; targets ${q.targets}/12, controls ${q.controls}/12, keys ${q.keysPct.toFixed(1)}%, direction ${q.directionPct.toFixed(1)}%, hinted ${q.hintedPct.toFixed(1)}%, route p50 ${q.p50.toFixed(0)} ms`);
  }
  // The noise floor: a clean owner again (no corrections, no index), level 0 measured a second time.
  resetWorld();
  await learnMeasure(model, 0, 'noise');
  learnFlush();
}

// ── The shape-fix measurement, suite ─────────────────────────────────────────

describe.skipIf(!LIVE)('classification shape · shape-fix measurement', () => {
  beforeAll(prepareLive);

  afterAll(async () => {
    await srv?.close();
  });

  for (const model of MODELS) {
    it(`${model}: ${ITEMS.length} titles x ${RUNS} runs x arms ${SHAPE_ARMS.join(', ')}`, async () => {
      await runShape(model);
    }, 6 * 60 * 60_000);
  }

  it('the rule, read off the calls (the lead decides; nothing here is asserted but the mechanism)', () => {
    shapeFlush();
    say(`\n[live-shape] shape-fix: ${shapeCalls.length} model calls recorded${OUT ? `, artifact at ${OUT}` : ' (set LIVE_SHAPE_OUT to keep them)'}.`);
    const decision = shapeDecision(shapeCalls, MODELS);
    for (const line of decision.lines) say(line);
    expect(violations, `mechanism violations:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe.skipIf(!TIER)('classification shape · quality-tier measurement', () => {
  beforeAll(async () => {
    await prepareLive();
    // The run is not valid unless the app itself resolves the tiers the question is about.
    const fast = await resolveModel('fast');
    const quality = await resolveModel('quality');
    say(`[live-shape] the app resolved fast ${fast}, quality ${quality}`);
    if (matchInstalled(fast)?.name !== matchInstalled('qwen2.5:0.5b')?.name) violate('tier', `the fast tier resolved to ${fast}, not qwen2.5:0.5b`);
    if (matchInstalled(quality)?.name !== matchInstalled('gemma3n:e4b')?.name) violate('tier', `the quality tier resolved to ${quality}, not gemma3n:e4b`);
  });

  afterAll(async () => {
    await srv?.close();
  });

  it('blocks B, Q and Q2, the cold calls and the mix, on the real route', async () => {
    expect(violations, 'the app did not resolve the tiers this run is about').toEqual([]);
    await runTier();
  }, 3 * 60 * 60_000);

  it('the rule, read off the calls (the lead decides; nothing here is asserted but the mechanism)', () => {
    tierFlush();
    say(`\n[live-shape] quality tier: ${tierCalls.length} calls recorded${OUT ? `, artifact at ${OUT}` : ' (set LIVE_SHAPE_OUT to keep them)'}.`);
    for (const line of tierReadOff(tierCalls).lines) say(line);
    expect(violations, `mechanism violations:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe.skipIf(!LEARN)('classification shape · learning-curve measurement', () => {
  beforeAll(prepareLive);

  afterAll(async () => {
    await srv?.close();
  });

  for (const model of MODELS) {
    it(`${model}: ${LEARN_LEVELS.join(', ')} corrections, ${LEARN_RUNS} runs on 24 held-out titles`, async () => {
      await runLearn(model);
    }, 3 * 60 * 60_000);
  }

  it('the rule, read off the calls (the lead decides; nothing here is asserted but the mechanism)', () => {
    learnFlush();
    say(`\n[live-shape] learning curve: ${learnCalls.length} calls recorded${OUT ? `, artifact at ${OUT}` : ' (set LIVE_SHAPE_OUT to keep them)'}.`);
    for (const line of learnReadOff(learnCalls, MODELS).lines) say(line);
    expect(violations, `mechanism violations:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe.skipIf(!REPLAY)('classification shape · replay of a recorded run', () => {
  it('re-reads the recorded completions with this file\'s readings and prints the rule\'s reading', () => {
    const artifact = JSON.parse(readFileSync(REPLAY, 'utf8')) as { mode: string; env: { models: string[] }; calls: ShapeCall[] };
    expect(artifact.mode).toBe('shape-fix');
    const calls = artifact.calls.map((c) => ({
      ...c,
      picks: {
        ...c.picks,
        strict: readCategories(c.raw, CATEGORIES, 'strict'), whole: readCategories(c.raw, CATEGORIES, 'whole'), split: readCategories(c.raw, CATEGORIES, 'split'),
      },
    }));
    // The readings recomputed from the raw text must be what the run recorded.
    for (const [i, c] of calls.entries()) {
      for (const r of ['strict', 'whole', 'split'] as const) expect(c.picks[r], `call ${i} ${c.model} ${c.arm} ${c.title} ${r}`).toEqual(artifact.calls[i].picks[r]);
    }
    const decision = shapeDecision(calls, artifact.env.models);
    say(`[replay] ${calls.length} calls from ${REPLAY}`);
    for (const line of decision.lines) say(line);
  });
});

// ── The pure parts: they run in every test run, no model ─────────────────────

describe('classification shape · pure parts', () => {
  describe('the quality-tier rule, on invented calls', () => {
    const tc = (arm: TierArm, over: Partial<TierCall> = {}): TierCall => ({
      arm, title: 't', kind: 'control', expected: 'health', run: 0, wallMs: 1500, modelMs: 1400, llm: true, status: 200, raw: '{}',
      validJson: true, allKeys: true, directionValid: true, categories: ['health'], resident: ['gemma3n:e4b'], ...over,
    });
    const many = (n: number, arm: TierArm, over: (i: number) => Partial<TierCall> = () => ({})): TierCall[] =>
      Array.from({ length: n }, (_, i) => tc(arm, { run: i, ...over(i) }));
    const cold = (...ms: number[]): TierCall[] => ms.map((wallMs, i) => tc('COLD', { run: i, wallMs }));
    const good = (): TierCall[] => [...many(20, 'Q'), ...cold(6000, 7000, 6500), ...many(20, 'MIX_Q')];
    const verdicts = (calls: TierCall[]) => {
      const r = tierReadOff(calls);
      return { r1: r.r1.pass, r2: r.r2.pass, r3: r.r3.pass, decision: r.decision, lines: r.lines };
    };

    it('recommends the change when quality and latency hold, and says what each gate read', () => {
      const v = verdicts(good());
      expect([v.r1, v.r2, v.r3]).toEqual([true, true, true]);
      expect(v.decision).toBe('D1: recommended');
      expect(v.lines.filter((l) => /^R[123] /.test(l)).map((l) => l.split(' ')[1])).toEqual(['QUALITY', 'LATENCY', 'RESIDENCY']);
    });

    it('R1 reads the pick share, the obvious titles, the keys and the direction at their marks', () => {
      // 20 calls: 19 picks = 95%, 18 = 90%.
      const picks = (k: number) => [...many(20, 'Q', (i) => (i < k ? {} : { categories: [] })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect(verdicts(picks(19)).r1).toBe(true);
      expect(verdicts(picks(18)).r1).toBe(false);
      // 10 obvious titles: 9 right = 90%, 8 right = 80%.
      const obvious = (k: number) => [...many(10, 'Q', (i) => (i < k ? {} : { categories: ['finance'] })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect(verdicts(obvious(9)).r1).toBe(true);
      expect(verdicts(obvious(8)).r1).toBe(false);
      const keys = (k: number) => [...many(10, 'Q', (i) => (i < k ? {} : { allKeys: false })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect([verdicts(keys(9)).r1, verdicts(keys(8)).r1]).toEqual([true, false]);
      const dir = (k: number) => [...many(10, 'Q', (i) => (i < k ? {} : { directionValid: false })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect([verdicts(dir(9)).r1, verdicts(dir(8)).r1]).toEqual([true, false]);
      // Only the control titles count as obvious: a wrong pick on a target title does not move that figure.
      const targets = [...many(10, 'Q'), ...many(10, 'Q', () => ({ kind: 'target', categories: ['finance'] })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect(verdicts(targets).r1).toBe(true);
    });

    it('R2 holds the warm p50 and p95, every overlay, and every cold call inside the ceiling', () => {
      const warm = (slow: number, ms: number) => [...many(100, 'Q', (i) => ({ wallMs: i < 100 - slow ? 1500 : ms })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect(verdicts(warm(5, 6000)).r2).toBe(true); // the 95th of 100 is still a fast one
      expect(verdicts(warm(6, 6000)).r2).toBe(false); // p95 6000 > 5000
      expect(verdicts([...many(20, 'Q', () => ({ wallMs: 2600 })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')]).r2).toBe(false); // p50 over
      expect(verdicts([...many(20, 'Q', (i) => (i === 0 ? { llm: false } : {})), ...cold(1, 1, 1), ...many(20, 'MIX_Q')]).r2).toBe(false); // one call without the overlay
      expect(verdicts([...many(20, 'Q'), ...cold(1, 1), ...many(20, 'MIX_Q')]).r2).toBe(false); // two cold trials, not three
      expect(verdicts([...many(20, 'Q'), ...cold(1, 1, 15_001), ...many(20, 'MIX_Q')]).r2).toBe(false); // over the ceiling
      expect(verdicts([...many(20, 'Q'), ...cold(1, 1, 15_000), ...many(20, 'MIX_Q')]).r2).toBe(true); // at it
      const coldNoOverlay = [...many(20, 'Q'), ...cold(1, 1, 1).map((c, i) => (i === 2 ? { ...c, llm: false } : c)), ...many(20, 'MIX_Q')];
      expect(verdicts(coldNoOverlay).r2).toBe(false);
    });

    it('R3 counts MIX route calls over three warm medians, 10% allowed, and a miss is D1 with D3 when R1 and R2 hold', () => {
      const mix = (slow: number) => [...many(20, 'Q'), ...cold(1, 1, 1), ...many(20, 'MIX_Q', (i) => (i < slow ? { wallMs: 4501 } : { wallMs: 4500 }))];
      expect(verdicts(mix(0)).r3).toBe(true); // 4500 is not over 3 x 1500
      expect(verdicts(mix(2)).r3).toBe(true); // 10%
      const three = verdicts(mix(3));
      expect(three.r3).toBe(false);
      expect(three.decision).toMatch(/^D1 with D3: recommended, and R3 failed/);
      expect(verdicts([...many(20, 'Q'), ...cold(1, 1, 1)]).r3).toBe(false); // no MIX calls, nothing to read
      expect(verdicts([...many(20, 'Q'), ...cold(1, 1, 1), ...many(20, 'MIX_Q', (i) => (i === 0 ? { llm: false } : {}))]).r3).toBe(false);
    });

    it('is not recommended when R1 or R2 fails, whatever R3 says', () => {
      const r1Fails = [...many(20, 'Q', () => ({ categories: [] })), ...cold(1, 1, 1), ...many(20, 'MIX_Q')];
      expect(verdicts(r1Fails).decision).toBe('D2: not recommended (R1 or R2 failed)');
      const r2Fails = [...many(20, 'Q', () => ({ wallMs: 9000 })), ...cold(1, 1, 1), ...many(20, 'MIX_Q', () => ({ wallMs: 99_999 }))];
      expect(verdicts(r2Fails).decision).toBe('D2: not recommended (R1 or R2 failed)');
      expect(verdicts([]).decision).toBe('D2: not recommended (R1 or R2 failed)');
    });

    it('reports B and Q2 beside Q and never gates on them, and the percentile is nearest-rank', () => {
      const withB = [...good(), ...many(20, 'B', () => ({ categories: [], allKeys: false, wallMs: 90 })), ...many(20, 'Q2', () => ({ wallMs: 1600 }))];
      expect(verdicts(withB).decision).toBe('D1: recommended');
      expect(verdicts(withB).lines.filter((l) => /^(B|Q|Q2) /.test(l))).toHaveLength(3);
      expect(percentileOf([5, 1, 3, 2, 4], 50)).toBe(3);
      expect(percentileOf(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
      expect(Number.isNaN(percentileOf([], 50))).toBe(true);
    });
  });

  describe('the learning-curve rule, on invented calls', () => {
    const M = 'small-model';
    const REF = REFERENCE_TIER;
    /** 12 target and 12 control titles x 3 runs at one level: the first `t` targets and `c` controls are right on every run. */
    const level = (model: string, k: number, t: number, c: number, over: Partial<LearnCall> = {}, pass: 'curve' | 'noise' = 'curve'): LearnCall[] =>
      (['target', 'control'] as const).flatMap((kind) => Array.from({ length: 12 }, (_, i) => i).flatMap((i) =>
        [0, 1, 2].map((run): LearnCall => ({
          model, level: k, pass, title: `${kind}-${i}`, kind, expected: 'leisure', run, wallMs: 500, categories: [i < (kind === 'target' ? t : c) ? 'leisure' : 'health'],
          raw: '{}', validJson: true, allKeys: true, directionValid: true, hinted: k >= 3, llm: true, ...over,
        }))));
    /** A model's whole run: level 0 (and its repeat) then the top level, the middle levels copying level 0 unless given. */
    const run = (model: string, k0: [number, number], top: [number, number], over: { k0?: Partial<LearnCall>; top?: Partial<LearnCall>; repeat?: [number, number] } = {}): LearnCall[] => [
      ...level(model, 0, k0[0], k0[1], over.k0), ...level(model, LEARN_TOP, top[0], top[1], over.top),
      ...level(model, 0, (over.repeat ?? k0)[0], (over.repeat ?? k0)[1], over.k0, 'noise'),
    ];
    const read = (calls: LearnCall[], models: string[]) => learnReadOff(calls, models);

    it('a model that gains two target titles and keeps the rest LEARNS, and one that gains one does not', () => {
      expect(read(run(M, [3, 12], [5, 12]), [M]).learners).toEqual([M]);
      expect(read(run(M, [3, 12], [4, 12]), [M]).learners).toEqual([]);
      const r = read(run(M, [3, 12], [7, 12]), [M]).per.get(M)!;
      expect([r.l1, r.l2, r.l3, r.learns]).toEqual(['PASS', true, true, true]);
    });

    it('L1 is inconclusive when level 0 moves more than two target titles against its repeat', () => {
      // k0 right on targets 0-2 (3 titles); the repeat right on targets 0-5 (6): the sets differ by 3 titles.
      const r = read(run(M, [3, 12], [9, 12], { repeat: [6, 12] }), [M]).per.get(M)!;
      expect(r.noiseFlips).toBe(3);
      expect(r.l1).toBe('INCONCLUSIVE: NOISE');
      expect(r.learns).toBe(false);
      expect(read(run(M, [3, 12], [9, 12], { repeat: [5, 12] }), [M]).per.get(M)!.l1).toBe('PASS'); // two flips are within the noise allowance
    });

    it('L2 lets controls lose one title and no more', () => {
      expect(read(run(M, [3, 12], [8, 11]), [M]).per.get(M)!.l2).toBe(true);
      expect(read(run(M, [3, 12], [8, 10]), [M]).per.get(M)!.l2).toBe(false);
      expect(read(run(M, [3, 12], [8, 10]), [M]).learners).toEqual([]);
    });

    it('L3 lets the keys fall 5 points and the direction 10, and no more', () => {
      // 72 calls at the top level (12 + 12 titles x 3 runs): 3 calls is 4.2 points, 4 calls 5.6; 7 calls is 9.7 points, 8 calls 11.1.
      const drop = (field: 'allKeys' | 'directionValid', n: number): LearnCall[] =>
        run(M, [3, 12], [8, 12]).map((c, i) => (c.level === LEARN_TOP && i % 72 < n ? { ...c, [field]: false } : c));
      expect(read(drop('allKeys', 3), [M]).per.get(M)!.l3).toBe(true);
      expect(read(drop('allKeys', 4), [M]).per.get(M)!.l3).toBe(false);
      expect(read(drop('directionValid', 7), [M]).per.get(M)!.l3).toBe(true);
      expect(read(drop('directionValid', 8), [M]).per.get(M)!.l3).toBe(false);
    });

    it('reads "needs k corrections" off the smallest level that is two titles up', () => {
      const calls = [...level(M, 0, 3, 12), ...level(M, 3, 4, 12), ...level(M, 6, 5, 12), ...level(M, 9, 7, 12), ...level(M, 12, 7, 12), ...level(M, LEARN_TOP, 8, 12), ...level(M, 0, 3, 12, {}, 'noise')];
      expect(read(calls, [M]).per.get(M)!.needs).toBe(6);
      expect(read(run(M, [3, 12], [4, 12]), [M]).per.get(M)!.needs).toBeNull();
    });

    it('L4 and D2: a model is small and learned only when it learns, matches the reference at level 0 and is twice as fast', () => {
      const ref = run(REF, [3, 12], [7, 12], { k0: { wallMs: 1500 }, top: { wallMs: 1500 } }); // reference: 15/24 at k0, p50 1500
      const fast = run(M, [3, 4], [7, 11], { k0: { wallMs: 100 }, top: { wallMs: 700 } }); // 18/24 at the top, p50 700 <= 750
      const r1 = read([...ref, ...fast], [M, REF]);
      expect(r1.small).toEqual([M]);
      expect(r1.lines.some((l) => l.startsWith('D2 small and learned'))).toBe(true);
      const slow = run(M, [3, 4], [7, 11], { k0: { wallMs: 100 }, top: { wallMs: 800 } }); // p50 800 > 750
      const r2 = read([...ref, ...slow], [M, REF]);
      expect(r2.small).toEqual([]);
      expect(r2.lines.some((l) => l.startsWith('D3 no model other than the reference'))).toBe(true);
      const weak = run(M, [3, 1], [7, 3], { top: { wallMs: 100 } }); // learns targets, but 10/24 < the reference's 15/24
      expect(read([...ref, ...weak], [M, REF]).small).toEqual([]);
      expect(read(fast, [M]).lines.some((l) => l.includes('L4 NOT RUN (no reference)'))).toBe(true); // no reference, no verdict
    });

    it('the reference is never judged against itself', () => {
      const r = read(run(REF, [3, 12], [7, 12]), [REF]);
      expect(r.lines.filter((l) => l.includes('L4'))).toHaveLength(0);
      expect(r.learners).toEqual([REF]);
    });

    it('LEARN_ORDER is the 18 training titles with the three conventions interleaved', () => {
      expect(LEARN_ORDER).toHaveLength(18);
      expect(new Set(LEARN_ORDER.map((i) => i.title)).size).toBe(18);
      expect(LEARN_ORDER.slice(0, 6).map((i) => i.convention)).toEqual(['exercise-leisure', 'invoices-career', 'inner-work-growth', 'exercise-leisure', 'invoices-career', 'inner-work-growth']);
    });
  });

  it('the fixture is well formed against the real parser', () => {
    expect(fixtureProblems()).toEqual([]);
    expect(TRAIN_ITEMS).toHaveLength(18);
    expect(TARGET_ITEMS).toHaveLength(12);
    expect(CONTROL_ITEMS).toHaveLength(12);
  });

  it('categoriesTypeOf reads the shape production sees', () => {
    expect(categoriesTypeOf('{"direction":"community","categories":"leisure","tags":[]}')).toBe('string');
    expect(categoriesTypeOf('{"categories":["leisure"]}')).toBe('array');
    expect(categoriesTypeOf('```json\n{"categories":["health"]}\n```')).toBe('array'); // the loose parse production uses
    expect(categoriesTypeOf('{"direction":"home"}')).toBe('missing');
    expect(categoriesTypeOf('')).toBe('missing');
    expect(categoriesTypeOf('{"categories":null}')).toBe('other');
    expect(categoriesTypeOf('{"categories":7}')).toBe('other');
  });

  it('the categories line is swapped alone and once, and swapping it back gives the stock prompt', async () => {
    const text = 'Leg day at the gym';
    const vocab: Vocab = { directions: DIRECTIONS, categories: CATEGORIES, others: OTHERS };
    const stock = await dryPrompt(() => enrichQuick(text, parseQuick(text), vocab));
    expect(stock, 'enrichQuick put no prompt in front of the model').not.toBe('');
    expect(occurrences(stock, categoriesLine(CATEGORIES, 'stock'))).toBe(1); // the stock line is the one enrichQuick sends today
    for (const w of ['W1', 'W2'] as const) {
      const worded = swapCategoriesLine(stock, CATEGORIES, w);
      expect(worded).not.toBe(stock);
      expect(worded.replace(categoriesLine(CATEGORIES, w), () => categoriesLine(CATEGORIES, 'stock'))).toBe(stock);
      expect(worded.split('\n')).toHaveLength(stock.split('\n').length); // a line replaced, none added
      expect(worded).toContain('JSON array');
    }
    expect(categoriesLine(CATEGORIES, 'W2')).toContain('["<area>"]'); // a placeholder, never one of the owner's names
    expect(CATEGORIES.some((c) => categoriesLine(CATEGORIES, 'W2').includes(`["${c}"]`))).toBe(false);
    expect(() => swapCategoriesLine(stock + categoriesLine(CATEGORIES, 'stock'), CATEGORIES, 'W1')).toThrow(/exactly once/);
    const bare = await dryPrompt(() => enrichQuick(text, parseQuick(text), { ...vocab, categories: [] }));
    expect(() => swapCategoriesLine(bare, [], 'W1')).toThrow(/exactly once/); // an owner with no categories is not asked for them
  });

  it('the readings: strict keeps arrays, whole takes a bare string as one whole name, split falls back to the commas', () => {
    const cats = ['health', 'Health, Fitness', 'leisure'];
    const read = (raw: string, r: 'strict' | 'whole' | 'split'): string[] => readCategories(raw, cats, r);
    // The first line is qwen2.5:0.5b on 45 of its 60 baseline completions.
    expect(read('{"direction":"community","categories":"leisure","tags":[]}', 'strict')).toEqual([]);
    expect(read('{"direction":"community","categories":"leisure","tags":[]}', 'whole')).toEqual(['leisure']);
    expect(read('{"categories":" Leisure "}', 'split')).toEqual(['leisure']);
    expect(read('{"categories":"work"}', 'split')).toEqual([]); // a direction is not a category, in any reading
    expect(read('{"categories":"health, leisure"}', 'whole')).toEqual([]); // not one name
    expect(read('{"categories":"health, leisure"}', 'split')).toEqual(['health', 'leisure']);
    expect(read('{"categories":"Health, Fitness"}', 'whole')).toEqual(['Health, Fitness']); // a comma inside a name
    expect(read('{"categories":"Health, Fitness"}', 'split')).toEqual(['Health, Fitness']); // the whole string first
    expect(read('{"categories":"health, leisure, health, leisure"}', 'split')).toEqual(['health', 'leisure']); // deduped by the same function
    for (const r of ['strict', 'whole', 'split'] as const) {
      expect(read('{"categories":["leisure","health"]}', r)).toEqual(['leisure', 'health']); // an array reads the same in all three
      expect(read('{"categories":["Leisure","nope"]}', r)).toEqual(['leisure']);
      for (const junk of ['{"categories":7}', '{"categories":null}', '{"categories":{"a":1}}', '{}', '', 'not json', 'null', '["leisure"]']) {
        expect(read(junk, r), `${r} ${junk}`).toEqual([]);
      }
    }
  });

  it('what mergeEnrichment really keeps is what the shipped reading says, completion by completion', () => {
    const vocab: Vocab = { directions: DIRECTIONS, categories: CATEGORIES, others: OTHERS };
    const raws = [
      '{"direction":"community","categories":"leisure","tags":[]}', '{"categories":"health, leisure"}', '{"categories":["leisure","health"]}',
      '{"categories":["Leisure"]}', '{"categories":"work"}', '{"categories":7}', '{"categories":null}', '{}', '', 'not json', 'null', '[1]',
      '```json\n{"categories":["finance","career","growth","health"]}\n```',
    ];
    for (const raw of raws) {
      expect(productionCategories(raw, 'Leg day at the gym', vocab), JSON.stringify(raw))
        .toEqual(readCategories(raw, CATEGORIES, SHIPPED_READING));
    }
  });

  describe('the registered rule, on invented calls', () => {
    const Q = 'qwen2.5:0.5b';
    const G = 'gemma3:1b';
    const R = REFERENCE_TIER;
    const sc = (model: string, arm: ShapeArm, title: string, run: number, picks: Partial<Record<Reading, string[]>>, over: Partial<ShapeCall> = {}): ShapeCall => ({
      arm, model, title, kind: 'target', expected: 'leisure', run, promptSha: '', raw: '{}', error: null, ms: 1,
      categoriesType: 'array', validJson: true, allKeys: true, empty: false, direction: { valid: true, secondChance: false },
      picks: { strict: [], whole: [], split: [], production: [], ...picks }, ...over,
    });
    /** `n` of the 42 titles yield (two runs each); the rest answer nothing. */
    const fill = (model: string, arm: ShapeArm, n: number, picks: Partial<Record<Reading, string[]>>, over: Partial<ShapeCall> = {}): ShapeCall[] =>
      ITEMS.flatMap((it, i) => [0, 1].map((run) => sc(model, arm, it.title, run, i < n ? picks : {}, over)));
    const arrays = (v: string): Partial<Record<Reading, string[]>> => ({ strict: [v], whole: [v], split: [v], production: [v] });
    const strings = (v: string): Partial<Record<Reading, string[]>> => ({ whole: [v], split: [v] });
    /** The reference tier answers arrays on every title, all arms the same. */
    const reference = (over: Partial<ShapeCall> = {}): ShapeCall[] =>
      (['A', 'A2', 'W1', 'W2'] as const).flatMap((arm) => fill(R, arm, 42, arrays('health'), over));
    const none = (model: string, arms: readonly ShapeArm[]): ShapeCall[] => arms.flatMap((a) => fill(model, a, 0, {}));

    it('S1 needs +20 points on every small tier that ran, and has no verdict when none ran', () => {
      const b = candidate('b');
      const calls = [...fill(Q, 'A', 42, strings('leisure')), ...fill(G, 'A', 8, strings('leisure'))]; // Y strict 0; whole 100% and 19%
      const out = s1Yield(calls, [Q, G], b);
      expect(out.perTier.map((t) => [t.model, Math.round(t.cand)])).toEqual([[Q, 100], [G, 19]]);
      expect(out.pass).toBe(false); // gemma3:1b stays under +20
      expect(s1Yield(calls, [Q], b).pass).toBe(true);
      expect(s1Yield(calls, [R], b).pass).toBeNull();
    });

    it('S2 counts titles whose modal first pick moved, and is inconclusive when A against A2 moved as many', () => {
      const w1 = candidate('a-W1');
      const base = [...fill(R, 'A', 42, arrays('health')), ...fill(R, 'A2', 42, arrays('health'))];
      const moved = (k: number): ShapeCall[] => ITEMS.flatMap((it, i) => [0, 1].map((run) => sc(R, 'W1', it.title, run, arrays(i < k ? 'leisure' : 'health'))));
      expect(s2Reference([...base, ...moved(2)], [R], w1).verdict).toBe('PASS');
      expect(s2Reference([...base, ...moved(3)], [R], w1).verdict).toBe('FAIL');
      const noisy = [...fill(R, 'A', 42, arrays('health')), ...ITEMS.flatMap((it, i) => [0, 1].map((run) => sc(R, 'A2', it.title, run, arrays(i < 3 ? 'leisure' : 'health')))), ...moved(0)];
      expect(s2Reference(noisy, [R], w1).verdict).toBe('INCONCLUSIVE: NOISE');
      expect(s2Reference(base, [Q], w1).verdict).toBe('NOT RUN');
      // A pure parse leaves every array answer alone.
      expect(s2Reference(base, [R], candidate('b')).verdict).toBe('PASS');
      // Y more than 5 points under A's fails even when few titles moved: 3 titles of 42 stop yielding, but their modal pick stays null on both sides.
      expect(s2Reference([...base, ...fill(R, 'W1', 38, arrays('health'))], [R], w1).verdict).toBe('FAIL');
    });

    it('S3 reads the wording arms on every tier, and a parse has nothing to fail', () => {
      const w1 = candidate('a-W1');
      const ok = [...fill(Q, 'A', 42, {}), ...fill(Q, 'W1', 42, {}), ...reference()];
      expect(s3Schema(ok, [Q, R], w1).pass).toBe(true);
      const keys = [...fill(Q, 'A', 42, {}), ...fill(Q, 'W1', 42, {}, { allKeys: false })];
      expect(s3Schema(keys, [Q], w1).pass).toBe(false); // A's all-keys 100% against W1's 0%
      const baseNoKeys = [...fill(Q, 'A', 42, {}, { allKeys: false }), ...fill(Q, 'W1', 42, {}, { allKeys: false })];
      expect(s3Schema(baseNoKeys, [Q], w1).pass).toBe(true); // no worse than the baseline
      const empties = [...fill(Q, 'A', 42, {}), ...fill(Q, 'W1', 42, {}, { empty: true })];
      expect(s3Schema(empties, [Q], w1).pass).toBe(false);
      expect(s3Schema(keys, [Q], candidate('b')).pass).toBe(true);
    });

    it('D3: the parse alone when only it qualifies, the wording alone when only it does, the pair only with a 15 point lift, nothing otherwise', () => {
      const wordingsLow = (m: string): ShapeCall[] => [...fill(m, 'W1', 4, arrays('leisure')), ...fill(m, 'W2', 4, arrays('leisure'))];
      // (b) only: both small tiers answer bare strings on 40 of 42 titles, the wordings barely move them.
      const bOnly = [...fill(Q, 'A', 40, strings('leisure')), ...fill(G, 'A', 40, strings('leisure')), ...fill(Q, 'A2', 40, strings('leisure')), ...fill(G, 'A2', 40, strings('leisure')),
        ...wordingsLow(Q), ...wordingsLow(G), ...none(R, []), ...reference()];
      const d1 = shapeDecision(bOnly, [Q, G, R]);
      expect(d1.ship).toMatch(/^b: the tolerant parse alone/);
      expect(d1.evals.get('a-W1')!.s1.pass).toBe(false);
      // (a) only: answers no reading can recover (a bare string naming no category) that a wording turns into arrays.
      const aOnly = [...fill(Q, 'A', 0, {}), ...fill(G, 'A', 0, {}), ...fill(Q, 'W1', 40, arrays('leisure')), ...fill(G, 'W1', 40, arrays('leisure')),
        ...fill(Q, 'W2', 3, arrays('leisure')), ...fill(G, 'W2', 3, arrays('leisure')), ...reference()];
      expect(shapeDecision(aOnly, [Q, G, R]).ship).toMatch(/^a-W1: the wording alone/);
      // Both qualify and the wording adds nothing over the parse: the parse alone.
      const both = [...fill(Q, 'A', 38, strings('leisure')), ...fill(G, 'A', 38, strings('leisure')), ...fill(Q, 'W1', 40, arrays('leisure')), ...fill(G, 'W1', 40, arrays('leisure')),
        ...fill(Q, 'W2', 40, arrays('leisure')), ...fill(G, 'W2', 40, arrays('leisure')), ...reference()];
      expect(shapeDecision(both, [Q, G, R]).ship).toMatch(/^b: the tolerant parse alone \(the wording adds under 15/);
      // Both qualify and the pair lifts Y by 15 or more on a small tier (A read whole 40%, W1 read whole 95%): the pair.
      const lift = [...fill(Q, 'A', 17, strings('leisure')), ...fill(G, 'A', 17, strings('leisure')), ...fill(Q, 'W1', 40, arrays('leisure')), ...fill(G, 'W1', 40, arrays('leisure')),
        ...fill(Q, 'W2', 3, arrays('leisure')), ...fill(G, 'W2', 3, arrays('leisure')), ...reference()];
      expect(shapeDecision(lift, [Q, G, R]).ship).toMatch(/^a\+b-W1:/);
      // Nothing qualifies: no fix.
      const nothing = [...fill(Q, 'A', 0, {}), ...fill(G, 'A', 0, {}), ...wordingsLow(Q), ...wordingsLow(G), ...reference()];
      expect(shapeDecision(nothing, [Q, G, R]).ship).toMatch(/^NONE/);
      // The reference tier did not run: S2 cannot pass, so nothing qualifies, however well the small tiers did.
      expect(shapeDecision(bOnly, [Q, G]).ship).toMatch(/^NONE/);
    });

    it('D1 prefers the comma split to the whole string only when it lifts Y by 10 points on a small tier', () => {
      const multi: Partial<Record<Reading, string[]>> = { split: ['health', 'leisure'] };
      // A: 25 titles one whole name, 15 titles a comma list: whole 59.5%, split 95.2% on both small tiers (35.7 points).
      const mixed = (m: string): ShapeCall[] => ITEMS.flatMap((it, i) => [0, 1].map((run) => sc(m, 'A', it.title, run, i < 25 ? strings('leisure') : i < 40 ? multi : {})));
      const calls = [...mixed(Q), ...mixed(G), ...fill(Q, 'W1', 3, arrays('leisure')), ...fill(G, 'W1', 3, arrays('leisure')), ...fill(Q, 'W2', 3, arrays('leisure')), ...fill(G, 'W2', 3, arrays('leisure')), ...reference()];
      expect(shapeDecision(calls, [Q, G, R]).ship).toMatch(/^b-split:/);
      const flat = [...fill(Q, 'A', 40, strings('leisure')), ...fill(G, 'A', 40, strings('leisure')), ...fill(Q, 'W1', 3, arrays('leisure')), ...fill(G, 'W1', 3, arrays('leisure')),
        ...fill(Q, 'W2', 3, arrays('leisure')), ...fill(G, 'W2', 3, arrays('leisure')), ...reference()];
      expect(shapeDecision(flat, [Q, G, R]).ship).toMatch(/^b:/); // split adds nothing here
    });
  });
});
