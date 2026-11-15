/**
 * Live measurement harness for the classification hint in quick-add (follow-up to the
 * learning-loop audit of 2026-11-02). It reads off whether the hint half of that change
 * meets the ship rule (the lead decides, see DECISION RULE below); the write-up goes in
 * docs/classification-hint-measurement-2026-11.md, in the shape of
 * docs/complexity-rubric-measurement-2026-08.md.
 *
 * OPT-IN ONLY: inert unless `LIVE_HINT=1`, because it needs a running Ollama with the
 * models named below and the embedder, and takes tens of minutes on a tier that yields
 * picks. Recorded model calls per run, from the six recorded runs: 60 when the tier yields
 * no pick (qwen2.5:0.5b answers "categories" as a bare string, the run stops after the
 * baseline: seconds), 660 to 1,020 otherwise (gemma3:1b 10 to 11 minutes, gemma3n:e4b 21
 * to 31). "Recorded" is the first-pass call of each (title, run, arm) cell; the second
 * direction call enrichQuick makes when the first yields none is made but not recorded.
 * It is committed so the numbers in the evidence doc can be reproduced rather than
 * believed. In a normal run the whole file reports as skipped.
 *
 *   cd server
 *   LIVE_HINT=1 LIVE_HINT_RUNS=5 LIVE_HINT_MODELS=qwen2.5:0.5b,gemma3n:e4b \
 *     LIVE_HINT_OUT=../hint-live.json ./node_modules/.bin/vitest run test/classification-hint-live.test.ts --reporter=verbose
 *   (or: LIVE_HINT=1 LIVE_HINT_OUT=<path.json> pnpm --filter server test classification-hint-live --reporter=verbose)
 *   --reporter=verbose matters: the default reporter hides the console of a file that passes,
 *   and the console is where the tables and the gate verdicts are printed.
 *
 * Env, read by this file only (the app gains none):
 *   LIVE_HINT         1 to run.
 *   LIVE_HINT_RUNS    calls per title and arm, default 5.
 *   LIVE_HINT_MODELS  comma list, default 'qwen2.5:0.5b,gemma3n:e4b'. The FIRST must be the
 *                     fast tier the app itself resolves (asserted): it is the only one that
 *                     gates, the rest are informational.
 *   LIVE_HINT_OUT     path for the per-call JSON artifact (arm, model, title, run, prompt
 *                     sha256 prefix, hint present, retrieval ids, raw completion, the JSON
 *                     type of its "categories", parsed pick, correct, ms), plus the report,
 *                     the distinct prompts, the latency and residency numbers and the
 *                     provenance (real argv and OLLAMA_* env, how the fast tier resolved, the
 *                     server's /api/ps at the start, the commit and the sources it ran).
 *                     Rewritten as the run proceeds.
 *   Offline self-check of the pure helpers below, no Ollama and no model time:
 *   LIVE_HINT=1 ./node_modules/.bin/vitest run test/classification-hint-live.test.ts -t "pure helpers"
 *   It also builds the prompt with the real enrichQuick (a dry call, nothing reaches Ollama) and
 *   checks both hint layouts against it, so a change to where enrichQuick puts the hints stops
 *   the offline check before any model time is spent.
 *
 * WHAT IT DRIVES. The REAL routes through startTestServer, not a re-typed prompt. For the
 * evidence: POST /api/tasks/quick/parse (the real model, no hint yet because no index
 * exists), take the returned `classification_claim`, then POST /api/tasks with the owner's
 * convention as `categories` and the claim echoed, which is exactly what the wizard's Add
 * sends. Then ONE calibrateClassification(owner, now, { embedFn: null }), so capture,
 * index and apply are exercised together. The corrections are therefore the model's
 * AUTHENTIC misses on the training titles, not invented ones. The model seam
 * (`generateJson`) is wrapped, not replaced: it calls the real `generate` with the model
 * under test injected, and keeps the exact prompt and the RAW completion of every call, so
 * what is measured is the prompt the route really sent.
 *
 * FIXTURE. One synthetic owner with the six default categories (health, career,
 * relationships, growth, leisure, finance), and three conventions where the owner files a
 * kind of title somewhere other than where a model would by default:
 *   exercise-leisure    exercise and sport titles go to leisure, not health
 *   invoices-career     the owner's freelance invoices, tax and bookkeeping go to career, not finance
 *   inner-work-growth   therapy, meditation and journaling go to growth, not health
 * Per convention: 6 TRAINING titles (sent through the capture path above) and 4 held-out
 * TARGET titles, disjoint from training. Plus 12 CONTROL titles whose natural answer is
 * NOT a convention value (health, finance, relationships), including near-misses: a
 * dentist appointment beside the exercise convention, an electricity bill beside the
 * invoices convention, a prescription refill beside the inner-work convention. Controls
 * are what an input-blind hint would over-apply to. The model's default for each
 * convention is an assumption of the fixture, so it is MEASURED first: a convention whose
 * baseline on its targets is already at least 75% is reported INCONCLUSIVE: NO HEADROOM,
 * is not trained and not scored. The owner and every title are invented; nothing here is
 * a claim about real owners.
 *
 * ARMS, same titles, same RUNS, interleaved per (title, run) in the fixed order
 * A, B, C, S, A2, P so warm-up drift cannot favour one arm:
 *   A   baseline: enrichQuick(text, parse, vocab) with no hints (today's prompt)
 *   A2  a repeat of A: the noise floor
 *   B   SHIPPED: POST /api/tasks/quick/parse through the real route (frequency hints, accept
 *       filter). Since 2026-11-02 the hint blocks sit LAST: after the 'Choose ... never invent.'
 *       line and immediately before 'Entry:' (see the layout note under the gates).
 *   C   ADJACENT, the layout B had in the first three live runs (NON-GATING diagnostic, kept
 *       so the comparison with the layout that failed G3 on gemma3:1b stays on the page): B's
 *       captured prompt with each hint block moved back to just after the field line it
 *       governs, with the extra newline the old enrichQuick added (git show 96dbea90:
 *       server/src/agents/quickadd.ts), so the prompt that version sent, byte for byte.
 *       CHANGED MEANING: in the artifacts of the first three runs B is adjacent and C is hint
 *       last; from the confirmation runs on it is the other way round. An artifact says which
 *       in its `layouts` key; one without that key is from before the change.
 *   P   PLACEBO (added 2026-11-02, after the first runs; NON-GATING; run last in each cell so
 *       the registered order of the others is untouched): B's block, in B's place, built from
 *       real lessons about OTHER conventions: as many lessons as B shows, as close to B's
 *       length as the index allows, never carrying the title's own convention's value (for a
 *       control, the convention it sits beside, if any) as the value the user CHOSE. A lesson
 *       may still name it on the "you said" side ("you said health, growth; the user chose
 *       leisure" is a lesson about leisure shown to a growth title): the filter does not look
 *       there, and the report counts the titles whose block does. B against A confounds "the
 *       owner's lessons help" with "any such block changes what the model answers"; B against P
 *       takes the block, its position and its framing out of the comparison. P runs only on
 *       titles for which a block could be built, so every figure about P is out of the titles
 *       it ran on (x/n, n printed), and A and B are cut to those same titles whenever they are
 *       set beside it. Which lessons it draws is keyed on the title and on each lesson's text,
 *       not on its log id (ids are minted per run), so a re-run over the same index content
 *       draws the same ones.
 *   S   classificationHint with the real embedder injected (similarity), for the record
 *   B1  B with k: 1; runs only when B fails G2 or G3 (the named remedy)
 *   N0  the narrow one-field question exactly as services/classification-score.ts sends it,
 *       with no hint; N the same with B's hint. Both run only when B shows no gain on the
 *       targets, to see whether the width of the wide prompt is what dilutes the hint.
 *       (N0 is an addition to the plan: without it a gain of N over A could be the narrow
 *       prompt rather than the hint.)
 *   A0  not an arm of the comparison: the pre-training baseline on the targets that decides headroom.
 *   S, B1 and P call enrichQuick themselves, so they carry the shipped layout; C is the only
 *   arm whose layout the harness writes.
 *
 * METRICS. First-category accuracy, per model and arm, on TARGET titles and on CONTROL
 * titles, as per-ITEM majority over RUNS (strict: more than half the runs; at temperature
 * 0.1 the runs are near-identical, so titles, not trials, are the sample). Valid-JSON rate
 * (strict JSON.parse) and presence of every requested key. A per-title flip table (the
 * per-run string, then the majority: A FFTTT then B TTTTT). Wins (A wrong, B right) and
 * losses (A right, B wrong). The A-versus-A2 flips. Prompt growth in characters.
 * Retrieval precision@1 and @k (does the top lesson carry the owner's value for this
 * title; a property of the fixture and the retrieval mode, no generation model involved).
 * ANSWER SHAPE (added 2026-11-02): the JSON type of "categories" in every raw completion
 * (array | string | missing | other), the share of each arm that is an array (the only shape
 * production keeps: constrainToVocabulary returns [] for anything else), accuracy among the
 * calls that did answer an array, and a lenient secondary score that reads a bare string as a
 * one-item list. The lenient score is NOT what production does; it says what the model meant.
 * DIRECTION (added 2026-11-02, after the round-2 review): per arm, the share of completions whose
 * "direction" names one of the owner's directions (work, home, community) after the constraining
 * production applies (constrainOne in mergeEnrichment), and the share that would make enrichQuick
 * ask its second, single-field direction question, one more sequential model call before the
 * quick-add answer returns. A completion that cannot be read (empty, errored, not JSON) fails
 * the first pass in production and never reaches the second question, so it counts in neither.
 *
 * PRE-REGISTERED GATES (fast tier only), 2026-11-02, before the first live run. Do not edit
 * a gate after seeing a result; add a dated note under it instead. Scored titles are the
 * targets of conventions that have headroom.
 *   G1 EFFICACY         B beats A on the scored targets by at least +20 points absolute, or by
 *                       at least 2 more titles net (wins minus losses). If A versus A2 moves
 *                       more than 2 of those titles, G1 is INCONCLUSIVE: NOISE (the noise is as
 *                       large as the effect). No headroom anywhere: INCONCLUSIVE: NO HEADROOM.
 *                       The mirror image (at most -20 points, or at least 2 titles net the
 *                       wrong way) is HARMED; anything between is NO MEASURABLE CHANGE.
 *   G2 OVER-APPLICATION At most 1 of the 12 controls goes baseline-correct (A) to hinted-wrong (B).
 *   G3 SCHEMA SAFETY    Valid-JSON rate and key presence for B no more than 5 points below A,
 *                       and no new empty (or errored) completions.
 *   G4 NO-OP            For an owner with no index (never calibrated, another owner, or after
 *                       DELETE /api/classification/exemplars) the prompt POST /api/tasks/quick/parse
 *                       sends equals the one enrichQuick builds with no hints, byte for byte.
 *                       ASSERTED on every fixture title in dry mode (no model call), not sampled.
 *   G5 LOOP             The share of scored target titles classified to the owner's value after
 *                       calibrate is higher with B than with A: the owner's acceptance test.
 *                       Weaker than G1 by design (any gain), reported with the per-title flips.
 *   G6 LATENCY          The in-process hint read (the Promise.all of the two classificationHint
 *                       calls with the exact production arguments), N=30 per condition, first run
 *                       discarded, owner with an index interleaved with owner without: with an
 *                       index p50 <= 20 ms and p95 <= 60 ms; without an index p95 <= 5 ms.
 * Counts and per-title flips are reported, not significance. The minimum detectable effect
 * is one title out of n and is printed instead of calling a null 'neutral'.
 * Verdicts: IMPROVED / HARMED / NO MEASURABLE CHANGE / INCONCLUSIVE: NO HEADROOM
 * (plus INCONCLUSIVE: NOISE for the A-versus-A2 rule above).
 *
 * NOTES ADDED AFTER THE FIRST RUNS. The gates, their thresholds and the verdict words above are
 * exactly as registered. Nothing below edits one: each item is a new non-gating diagnostic, a
 * clearer label, or a dated reading of a run that had already happened.
 *   2026-11-02, after the first runs: the default fast tier (qwen2.5:0.5b) answered "categories"
 *   as a bare string on all 60 baseline completions of the first run. Production keeps only
 *   arrays, so on that tier quick-add yields no category pick, the wizard gets no
 *   classification_claim, and nothing can be corrected. That run's INCONCLUSIVE: NO HEADROOM was
 *   a type artifact (0 claims on 18 training parses and a baseline of 0 of 12 targets, both
 *   because no pick survived), not a finding that the model files things the way the owner
 *   does. The later runs set OLLAMA_FAST, which makes the model they name "the fast tier the
 *   app resolves" for the assertion in beforeAll and so the gating tier of that run: the second
 *   gemma3:1b (arrays on 12 of its 60 baseline completions, bare strings on the rest, so it is
 *   only partly past the problem), the third gemma3n:e4b (arrays on all 60 of its baseline
 *   completions, and on every other completion of that run). Neither is "the default tier"; the
 *   artifact now says when the gating tier was set by a pin rather than the box default
 *   (provenance.gatingTierNote).
 *   2026-11-02: a baseline whose "categories" is an array on fewer than 50% of its completions
 *   is labelled INCONCLUSIVE: UNUSABLE ANSWER SHAPE. INCONCLUSIVE: NO HEADROOM stays for a model
 *   that answers arrays and gets the owner's values right. A run is not stopped earlier or later
 *   for it; only the label and the reading change.
 *   2026-11-02: power notes. G2 can only flip the controls the baseline got right, and G3's
 *   key-presence clause cannot fail from a baseline that already omits keys. The report prints
 *   both numbers beside the gates and "NOT POWERED: ..." when fewer than 6 controls are
 *   baseline-correct or the baseline emits all nine keys on under 50% of its calls. PASS and
 *   FAIL mean exactly what was registered; the note says how much a PASS can be worth.
 *   2026-11-02: arm P, the answer-shape table and the provenance block are described above.
 *   2026-11-02, after the round-2 review of the confirmation runs (all non-gating; no gate,
 *   threshold or verdict word moved; the figures of the recorded runs are untouched, they were
 *   printed by the code before these items):
 *     - Arm P is reported over the titles it ran on. The summary row printed P as x/12 with the
 *       titles it never ran on counted wrong (run 5 printed 0/12 and 0/12 for what was 0/8 and
 *       0/11); it now prints x/n with n the titles run and says so beneath the table. The
 *       placebo block sets A, B and P side by side over the same titles (run 5: A 20.8%, B 7.5%
 *       over 24 titles beside P 7.4% over 19; over P's 19 titles A is 23.2% and B 9.5%), the
 *       "P moved it the same way" test reads those like-for-like shares, and the B-versus-P
 *       figure carries its n. "B is ahead of P" is not said when any title's P block showed
 *       fewer lessons than B's or when P ran on fewer than 5 titles (one title is then more
 *       than G1's 20 points); the count is still printed, worded as a count.
 *     - Arm P's draw is keyed on the title and the lesson text, not the log id: ids are minted
 *       per run, and ties between equally good combinations used to fall to them, so a re-run
 *       drew different lessons from the same index content. The own-value filter still tests the
 *       "user chose" side only; the count of titles whose block names it on the "you said" side
 *       is printed (run 6: the gym lesson, "you said health, growth; the user chose leisure", sat
 *       in the P block of each of the four growth targets). It is a limit on how neutral P is, and
 *       P equalled A in that run, so no effect of it shows there.
 *     - Direction validity, per arm, printed with the answer-shape table and in the reading (see
 *       METRICS above). It says whether a hinted prompt raises the share of requests that wait
 *       for a second model call; nothing in a gate reads it.
 *
 * THE LAYOUT OF B CHANGED AFTER THE FIRST THREE LIVE RUNS. No gate, threshold or verdict word
 * above is edited by it; what changed is the layout of the arm the gates are applied to.
 *   2026-11-02, after the first three live runs: the shipped layout was changed from adjacent
 *   to hint-last because adjacent failed G3 on gemma3:1b (all keys 99.2% -> 5.0%) while
 *   hint-last passed G3 on both models and tied adjacent on the gemma3n:e4b targets (7/12 vs
 *   7/12). The gates are applied unchanged to the new layout in confirmation runs; the first
 *   three runs are kept as the record of the adjacent layout.
 *
 * DECISION RULE (the ship rule, restated; the lead decides, the harness only reads it off).
 * Capture ships regardless. The hint half ships only if on the fast tier G2, G3 and G4 hold
 * AND G1 holds. G2 or G3 fails: re-run B with k: 1 (arm B1), then S; if both still fail,
 * drop the hint half. G1 fails with G2 and G3 passing: do not ship the hint half by default,
 * and put arm N in the evidence doc as the basis for a follow-up. If S shows a clear
 * accuracy edge over B AND no latency or residency damage, flip { embedFn: null } to {} in
 * enrichEntry and cite the doc. Arm C (the adjacent layout) is never a remedy in this rule:
 * the layout was changed once for failing G3, and C is only there to show whether it still
 * does.
 *   2026-11-02, after the confirmation runs (a dated note; the rule above is as written): the
 *   state that ships departs from this rule on the small tiers. The hint half ships although,
 *   read literally, the rule says not to by default wherever G1 did not hold on the fast tier:
 *   on qwen2.5:0.5b G1 was never measured (INCONCLUSIVE: UNUSABLE ANSWER SHAPE) and on
 *   gemma3:1b it was NO MEASURABLE CHANGE; only gemma3n:e4b meets the rule. What the decision
 *   rests on, and what it leaves open, is in docs/classification-hint-measurement-2026-11.md,
 *   section Ship decision. readOff keeps printing the rule's own reading; when that reading is
 *   not "the hint half may ship" it adds a line pointing at that section.
 *
 * LATENCY AND RESIDENCY. (a) GATING, G6 above. (b) REPORTED, not gated: POST
 * /api/tasks/quick/parse wall time for an owner without an index (A-style) versus with one
 * (B), N=30 interleaved, p50/p95/max, because model jitter and the longer prompt confound
 * it; and the in-process split of hint read versus enrichQuick for B and S. (c) GET /api/ps
 * after every call, reported per arm as a histogram of the resident sets seen (arms are
 * interleaved per call, so one before/after pair per arm would mean nothing), plus the
 * count of generate calls slower than 3x the warm median (a reload). B performs no embed, so
 * it must show none attributable to the hint. Then S once with both generation models
 * resident, recording embed ms and generate ms: this is what settles whether similarity could
 * ever replace the frequency path on a box that holds two models.
 *
 * WHAT THIS DOES NOT SHOW. Motivation: the wizard records category only, so the fixture has
 * no motivation corrections and the motivation hint is empty throughout (the production
 * arguments are still exercised, and a stray motivation hint would fail the prompt checks).
 * One invented owner and three conventions: this measures whether the mechanism helps a small
 * model follow a vocabulary it is shown, not how often real owners correct anything. The
 * fixture has exactly RETRIEVE_K (3) distinct owner values (leisure, career, growth), so the
 * frequency hint, one lesson for each of the owner's most-corrected values, can be a COMPLETE
 * convention table here. A real owner with more than three corrected values, or with skewed
 * counts, gets a hint that covers only the most-corrected ones: this overstates what the hint
 * can carry for them. Arm P's lessons are real lessons about the other conventions, not an
 * invented unrelated topic, so it controls for the block, not for every possible distractor. A call
 * that outruns CALL_POLICY.classify's 15 s ceiling is recorded as errored, as it would be in
 * the app: it counts as a wrong pick and as an empty completion. POST /api/tasks/quick is not
 * driven here (it shares enrichEntry with the parse route and its prompt is pinned in
 * test/quickadd-hint-prompt.test.ts).
 *
 * HARD-ASSERTED (the mechanism; a failure means the measurement is not valid, and the
 * artifact is written first): no model is thinking-capable (a thinking model answers ""
 * under format:"json", which reads exactly like "unchanged", see lib/models.ts), the first
 * model is the fast tier the app resolves, no completion of a baseline arm (A0, A, A2, N0)
 * is empty or errored, the hint is present exactly once in every B/C/S/B1/N prompt that had
 * a retrieval and where its arm puts it (B, S, B1 and P: after the 'never invent.' line, with
 * nothing but the hint blocks between that line and 'Entry:'; C: beside the field it governs,
 * a blank line on both sides; N: its own narrow prompt, where only the count is checked),
 * none in any A/A2/A0/N0 prompt, removing the hints from a B prompt gives the stock prompt
 * (and from a C prompt too, with the extra newline each block carries there), the no-index
 * prompts are byte-identical, the capture wrote the rows it should; and for P, one placebo
 * block in B's place that is additive over the stock prompt and carries no lesson CHOSEN for
 * the title's own value (the "you said" side is not checked, see arm P). REPORTED, never asserted:
 * every effect size, every gate verdict, the answer shape and the direction validity of every
 * arm, how closely P matched B's length, how many titles P ran on and how many of its blocks
 * were shorter than B's, and any empty or errored completion in a hinted arm (that is G3's
 * finding, and asserting it would abort the very verdict the gate exists to give).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
// Installs the SQLite store; model resolution reads the per-owner Settings override.
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { parseQuick } from '../src/engine/quickadd.js';
import { enrichQuick, type QuickHints } from '../src/agents/quickadd.js';
import { constrainToVocabulary, constrainOne } from '../src/agents/constrain.js';
import {
  MOTIVATION_VALUES, directionGuide,
  PRIORITY_RUBRIC, DURATION_RUBRIC, TIME_OF_DAY_RUBRIC, COMPLEXITY_RUBRIC, MOTIVATION_RUBRIC,
} from '../src/agents/rubric.js';
import { generateJson, generate, embed, parseJsonLoose } from '../src/mcp/ollama.js';
import {
  setInstalledModels, parseParamB, resolveModel, resolveEmbedModel, matchInstalled,
  explainModel, explainModelDefault, type ResolvedModel,
} from '../src/lib/models.js';
import { suggestibleVocabulary, type TagVocabulary } from '../src/services/tags.js';
import { ollamaScorer } from '../src/services/classification-score.js';
import {
  calibrateClassification, classificationHint, classificationInput, exemplarPrompt, retrieveExemplars,
  CORRECTION_FLOOR, EMBED_TIMEOUT_MS, RETRIEVE_K, type Exemplar,
} from '../src/services/classification-learning.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

const LIVE = process.env.LIVE_HINT === '1';
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}
const RUNS = LIVE ? envPositiveInt('LIVE_HINT_RUNS', 5) : 5;
const MODELS = (process.env.LIVE_HINT_MODELS ?? 'qwen2.5:0.5b,gemma3n:e4b').split(',').map((m) => m.trim()).filter(Boolean);
const OUT = process.env.LIVE_HINT_OUT ?? '';
const OWNER = SYSTEM_OWNER;

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
        raw = await real.generate(prompt, { ...opts, model: model || undefined, json: true });
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

// ── Pre-registered thresholds (the header is the prose, this is the number) ──

const GATES = {
  /** A convention whose baseline on its targets is at or above this is not scored. */
  headroomCeiling: 0.75,
  g1MinPoints: 20,
  g1MinNet: 2,
  /** A versus A2 moving more than this many scored targets makes G1 inconclusive. */
  noiseFlipsMax: 2,
  g2MaxFlips: 1,
  g3MaxDropPoints: 5,
  /** Milliseconds, in-process hint read. */
  hintReadMs: { withP50: 20, withP95: 60, withoutP95: 5 },
  /** A generate call slower than this multiple of the warm median is a suspected reload. */
  reloadFactor: 3,
} as const;

/**
 * Thresholds of the diagnostics added after the first live runs (2026-11-02, see the notes
 * under the gates). They label and annotate. None of them is a gate: no PASS, FAIL or G1
 * verdict reads them, and no run is stopped or continued because of one.
 */
const DIAGNOSTICS = {
  /** A baseline whose "categories" is an array on a smaller share of its completions has no usable answer shape. */
  minUsableShapePct: 50,
  /** With fewer baseline-correct controls than this, G2 has too few to flip to say much. */
  minFlippableControls: 6,
  /** A baseline that emits every requested key on a smaller share of calls leaves G3's key clause nothing to lose. */
  minBaselineKeyCoveragePct: 50,
  /** An arm whose array share sits this many points from A's has changed the answer shape. */
  shapeShiftPoints: 20,
  /** Placebo candidates considered per title (the combinations of them are searched, so this is capped). */
  placeboCandidates: 20,
  /**
   * Titles B-versus-P must cover before a lead of one title can be worded as more than a count:
   * below this one title is more than G1's 20 points, so a single title would pass for an effect.
   * Derived from G1's mark, not a new number.
   */
  placeboMinTitles: Math.ceil(100 / GATES.g1MinPoints),
} as const;

/** The fast tier the gates were registered against: the box default in lib/config.ts. */
const REGISTERED_FAST_DEFAULT = 'qwen2.5:0.5b';

const LATENCY_N = 30;
const PROBE_N = 10;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * C is the adjacent layout since 2026-11-02 (hint last in the first three runs); B, S, B1 and
 * P carry the shipped layout, hint blocks last. See ARM_LAYOUTS.
 */
type Arm = 'A0' | 'A' | 'A2' | 'B' | 'C' | 'S' | 'B1' | 'N0' | 'N' | 'P';
type Verdict =
  | 'IMPROVED' | 'HARMED' | 'NO MEASURABLE CHANGE' | 'INCONCLUSIVE: NO HEADROOM' | 'INCONCLUSIVE: NOISE';
/** What a run that stopped for want of evidence is called. */
type StoppedStatus = 'INCONCLUSIVE: NO HEADROOM' | 'INCONCLUSIVE: UNUSABLE ANSWER SHAPE';
/**
 * The JSON type of "categories" in a raw completion. Only `array` survives production's
 * constrainToVocabulary. `missing` is an absent key and also a completion with no object to
 * read it from (empty, errored, unparseable); `other` is a present value that is neither
 * (null, a number, an object).
 */
type CategoriesType = 'array' | 'string' | 'missing' | 'other';

/** The keys enrichQuick's prompt asks for (categories included: the owner has them). */
const WIDE_KEYS = [
  'direction', 'isComplex', 'priority', 'estimatedMinutes', 'timeOfDay', 'timeOfDayReason',
  'motivation', 'categories', 'tags',
] as const;
const NARROW_KEYS = ['categories'] as const;
/** The order arms are listed in every table. */
const ARMS_REPORTED: readonly Arm[] = ['A0', 'A', 'A2', 'B', 'P', 'C', 'S', 'B1', 'N0', 'N'];
/** The first line of exemplarPrompt's block; every hint contains it exactly once. */
const HINT_MARKER = 'This user has corrected you before.';
/**
 * The end of enrichQuick's last rule line ('Choose direction/categories/tags ONLY from the
 * given lists — never invent.'). In the shipped layout the hint blocks follow it directly.
 * Once in the stock prompt: the rubrics say 'never invent a specific hour', not this.
 */
const RULES_END = 'never invent.\n';
/** Opens the entry line, the last of the prompt; nothing follows the entry's text. */
const ENTRY_OPEN = '\nEntry: "';
/** The layouts a hint can have in a prompt. 'last' is the shipped one, 'adjacent' is arm C's. */
type Layout = 'last' | 'adjacent' | 'narrow';
/** Where each arm puts its hint blocks (arm C changed meaning on 2026-11-02, see the header). A, A2, A0 and N0 carry none. */
const ARM_LAYOUTS = { B: 'last', C: 'adjacent', S: 'last', B1: 'last', P: 'last', N: 'narrow' } as const;

interface CallRecord {
  arm: Arm;
  model: string;
  title: string;
  kind: 'target' | 'control';
  convention: ConventionId | null;
  expected: string;
  run: number;
  promptSha: string;
  hintPresent: boolean;
  retrievalIds: string[];
  raw: string;
  categoriesType: CategoriesType;
  pick: string | null;
  correct: boolean;
  /**
   * The first category the model MEANT: a bare string is read as a one-item list. Not what
   * production does (it discards the string); the secondary score that separates "wrong"
   * from "wrong shape".
   */
  lenientPick: string | null;
  lenientCorrect: boolean;
  validJson: boolean;
  allKeys: boolean;
  /** Empty or errored: the completion carries nothing. */
  empty: boolean;
  error: string | null;
  ms: number;
  /** Arm S only. */
  embedMs: number | null;
}

const pct = (num: number, den: number): number => (den === 0 ? NaN : (100 * num) / den);
const fmt1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const fmt0 = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : 'n/a');
const titlesN = (n: number): string => `${n} title${n === 1 ? '' : 's'}`;
const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Nearest-rank percentile, p in 0..100; NaN for an empty sample. */
function percentile(sample: readonly number[], p: number): number {
  if (sample.length === 0) return NaN;
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/**
 * A STRICT majority of the runs. A tie is not a majority: a title the model gets right
 * half the time is not one it gets right.
 */
function majorityCorrect(flags: readonly boolean[]): boolean {
  return flags.length > 0 && 2 * flags.filter(Boolean).length > flags.length;
}

const runString = (flags: readonly boolean[]): string => flags.map((f) => (f ? 'T' : 'F')).join('');

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

/**
 * The owner's lesson filter, a copy of routes/tasks.ts `choosable` (which is route-local
 * and not exported). A copy on purpose: the mechanism check compares the hint THIS builds
 * with the hint found in the route's prompt, so a drift between the two shows up as a
 * violation instead of as a quietly different experiment. The pure-helper self-check also
 * lifts the route's own function out of its source and runs both on the same inputs, so a
 * drift shows up offline, before any model time is spent.
 *
 * Synced 2026-11-02 with the version that reads `correctValue` (a category pick is stored as
 * its names joined by ', ', see canonicalValue) as a whole sequence of allowed names, each
 * one a non-empty whole name, case-insensitive. A name may itself contain a comma
 * ("Health, Fitness" is stored as `health,-fitness`), which a split on ',' would cut in two.
 */
function choosable(allowed: readonly string[]): (e: Exemplar) => boolean {
  const names = [...new Set(allowed.map((a) => a.toLowerCase()).filter(Boolean))];
  const SEP = ', ';
  return (e) => {
    const value = e.correctValue.toLowerCase();
    // Positions already tried: one that had led to a match would have ended the walk.
    const tried = new Set<number>();
    // Whether `value` from `at` to its end is one name, or a name, ', ' and then more of the
    // same. Every step eats a non-empty name, so a doubled or trailing separator cannot match.
    const walk = (at: number): boolean => {
      if (tried.has(at)) return false;
      tried.add(at);
      return names.some((n) => {
        if (!value.startsWith(n, at)) return false;
        const end = at + n.length;
        return end === value.length || (value.startsWith(SEP, end) && walk(end + SEP.length));
      });
    };
    return value.length > 0 && walk(0);
  };
}

/**
 * The prompt with each hint block taken out. In the shipped layout ('last') a block is the
 * hint itself: it opens and closes with a newline, which is all the separation it gets. In
 * the adjacent layout (arm C) enrichQuick added one more newline after it.
 */
function withoutHints(prompt: string, hints: readonly string[], layout: 'last' | 'adjacent' = 'last'): string {
  let bare = prompt;
  for (const h of hints) {
    if (!h) continue;
    const block = layout === 'adjacent' ? `${h}\n` : h;
    const at = bare.indexOf(block);
    if (at < 0 || bare.indexOf(block, at + 1) >= 0) throw new Error('withoutHints: the hint block is not in the prompt exactly once');
    bare = bare.slice(0, at) + bare.slice(at + block.length);
  }
  return bare;
}

/**
 * Arm C: the layout the hint first shipped in, rebuilt from a prompt in the shipped one. Each
 * block goes back to just after the field line it governs, with the extra newline the old
 * enrichQuick added (git show 96dbea90:server/src/agents/quickadd.ts): motivation before the
 * "categories" line (before "tags" when the owner has no categories), category before the
 * "tags" line. The result is that enrichQuick's prompt for the same hints, byte for byte; the
 * pure-helper self-check pins it against a literal of that prompt.
 */
function adjacentLayout(prompt: string, hints: { motivation: string; category: string }): string {
  let out = withoutHints(prompt, [hints.motivation, hints.category]);
  // The schema's key lines each start a line before the entry; the entry's own text is not searched.
  const schema = (): string => out.slice(0, out.lastIndexOf(ENTRY_OPEN) + 1);
  if (!schema()) throw new Error('adjacentLayout: no Entry: line in the prompt');
  const has = (key: string): boolean => schema().includes(`\n"${key}": `);
  const insertBefore = (key: string, block: string): void => {
    const line = schema().indexOf(`\n"${key}": `);
    if (line < 0) throw new Error(`adjacentLayout: no "${key}" line to put a hint before`);
    out = out.slice(0, line + 1) + block + out.slice(line + 1);
  };
  if (hints.category) {
    if (!has('categories')) throw new Error('adjacentLayout: a category hint but no "categories" line to put it beside');
    insertBefore('tags', `${hints.category}\n`);
  }
  if (hints.motivation) {
    if (!has('motivation')) throw new Error('adjacentLayout: a motivation hint but no "motivation" line to put it beside');
    insertBefore(has('categories') ? 'categories' : 'tags', `${hints.motivation}\n`);
  }
  return out;
}

function flagsFor(recs: readonly CallRecord[], model: string, arm: Arm, title: string): boolean[] {
  return recs
    .filter((r) => r.model === model && r.arm === arm && r.title === title)
    .sort((a, b) => a.run - b.run)
    .map((r) => r.correct);
}

const armCalls = (recs: readonly CallRecord[], model: string, arm: Arm): CallRecord[] =>
  recs.filter((r) => r.model === model && r.arm === arm);

/** One cell of the flip table: the per-run string, then the majority ('FFTTT>T'); '-' when the arm never ran. */
function flipCell(recs: readonly CallRecord[], model: string, arm: Arm, title: string): string {
  const flags = flagsFor(recs, model, arm, title);
  return flags.length ? `${runString(flags)}>${majorityCorrect(flags) ? 'T' : 'F'}` : '-';
}

const hasHeadroom = (correct: number, n: number): boolean => n > 0 && correct / n < GATES.headroomCeiling;

/** Wins (base wrong, treatment right) and losses (base right, treatment wrong) over `titles`, by majority. */
function compareArms(recs: readonly CallRecord[], model: string, base: Arm, treat: Arm, titles: readonly string[]) {
  const winTitles: string[] = [];
  const lossTitles: string[] = [];
  let baseCorrect = 0;
  let treatCorrect = 0;
  for (const t of titles) {
    const a = majorityCorrect(flagsFor(recs, model, base, t));
    const b = majorityCorrect(flagsFor(recs, model, treat, t));
    if (a) baseCorrect++;
    if (b) treatCorrect++;
    if (!a && b) winTitles.push(t);
    if (a && !b) lossTitles.push(t);
  }
  return {
    n: titles.length, baseCorrect, treatCorrect,
    wins: winTitles.length, losses: lossTitles.length, net: winTitles.length - lossTitles.length,
    winTitles, lossTitles,
  };
}

/** Titles whose majority differs between two arms: for A versus A2 this is the noise floor. */
function flipTitles(recs: readonly CallRecord[], model: string, a: Arm, b: Arm, titles: readonly string[]): string[] {
  return titles.filter((t) => majorityCorrect(flagsFor(recs, model, a, t)) !== majorityCorrect(flagsFor(recs, model, b, t)));
}

function efficacyVerdict(n: number, net: number, noiseFlips: number): Verdict {
  if (n === 0) return 'INCONCLUSIVE: NO HEADROOM';
  if (noiseFlips > GATES.noiseFlipsMax) return 'INCONCLUSIVE: NOISE';
  const points = (100 * net) / n;
  if (net >= GATES.g1MinNet || points >= GATES.g1MinPoints) return 'IMPROVED';
  if (net <= -GATES.g1MinNet || points <= -GATES.g1MinPoints) return 'HARMED';
  return 'NO MEASURABLE CHANGE';
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
function shapeStats(calls: readonly CallRecord[]): ShapeStats {
  const count = (t: CategoriesType): number => calls.filter((c) => c.categoriesType === t).length;
  return {
    n: calls.length, array: count('array'), string: count('string'), missing: count('missing'), other: count('other'),
    arrayPct: pct(count('array'), calls.length),
  };
}

/** Mostly not arrays: whatever the picks say, they are picks production would not have kept. */
const shapeUnusable = (s: ShapeStats): boolean => s.n > 0 && s.arrayPct < DIAGNOSTICS.minUsableShapePct;
const shapeShifted = (basePct: number, armPct: number): boolean => Math.abs(armPct - basePct) >= DIAGNOSTICS.shapeShiftPoints;

/** Call-level accuracy, strict (production's reading), among the calls that answered an array, and lenient. */
interface ShapeAccuracy { n: number; correct: number; arrays: number; correctGivenArray: number; lenient: number }
function accuracyGivenShape(calls: readonly CallRecord[]): ShapeAccuracy {
  const arrays = calls.filter((c) => c.categoriesType === 'array');
  return {
    n: calls.length, correct: calls.filter((c) => c.correct).length, arrays: arrays.length,
    correctGivenArray: arrays.filter((c) => c.correct).length, lenient: calls.filter((c) => c.lenientCorrect).length,
  };
}

// ── Direction (added 2026-11-02, non-gating) ─────────────────────────────────

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

interface DirectionStats { n: number; valid: number; secondChance: number; validPct: number; secondChancePct: number }
/** Over calls, not titles: every completion of the arm counts in `n`, readable or not. */
function directionStats(calls: readonly CallRecord[], directions: readonly string[]): DirectionStats {
  const read = calls.map((c) => directionOf(c.raw, directions));
  const valid = read.filter((r) => r.valid).length;
  const secondChance = read.filter((r) => r.secondChance).length;
  return { n: calls.length, valid, secondChance, validPct: pct(valid, calls.length), secondChancePct: pct(secondChance, calls.length) };
}

/** The narrow one-field question never asks for a direction, so there is nothing to read there. */
const NARROW_ARMS: readonly Arm[] = ['N0', 'N'];

interface ArmShape {
  shape: ShapeStats;
  targets: ShapeAccuracy;
  controls: ShapeAccuracy;
  /** Null for the narrow arms. */
  direction: DirectionStats | null;
}
/**
 * `only` cuts the arm's calls to those titles, so two arms can be set beside each other over
 * the same titles (arm P ran on fewer than the others in run 5). `directions` defaults to the
 * fixture's; runModel passes the owner's vocabulary as the app resolved it.
 */
function armShape(
  recs: readonly CallRecord[], model: string, arm: Arm, targetTitles: readonly string[], controlTitles: readonly string[],
  opts: { only?: ReadonlySet<string>; directions?: readonly string[] } = {},
): ArmShape | null {
  const calls = armCalls(recs, model, arm).filter((c) => !opts.only || opts.only.has(c.title));
  if (calls.length === 0) return null;
  const of = (titles: readonly string[]) => accuracyGivenShape(calls.filter((c) => titles.includes(c.title)));
  return {
    shape: shapeStats(calls), targets: of(targetTitles), controls: of(controlTitles),
    direction: NARROW_ARMS.includes(arm) ? null : directionStats(calls, opts.directions ?? DIRECTIONS),
  };
}

/** Titles where a strict majority of the runs picked the owner's value, reading a bare string as a list. */
function lenientMajority(recs: readonly CallRecord[], model: string, arm: Arm, titles: readonly string[]): number {
  return titles.filter((t) => majorityCorrect(
    recs.filter((r) => r.model === model && r.arm === arm && r.title === t).map((r) => r.lenientCorrect),
  )).length;
}

/** A run that stopped for want of evidence: say WHY, so a type artifact is not read as "nothing to teach". */
const stoppedStatus = (baseline: ShapeStats): StoppedStatus =>
  shapeUnusable(baseline) ? 'INCONCLUSIVE: UNUSABLE ANSWER SHAPE' : 'INCONCLUSIVE: NO HEADROOM';

const SHAPE_WHY = 'a bare string (how qwen2.5:0.5b answers) is discarded by constrainToVocabulary in production, '
  + 'so quick-add yields no category pick from it and the wizard has no claim to echo';

function unusableShapeNote(a0: ShapeStats): string {
  return `the baseline answered "categories" as an array on ${fmt1(a0.arrayPct)}% of ${a0.n} completions `
    + `(string ${a0.string}, missing ${a0.missing}, other ${a0.other}); ${SHAPE_WHY}. `
    + 'The picks are mostly absent for a reason that says nothing about what the model knows';
}

/** What an unusable baseline shape does to every reading below it. A plain line, not a registered verdict. */
function baselineShapeLine(aPct: number): string[] {
  if (!(Number.isFinite(aPct) && aPct < DIAGNOSTICS.minUsableShapePct)) return [];
  return [`Answer shape: A answers "categories" as an array on only ${fmt1(aPct)}% of its calls, so A's accuracy is mostly a count of answers production would discard. `
    + 'Read G1 to G5 as shape-confounded (INCONCLUSIVE: UNUSABLE ANSWER SHAPE for the baseline).'];
}

/**
 * The array shares of A, an arm and P over the titles P ran on (n of them), all cut to those
 * titles. A shift is only comparable with P's over a set P has a share for, so the clause about
 * P reads these and not the all-title shares the first sentence is about.
 */
interface PlaceboShapeBasis { n: number; aPct: number; armPct: number; placeboPct: number }

/**
 * A treatment arm that changed the array share (over all its calls, as the shape table shows):
 * its change in picks may be the shape, and P says whether the block alone does that. P's share
 * is only set beside the arm's over the titles P ran on, where both the arm and A moved and P
 * moved the same way.
 */
function shapeShiftLine(aPct: number, arm: Arm, armPct: number, basis: PlaceboShapeBasis | null): string[] {
  if (!shapeShifted(aPct, armPct)) return [];
  const same = arm !== 'P' && basis !== null
    && shapeShifted(basis.aPct, basis.armPct) && shapeShifted(basis.aPct, basis.placeboPct)
    && Math.sign(basis.placeboPct - basis.aPct) === Math.sign(basis.armPct - basis.aPct);
  return [`Answer shape: ${arm} moved the array share from ${fmt1(aPct)}% to ${fmt1(armPct)}%, so a change in the picks may be the shape and not the lessons.`
    + (same && basis
      ? ` Over the ${basis.n} titles P ran on (A, ${arm} and P all cut to them) A is at ${fmt1(basis.aPct)}%, ${arm} at ${fmt1(basis.armPct)}% and P at ${fmt1(basis.placeboPct)}%: `
        + "P moved it the same way, so the shape change comes with the block, not with the owner's lessons." : '')];
}

interface SchemaStats { n: number; validJsonPct: number; allKeysPct: number; empty: number; errored: number }
function schemaStats(calls: readonly CallRecord[]): SchemaStats {
  return {
    n: calls.length,
    validJsonPct: pct(calls.filter((c) => c.validJson).length, calls.length),
    allKeysPct: pct(calls.filter((c) => c.allKeys).length, calls.length),
    empty: calls.filter((c) => c.empty).length,
    errored: calls.filter((c) => c.error !== null).length,
  };
}

interface TreatmentEval {
  arm: Arm;
  scored: number;
  g1: ReturnType<typeof compareArms> & { verdict: Verdict; deltaPoints: number; noiseFlips: number; noiseTitles: string[]; mdePoints: number };
  g2: { baseCorrect: number; flipped: string[]; healed: string[]; pass: boolean };
  g3: { base: SchemaStats; treat: SchemaStats; pass: boolean };
  g5: { baseShare: number; treatShare: number; pass: boolean };
  /**
   * NON-GATING (added 2026-11-02). What the baseline leaves G2 and G3 able to see: the
   * controls G2 can flip are the ones A got right, and G3's key clause cannot fall below a
   * baseline that already omits keys. `notPowered` is the plain-language version.
   */
  power: {
    g2FlippableControls: number;
    controls: number;
    g3BaseKeysPct: number;
    g3BaseArrayPct: number;
    g3TreatArrayPct: number;
    notPowered: string[];
  };
}

function powerNotes(flippable: number, controls: number, baseKeysPct: number): string[] {
  const notes: string[] = [];
  if (flippable < DIAGNOSTICS.minFlippableControls) {
    notes.push(`NOT POWERED: G2 can only flip ${flippable} of ${controls} controls (the ones the baseline got right; fewer than ${DIAGNOSTICS.minFlippableControls}), `
      + 'so its PASS says little about over-application.');
  }
  if (!(baseKeysPct >= DIAGNOSTICS.minBaselineKeyCoveragePct)) {
    notes.push(`NOT POWERED: G3's key clause starts from a baseline that emits every requested key on ${fmt1(baseKeysPct)}% of its calls `
      + `(under ${DIAGNOSTICS.minBaselineKeyCoveragePct}%), so a hinted arm has little or nothing to lose and the clause cannot fail in earnest.`);
  }
  return notes;
}

/** G1, G2, G3 and G5 for one treatment arm against A, on one model's records. */
function evaluateTreatment(
  recs: readonly CallRecord[], model: string, treat: Arm,
  scoredTitles: readonly string[], controlTitles: readonly string[],
): TreatmentEval {
  const targets = compareArms(recs, model, 'A', treat, scoredTitles);
  const noiseTitles = flipTitles(recs, model, 'A', 'A2', scoredTitles);
  const noiseFlips = noiseTitles.length;
  const controls = compareArms(recs, model, 'A', treat, controlTitles);
  const base = schemaStats(armCalls(recs, model, 'A'));
  const hinted = schemaStats(armCalls(recs, model, treat));
  const schemaPass = hinted.n > 0 && base.n > 0
    && hinted.validJsonPct >= base.validJsonPct - GATES.g3MaxDropPoints
    && hinted.allKeysPct >= base.allKeysPct - GATES.g3MaxDropPoints
    && hinted.empty <= base.empty;
  return {
    arm: treat,
    scored: scoredTitles.length,
    g1: {
      ...targets,
      verdict: efficacyVerdict(targets.n, targets.net, noiseFlips),
      deltaPoints: (100 * targets.net) / (targets.n || NaN),
      noiseFlips,
      noiseTitles,
      mdePoints: 100 / (targets.n || NaN),
    },
    g2: {
      baseCorrect: controls.baseCorrect,
      flipped: controls.lossTitles,
      healed: controls.winTitles,
      pass: controls.losses <= GATES.g2MaxFlips,
    },
    g3: { base, treat: hinted, pass: schemaPass },
    g5: {
      baseShare: pct(targets.baseCorrect, targets.n),
      treatShare: pct(targets.treatCorrect, targets.n),
      pass: targets.treatCorrect > targets.baseCorrect,
    },
    power: {
      g2FlippableControls: controls.baseCorrect,
      controls: controls.n,
      g3BaseKeysPct: base.allKeysPct,
      g3BaseArrayPct: shapeStats(armCalls(recs, model, 'A')).arrayPct,
      g3TreatArrayPct: shapeStats(armCalls(recs, model, treat)).arrayPct,
      notPowered: powerNotes(controls.baseCorrect, controls.n, base.allKeysPct),
    },
  };
}

function hintLatencyGate(withIndexMs: readonly number[], withoutIndexMs: readonly number[]) {
  const withP50 = percentile(withIndexMs, 50);
  const withP95 = percentile(withIndexMs, 95);
  const withoutP95 = percentile(withoutIndexMs, 95);
  return {
    withP50, withP95, withoutP95,
    pass: withP50 <= GATES.hintReadMs.withP50 && withP95 <= GATES.hintReadMs.withP95 && withoutP95 <= GATES.hintReadMs.withoutP95,
  };
}

// ── Arm P: the placebo block ──────────────────────────────────────────────────

/** The value a placebo must not carry for this item: a target's own, or that of the convention a control sits beside. */
function ownValueOf(item: FixtureItem): string | null {
  if (item.kind === 'target') return item.expected;
  const beside = item.besides ? CONVENTIONS.find((c) => c.id === item.besides) : undefined;
  return beside ? beside.owner : null;
}

/** Whether a stored correct value (a ', '-joined pick) names `value`. */
const namesValue = (stored: string, value: string): boolean =>
  `, ${stored.toLowerCase()}, `.includes(`, ${value.toLowerCase()}, `);

/**
 * How many of `lessons` name `own` on the "you said" side (llmValue, stored the same way as a
 * pick). placeboLessons keeps `own` off the "user chose" side only; this counts what that lets
 * through, so the report says how neutral P was and not just that it was filtered.
 */
const ownOnRejectedSide = (lessons: readonly Exemplar[], own: string | null): number =>
  own === null ? 0 : lessons.filter((e) => namesValue(e.llmValue, own)).length;

function* combinations<T>(items: readonly T[], k: number, from = 0, prefix: readonly T[] = []): Generator<T[]> {
  if (prefix.length === k) { yield [...prefix]; return; }
  for (let i = from; i <= items.length - (k - prefix.length); i++) yield* combinations(items, k, i + 1, [...prefix, items[i]]);
}

/**
 * The lessons of arm P for one title: as many as B's block has (`real`), none that B shows
 * and none CHOSEN for `own`, drawn from the owner's real index (`pool`). The filter reads the
 * "user chose" side only: a lesson that says "you said <own>; the user chose <other>" gets
 * through, as the header says, and the report counts the titles it reaches (PlaceboMeta
 * `ownOnRejectedSide`). Among the candidates the choice prefers as many distinct values as
 * B's block has (one lesson per value, the shape frequentCorrections gives B) and then the
 * length closest to B's, so the block is the same size and layout and differs in what it says.
 * Candidates are put in a fixed order by a hash of the title and the lesson's own text (its
 * input, what the model said, what the user chose), never its log id: ids are minted per run,
 * and ties between equally good combinations fall to this order, so keyed on them a re-run over
 * the same index content drew different lessons. Different titles see different lessons.
 * Fewer candidates than B has lessons gives fewer lessons: the caller reports that.
 */
function placeboLessons(pool: readonly Exemplar[], own: string | null, real: readonly Exemplar[], title: string): Exemplar[] {
  if (real.length === 0) return [];
  const shown = new Set(real.map((e) => e.logId));
  const candidates = pool
    .filter((e) => !shown.has(e.logId) && !(own !== null && namesValue(e.correctValue, own)))
    .map((e) => ({ e, key: sha12(`${title}|${e.inputText}|${e.llmValue}|${e.correctValue}`) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, DIAGNOSTICS.placeboCandidates)
    .map(({ e }) => e);
  const k = Math.min(real.length, candidates.length);
  if (k === 0) return [];
  const want = exemplarPrompt(real).length;
  let best: Exemplar[] = [];
  let bestScore: { distinct: number; gap: number } | null = null;
  for (const pick of combinations(candidates, k)) {
    const distinct = new Set(pick.map((e) => e.correctValue.toLowerCase())).size;
    const gap = Math.abs(exemplarPrompt(pick).length - want);
    if (!bestScore || distinct > bestScore.distinct || (distinct === bestScore.distinct && gap < bestScore.gap)) {
      best = pick;
      bestScore = { distinct, gap };
    }
  }
  // Most-corrected value first, the order frequentCorrections gives B's block. Two lessons
  // of one value fall back to their text, then (identical text, interchangeable) their id.
  const freq = new Map<string, number>();
  for (const e of pool) freq.set(e.correctValue, (freq.get(e.correctValue) ?? 0) + 1);
  return best.sort((a, b) => (freq.get(b.correctValue) ?? 0) - (freq.get(a.correctValue) ?? 0)
    || a.correctValue.localeCompare(b.correctValue) || a.inputText.localeCompare(b.inputText) || a.llmValue.localeCompare(b.llmValue)
    || a.logId.localeCompare(b.logId));
}

/**
 * What B against P says, in words and counts. Non-gating; the thresholds are G1's, the verdict
 * words are not. `shortTitles` is how many titles P ran on with fewer lessons than B's block
 * showed. "B is ahead of P" is the sentence that credits the owner's lessons, and it is not
 * said when P is the weaker stand-in (some block shorter than B's) or when the comparison
 * covers so few titles that one of them reaches G1's mark (`placeboMinTitles`); the count is
 * still printed, worded as a count.
 */
function placeboReading(c: { n: number; wins: number; losses: number; net: number }, shortTitles: number): string {
  if (c.n === 0) return 'P did not run on any scored target, so B could not be compared with it.';
  const tally = `${c.wins} titles where B is right and P wrong, ${c.losses} the other way`;
  const points = (100 * c.net) / c.n;
  if (c.net >= GATES.g1MinNet || points >= GATES.g1MinPoints) {
    const why = [
      c.n < DIAGNOSTICS.placeboMinTitles ? `P ran on only ${c.n} scored target${c.n === 1 ? '' : 's'}, where one title is ${fmt0(100 / c.n)} points` : '',
      shortTitles > 0 ? `P's block showed fewer lessons than B's on ${titlesN(shortTitles)}, so it is a weaker stand-in for B's block than intended` : '',
    ].filter(Boolean);
    if (why.length) return `B leads P on the count (${tally}), which is not read as more than a count: ${why.join('; and ')}.`;
    return `B is ahead of P (${tally}): more than the block's presence and framing account for.`;
  }
  if (c.net <= -GATES.g1MinNet || points <= -GATES.g1MinPoints) {
    return `P is ahead of B (${tally}): the placebo does at least as well as the owner's own lessons, so whatever B gained over A is not shown to come from them.`;
  }
  return `B and P are within one title of each other (${tally}): this measurement cannot tell the owner's lessons from the block's presence and framing `
    + `(minimum detectable effect one title in ${c.n}).`;
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
 * What code ran. The commit alone would be misleading in a worktree with edits on top, so
 * the paths that differ from it and a hash of the sources under test are recorded too.
 * Best effort: any of it can be null (no git, a source tarball).
 */
function harnessProvenance() {
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  const status = git(['status', '--porcelain', '--', 'src', 'test/classification-hint-live.test.ts'], serverDir);
  return {
    commit: git(['rev-parse', 'HEAD'], serverDir),
    differingFromCommit: status === null ? null : status.split('\n').filter(Boolean).slice(0, 40),
    sha256Prefix: Object.fromEntries([
      'test/classification-hint-live.test.ts', 'src/routes/tasks.ts', 'src/agents/quickadd.ts', 'src/services/classification-learning.ts',
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

// ── Self-check: the pure helpers, before any model time is spent ─────────────

describe.skipIf(!LIVE)('classification hint · pure helpers', () => {
  const mk = (arm: Arm, title: string, run: number, correct: boolean, over: Partial<CallRecord> = {}): CallRecord => ({
    arm, model: 'm', title, kind: 'target', convention: 'exercise-leisure', expected: 'leisure', run,
    promptSha: '', hintPresent: false, retrievalIds: [], raw: '{}', categoriesType: 'array',
    pick: correct ? 'leisure' : 'health', correct, lenientPick: correct ? 'leisure' : 'health', lenientCorrect: correct,
    validJson: true, allKeys: true, empty: false, error: null, ms: 1, embedMs: null, ...over,
  });
  /** `shape` is the per-run string for one title, e.g. 'FFTTT'. */
  const rows = (arm: Arm, title: string, shape: string, over: Partial<CallRecord> = {}): CallRecord[] =>
    [...shape].map((ch, run) => mk(arm, title, run, ch === 'T', over));

  it('percentile is nearest-rank and empty-safe', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile(Array.from({ length: 30 }, (_, i) => i + 1), 95)).toBe(29);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it('majority is strict, and the run string reads A: FFTTT', () => {
    expect(majorityCorrect([true, true, false, false, false])).toBe(false);
    expect(majorityCorrect([true, true, true, false, false])).toBe(true);
    expect(majorityCorrect([true, true, false, false])).toBe(false); // a tie is not a majority
    expect(majorityCorrect([])).toBe(false);
    expect(runString([false, false, true, true, true])).toBe('FFTTT');
    expect(modalPick(['health', null, 'leisure', 'leisure', 'health'])).toBe('health'); // tie: first seen
    expect(modalPick([null, null])).toBeNull();
  });

  it('wins, losses and the minimum detectable effect', () => {
    const recs = [
      ...rows('A', 't1', 'FFFFF'), ...rows('B', 't1', 'TTTTT'), // win
      ...rows('A', 't2', 'FFTFF'), ...rows('B', 't2', 'TTTTF'), // win
      ...rows('A', 't3', 'TTTTT'), ...rows('B', 't3', 'FFFFF'), // loss
      ...rows('A', 't4', 'TTTTT'), ...rows('B', 't4', 'TTTFT'), // stays right
      ...rows('A', 't5', 'FFFFF'), ...rows('B', 't5', 'FFFTT'), // stays wrong (2 of 5 is no majority)
    ];
    const c = compareArms(recs, 'm', 'A', 'B', ['t1', 't2', 't3', 't4', 't5']);
    expect(c).toMatchObject({ n: 5, baseCorrect: 2, treatCorrect: 3, wins: 2, losses: 1, net: 1 });
    expect(c.winTitles).toEqual(['t1', 't2']);
    expect(c.lossTitles).toEqual(['t3']);
  });

  it('the flip table reads A: FFTTT then B: TTTTT, and names the titles that flip between A and A2', () => {
    const recs = [
      ...rows('A', 't1', 'FFTTT'), ...rows('B', 't1', 'TTTTT'), ...rows('A2', 't1', 'FFTFF'), // A right, A2 wrong: a noise flip
      ...rows('A', 't2', 'FFFFF'), ...rows('A2', 't2', 'FFFTT'),
      ...rows('A', 't3', 'TTTTT'), ...rows('A2', 't3', 'TTTTT'),
    ];
    expect(flipCell(recs, 'm', 'A', 't1')).toBe('FFTTT>T');
    expect(flipCell(recs, 'm', 'B', 't1')).toBe('TTTTT>T');
    expect(flipCell(recs, 'm', 'A2', 't2')).toBe('FFFTT>F'); // 2 of 5 is no majority
    expect(flipCell(recs, 'm', 'C', 't1')).toBe('-'); // the arm never ran
    expect(flipCell([...rows('A', 't1', 'TFT')].reverse(), 'm', 'A', 't1')).toBe('TFT>T'); // read in run order
    expect(flipTitles(recs, 'm', 'A', 'A2', ['t1', 't2', 't3'])).toEqual(['t1']);
  });

  it('G1 verdicts at the pre-registered boundaries', () => {
    expect(efficacyVerdict(12, 2, 0)).toBe('IMPROVED'); // +2 titles net, 16.7 points
    expect(efficacyVerdict(12, 1, 0)).toBe('NO MEASURABLE CHANGE'); // 8.3 points, 1 title
    expect(efficacyVerdict(5, 1, 0)).toBe('IMPROVED'); // 20 points exactly
    expect(efficacyVerdict(12, 0, 0)).toBe('NO MEASURABLE CHANGE');
    expect(efficacyVerdict(12, -1, 0)).toBe('NO MEASURABLE CHANGE');
    expect(efficacyVerdict(12, -2, 0)).toBe('HARMED');
    expect(efficacyVerdict(5, -1, 0)).toBe('HARMED');
    expect(efficacyVerdict(12, 5, 3)).toBe('INCONCLUSIVE: NOISE'); // A versus A2 moved 3 titles
    expect(efficacyVerdict(12, 5, 2)).toBe('IMPROVED'); // 2 is still inside the pre-registered tolerance
    expect(efficacyVerdict(0, 0, 0)).toBe('INCONCLUSIVE: NO HEADROOM');
  });

  it('headroom: a baseline of 75% or more is not scored', () => {
    expect(hasHeadroom(3, 4)).toBe(false);
    expect(hasHeadroom(2, 4)).toBe(true);
    expect(hasHeadroom(0, 4)).toBe(true);
    expect(hasHeadroom(4, 4)).toBe(false);
    expect(hasHeadroom(0, 0)).toBe(false);
  });

  it('G2 counts baseline-correct to hinted-wrong controls, G3 the schema, G5 the share', () => {
    const titles = ['c1', 'c2', 'c3'];
    const recs = [
      ...rows('A', 'c1', 'TTTTT'), ...rows('B', 'c1', 'FFFFF'), // flipped
      ...rows('A', 'c2', 'TTTTT'), ...rows('B', 'c2', 'TTTTT'),
      ...rows('A', 'c3', 'FFFFF'), ...rows('B', 'c3', 'TTTTT'), // healed, not a flip
      ...rows('A', 's1', 'FFFFF'), ...rows('B', 's1', 'TTTTT'), ...rows('A2', 's1', 'FFFFT'),
      ...rows('A', 's2', 'FFFFF'), ...rows('B', 's2', 'FFFFF'), ...rows('A2', 's2', 'FFFFF'),
    ];
    const one = evaluateTreatment(recs, 'm', 'B', ['s1', 's2'], titles);
    expect(one.g2).toMatchObject({ baseCorrect: 2, flipped: ['c1'], healed: ['c3'], pass: true });
    expect(one.g1).toMatchObject({ n: 2, net: 1, noiseFlips: 0, verdict: 'IMPROVED', deltaPoints: 50, mdePoints: 50 });
    expect(one.g5).toMatchObject({ baseShare: 0, treatShare: 50, pass: true });
    expect(one.g3.pass).toBe(true);
    // PASS stays PASS; the note says how little a PASS is worth when only 2 controls could flip.
    expect(one.power).toMatchObject({ g2FlippableControls: 2, controls: 3, g3BaseKeysPct: 100, g3BaseArrayPct: 100, g3TreatArrayPct: 100 });
    expect(one.power.notPowered).toHaveLength(1);
    expect(one.power.notPowered[0]).toMatch(/^NOT POWERED: G2 can only flip 2 of 3 controls/);

    const worse = [...recs, ...rows('A', 'c4', 'TTTTT'), ...rows('B', 'c4', 'FFFFF')];
    expect(evaluateTreatment(worse, 'm', 'B', ['s1', 's2'], [...titles, 'c4']).g2.pass).toBe(false); // 2 flips > 1

    const noGain = [...rows('A', 's1', 'FFFFF'), ...rows('B', 's1', 'FFFFF')];
    expect(evaluateTreatment(noGain, 'm', 'B', ['s1'], []).g5.pass).toBe(false);
  });

  it('G3: within 5 points passes, below fails, a new empty completion fails', () => {
    const calls = (arm: Arm, bad: number, n = 100, over: Partial<CallRecord> = {}) =>
      Array.from({ length: n }, (_, i) => mk(arm, 'x', i, true, i < bad ? over : {}));
    const bare = (hintedBad: number, over: Partial<CallRecord>) =>
      evaluateTreatment([...calls('A', 0), ...calls('B', hintedBad, 100, over)], 'm', 'B', [], []).g3.pass;
    expect(bare(5, { validJson: false })).toBe(true); // 95% is exactly 5 points under 100%
    expect(bare(6, { validJson: false })).toBe(false);
    expect(bare(6, { allKeys: false })).toBe(false);
    expect(bare(1, { empty: true, raw: '' })).toBe(false); // A had none
    expect(evaluateTreatment([...calls('A', 1, 100, { empty: true }), ...calls('B', 1, 100, { empty: true })], 'm', 'B', [], []).g3.pass)
      .toBe(true); // not new
  });

  it('G6: the latency gate', () => {
    const flat = (ms: number) => Array.from({ length: 30 }, () => ms);
    expect(hintLatencyGate(flat(2), flat(1)).pass).toBe(true);
    expect(hintLatencyGate(flat(21), flat(1)).pass).toBe(false); // p50 over
    expect(hintLatencyGate([...flat(2).slice(0, 27), 70, 70, 70], flat(1)).pass).toBe(false); // p95 over
    expect(hintLatencyGate(flat(2), flat(6)).pass).toBe(false); // no-index p95 over
    expect(hintLatencyGate([], flat(1)).pass).toBe(false); // no data is not a pass
  });

  // A miniature of enrichQuick's prompt: the key lines the layouts care about, the last rule line, the entry.
  const hintA = '\nThis user has corrected you before. Follow their vocabulary, not your own:\n- For "x" you said a; the user chose b.\n';
  const hintB = '\nThis user has corrected you before. Follow their vocabulary, not your own:\n- For "y" you said c; the user chose d.\n';
  const mHead = 'Classify.\n"motivation": m\n';
  const mCats = '"categories": c\n';
  const mTail = '"tags": t\nChoose ONLY from the lists, never invent.\n';
  const mEntry = 'Entry: "gym"';
  const mStock = mHead + mCats + mTail + mEntry;
  /** The shipped layout: the blocks are the last thing before the entry, with no separator of their own. */
  const mShipped = mHead + mCats + mTail + hintA + hintB + mEntry;
  /** The old enrichQuick's: each block beside its field, one more newline after it. */
  const mAdjacent = mHead + `${hintA}\n` + mCats + `${hintB}\n` + mTail + mEntry;
  const mHints = { motivation: hintA, category: hintB };

  it('hints go in once and come out again in either layout, and arm C is the old layout rebuilt from the shipped one', () => {
    expect(ARM_LAYOUTS).toMatchObject({ B: 'last', C: 'adjacent' }); // C changed meaning on 2026-11-02
    expect(occurrences(mShipped, HINT_MARKER)).toBe(2);
    expect(occurrences(mStock, RULES_END)).toBe(1);
    expect(withoutHints(mShipped, [hintA, hintB])).toBe(mStock);
    expect(withoutHints(mAdjacent, [hintA, hintB], 'adjacent')).toBe(mStock);
    expect(withoutHints(mStock, [''])).toBe(mStock);
    expect(() => withoutHints(mStock, [hintA])).toThrow();
    // The layouts cannot be mistaken for each other: the wrong one throws or leaves the extra newlines behind.
    expect(() => withoutHints(mShipped, [hintA, hintB], 'adjacent')).toThrow();
    expect(withoutHints(mAdjacent, [hintA, hintB])).not.toBe(mStock);

    // Rebuilt from the shipped prompt, whichever order its blocks come in.
    expect(adjacentLayout(mShipped, mHints)).toBe(mAdjacent);
    expect(adjacentLayout(mHead + mCats + mTail + hintB + hintA + mEntry, mHints)).toBe(mAdjacent);
    expect(adjacentLayout(mStock, { motivation: '', category: '' })).toBe(mStock); // nothing to move
    expect(adjacentLayout(mHead + mCats + mTail + hintA + mEntry, { motivation: hintA, category: '' }))
      .toBe(mHead + `${hintA}\n` + mCats + mTail + mEntry);
    expect(adjacentLayout(mHead + mCats + mTail + hintB + mEntry, { motivation: '', category: hintB }))
      .toBe(mHead + mCats + `${hintB}\n` + mTail + mEntry);
    // An owner with no categories: the motivation block goes before "tags", and a category hint has no line to sit beside.
    expect(adjacentLayout(mHead + mTail + hintA + mEntry, { motivation: hintA, category: '' })).toBe(mHead + `${hintA}\n` + mTail + mEntry);
    expect(() => adjacentLayout(mHead + mTail + hintB + mEntry, { motivation: '', category: hintB })).toThrow(/categories/);
    expect(() => adjacentLayout(mHead + mCats + mTail, { motivation: '', category: '' })).toThrow(/Entry/);
    // The entry's own text is not read for key lines, even one that looks like a schema line.
    const odd = 'Entry: "a\n"tags": b"';
    expect(adjacentLayout(mHead + mCats + mTail + hintB + odd, { motivation: '', category: hintB }))
      .toBe(mHead + mCats + `${hintB}\n` + mTail + odd);
  });

  it('the layout check reads where the blocks sit and what else is around them', () => {
    const problems = (prompt: string, hints: typeof mHints | null, layout: Layout) => promptProblems('x', 'gym', prompt, hints, layout).join('\n');
    expect(problems(mShipped, mHints, 'last')).toBe('');
    expect(problems(mAdjacent, mHints, 'adjacent')).toBe('');
    expect(problems(mStock, null, 'last')).toBe('');
    expect(problems(mStock, { motivation: '', category: '' }, 'last')).toBe(''); // a hinted arm with nothing retrieved is the stock prompt
    expect(problems(mShipped, { motivation: '', category: hintB }, 'last')).toMatch(/2 hint blocks in the prompt, expected 1/); // hintA is a stray block
    // The wrong layout is named, not passed.
    expect(problems(mAdjacent, mHints, 'last')).toMatch(/not between the never-invent line and Entry/);
    expect(problems(mShipped, mHints, 'adjacent')).toMatch(/not beside its field/);
    // Nothing but the blocks between the rules and the entry: no rule line, no separator.
    expect(problems(mHead + mCats + mTail + hintA + hintB + 'Remember: be brief.\n' + mEntry, mHints, 'last')).toMatch(/something besides the hint blocks/);
    expect(problems(mHead + mCats + mTail + hintA + hintB + '\n' + mEntry, mHints, 'last')).toMatch(/something besides the hint blocks/);
    expect(problems(mHead + mCats + hintA + hintB + mTail + mEntry, mHints, 'last')).toMatch(/not between the never-invent line and Entry/); // above the rules line
    // Counts, strays and the entry.
    expect(problems(mShipped, null, 'last')).toMatch(/must have none/);
    expect(problems(mStock, mHints, 'last')).toMatch(/0 hint blocks in the prompt, expected 2/);
    expect(problems(`${mShipped} and more`, mHints, 'last')).toMatch(/does not end with the entry/);
    expect(problems(mStock.replace('never invent.\n', ''), mHints, 'last')).toMatch(/no never-invent line/);
    expect(problems(mShipped, mHints, 'narrow')).toBe(''); // the narrow question checks the count only
  });

  /**
   * enrichQuick's prompt as it was when the hint first shipped (git show
   * 96dbea90:server/src/agents/quickadd.ts): each block beside its field, one extra newline
   * after it. A literal on purpose, the way test/quickadd-hint-prompt.test.ts pins today's:
   * arm C claims to be this prompt, so the claim is checked against this and not against the
   * code that builds C. The rubric constants are substituted, not copied.
   */
  const formerLayoutPrompt = (text: string, vocab: Vocab, hints: QuickHints): string => {
    const withHint = (hint?: string): string => (hint ? `${hint}\n` : '');
    return `Classify this quick task entry. Reply with JSON with exactly these keys.\n` +
      `"direction": REQUIRED — exactly one of ${JSON.stringify(vocab.directions)}. ` +
      `Every task has a direction, always choose one.${directionGuide(vocab.directions)}\n` +
      `"isComplex": true or false. ${COMPLEXITY_RUBRIC}\n` +
      `"priority": 1-4. ${PRIORITY_RUBRIC}\n` +
      `"estimatedMinutes": a number or null. ${DURATION_RUBRIC}\n` +
      `"timeOfDay": one of "morning","afternoon","evening","any". ${TIME_OF_DAY_RUBRIC}\n` +
      `"timeOfDayReason": a few words on why, or null.\n` +
      `"motivation": one of "me","us","them", or null. ${MOTIVATION_RUBRIC}\n` +
      withHint(hints.motivation) +
      (vocab.categories.length
        ? `"categories": 1-3 life areas from ${JSON.stringify(vocab.categories)}, best fit first.\n` + withHint(hints.category)
        : '') +
      `"tags": up to 2 from ${JSON.stringify(vocab.others.slice(0, 60))}, else [].\n` +
      `Choose direction/categories/tags ONLY from the given lists — never invent.\n` +
      `Entry: "${text}"`;
  };

  it('enrichQuick as it stands lays the hints out as the checks expect, and the former prompt is rebuilt from it byte for byte', async () => {
    // The drift check for the layout: a dry call (nothing reaches Ollama) to the real enrichQuick, so a change
    // to where it puts the blocks, or to the lines around them, fails here and not after model time is spent.
    const text = 'Leg day at the gym';
    const parsed = parseQuick(text);
    const vocab: Vocab = { directions: DIRECTIONS, categories: CATEGORIES, others: OTHERS };
    const category = exemplarPrompt([{ logId: 'a', inputText: 'Gym session', llmValue: 'health', correctValue: 'leisure' }]);
    const motivation = exemplarPrompt([{ logId: 'b', inputText: 'Help mum move', llmValue: 'me', correctValue: 'them' }]);
    const stock = await dryPrompt(() => enrichQuick(text, parsed, vocab));
    expect(stock, 'enrichQuick put no prompt in front of the model').not.toBe('');
    expect(stock).toBe(formerLayoutPrompt(text, vocab, {})); // the prompt around the blocks is the one the literal below is written for
    expect(occurrences(stock, RULES_END)).toBe(1);
    for (const hints of [{ motivation, category }, { motivation, category: '' }, { motivation: '', category }, { motivation: '', category: '' }]) {
      const shipped = await dryPrompt(() => enrichQuick(text, parsed, vocab, hints));
      const which = `motivation ${hints.motivation ? 'yes' : 'no'}, category ${hints.category ? 'yes' : 'no'}`;
      expect(promptProblems(which, text, shipped, hints, 'last'), which).toEqual([]);
      expect(withoutHints(shipped, [hints.motivation, hints.category]), which).toBe(stock);
      expect(adjacentLayout(shipped, hints), which).toBe(formerLayoutPrompt(text, vocab, hints));
    }
    // An owner with no categories is not asked for them, so there is no line for a category hint.
    const bare: Vocab = { ...vocab, categories: [] };
    const bareStock = await dryPrompt(() => enrichQuick(text, parsed, bare));
    const bareShipped = await dryPrompt(() => enrichQuick(text, parsed, bare, { motivation }));
    expect(promptProblems('no categories', text, bareShipped, { motivation, category: '' }, 'last')).toEqual([]);
    expect(withoutHints(bareShipped, [motivation])).toBe(bareStock);
    expect(adjacentLayout(bareShipped, { motivation, category: '' })).toBe(formerLayoutPrompt(text, bare, { motivation }));
  });

  const lessonOf = (correctValue: string, logId = 'l'): Exemplar => ({ logId, inputText: 't', llmValue: 'x', correctValue });

  it('choosable reads a stored pick as a sequence of whole allowed names, a comma inside a name included', () => {
    const ok = choosable(['Health', 'leisure']);
    expect(ok(lessonOf('health'))).toBe(true);
    expect(ok(lessonOf('HEALTH'))).toBe(true); // case-insensitive
    expect(ok(lessonOf('leisure, health'))).toBe(true);
    expect(ok(lessonOf('health, leisure, health'))).toBe(true); // a sequence, repeats allowed
    expect(ok(lessonOf('leisure, finance'))).toBe(false);
    expect(ok(lessonOf('career'))).toBe(false);
    expect(ok(lessonOf(''))).toBe(false);
    expect(ok(lessonOf('   '))).toBe(false);
    // No empty segment, and canonicalValue's separator is exactly ', '.
    for (const bad of ['health,', ', health', 'health, ', 'health, , leisure', 'health,leisure', 'health;leisure']) {
      expect(ok(lessonOf(bad)), JSON.stringify(bad)).toBe(false);
    }
    // normalizeTagName("Health, Fitness") keeps the comma: the name is `health,-fitness`.
    const withComma = choosable(['health', 'Health,-Fitness', 'leisure']);
    expect(withComma(lessonOf('health,-fitness'))).toBe(true);
    expect(withComma(lessonOf('health,-fitness, leisure'))).toBe(true);
    expect(withComma(lessonOf('leisure, health,-fitness, health'))).toBe(true);
    expect(withComma(lessonOf('health,-fit'))).toBe(false); // not a whole name
    expect(choosable(['health', 'leisure'])(lessonOf('health,-fitness'))).toBe(false); // the name is not allowed
    // Empty and duplicate allowed names change nothing; a long run is not exponential.
    expect(choosable(['', 'a', 'A', 'aa'])(lessonOf('a, aa, a'))).toBe(true);
    const run = 'a, '.repeat(300);
    expect(choosable(['a', 'aa'])(lessonOf(`${run}a`))).toBe(true);
    expect(choosable(['a', 'aa'])(lessonOf(`${run}b`))).toBe(false);
    expect(choosable([])(lessonOf('health'))).toBe(false);
  });

  it("choosable agrees with the one in routes/tasks.ts, lifted out of that file's source", async () => {
    const src = readFileSync(new URL('../src/routes/tasks.ts', import.meta.url), 'utf8');
    const at = src.indexOf('function choosable(');
    expect(at, 'routes/tasks.ts has no function choosable( any more: update this extraction and the copy above').toBeGreaterThanOrEqual(0);
    const end = src.indexOf('\n}\n', at);
    expect(end, 'the end of choosable( was not found').toBeGreaterThan(at);
    const { default: ts } = await import('typescript'); // heavy, so only this test pays for it
    const js = ts.transpileModule(src.slice(at, end + 2), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const route = runInNewContext(`${js}\n;choosable`) as typeof choosable;
    expect(typeof route).toBe('function');
    const lists = [['health', 'leisure'], ['Health', 'Health,-Fitness', 'leisure'], ['a', 'aa'], [''], [], ['finance', 'Finance', 'career']];
    const values = [
      'health', 'HEALTH', ' health ', 'leisure, health', 'leisure, finance', '', '   ', 'health,', ', health', 'health, ', 'health, , leisure',
      'health,leisure', 'health,-fitness', 'health,-fitness, leisure', 'leisure, health,-fitness, health', 'health,-fit',
      'a, aa, a', 'a, a, aa, aa', 'aa, a, ', 'finance, career', 'career, finance, career', 'Career,  finance',
    ];
    for (const list of lists) {
      for (const value of values) {
        expect(choosable(list)(lessonOf(value)), `harness copy vs route on ${JSON.stringify(list)} / ${JSON.stringify(value)}`)
          .toBe(route(list)(lessonOf(value)));
      }
    }
  });

  it('categoriesTypeOf reads the shape production sees', () => {
    // The first line is qwen2.5:0.5b on all 60 baseline completions of the first live run.
    expect(categoriesTypeOf('{"direction":"community","categories":"leisure","tags":[]}')).toBe('string');
    expect(categoriesTypeOf('{"categories":["leisure"]}')).toBe('array');
    expect(categoriesTypeOf('{"categories":[]}')).toBe('array');
    expect(categoriesTypeOf('```json\n{"categories":["health"]}\n```')).toBe('array'); // the loose parse production uses
    expect(categoriesTypeOf('{"direction":"home"}')).toBe('missing');
    expect(categoriesTypeOf('{}')).toBe('missing');
    expect(categoriesTypeOf('')).toBe('missing'); // an empty or errored completion has nothing to read
    expect(categoriesTypeOf('not json at all')).toBe('missing');
    expect(categoriesTypeOf('["leisure"]')).toBe('missing'); // no object, so no key
    expect(categoriesTypeOf('null')).toBe('missing');
    expect(categoriesTypeOf('{"categories":null}')).toBe('other');
    expect(categoriesTypeOf('{"categories":{"a":1}}')).toBe('other');
    expect(categoriesTypeOf('{"categories":7}')).toBe('other');
  });

  it('a bare string is no pick in production, and a lenient pick for the record', () => {
    expect(constrainToVocabulary('leisure', CATEGORIES, 3)).toEqual([]); // the premise: production drops it
    expect(constrainToVocabulary(['leisure'], CATEGORIES, 3)).toEqual(['leisure']);
    expect(lenientPickOf('{"categories":"Leisure"}', CATEGORIES)).toBe('leisure');
    expect(lenientPickOf('{"categories":"health, leisure"}', CATEGORIES)).toBe('health');
    expect(lenientPickOf('{"categories":["leisure","health"]}', CATEGORIES)).toBe('leisure');
    expect(lenientPickOf('{"categories":"hobbies"}', CATEGORIES)).toBeNull();
    expect(lenientPickOf('{"categories":7}', CATEGORIES)).toBeNull();
    expect(lenientPickOf('{}', CATEGORIES)).toBeNull();
    expect(lenientPickOf('garbage', CATEGORIES)).toBeNull();
  });

  it('shape shares, the unusable-shape label, accuracy among array answers, the lenient score', () => {
    const str = { categoriesType: 'string' as const, pick: null, correct: false };
    const calls = [
      ...rows('A', 't1', 'TTF'), // arrays: 2 right, 1 wrong
      ...rows('A', 't2', 'FFFFF', { ...str, lenientPick: 'leisure', lenientCorrect: true }), // bare strings the model meant right
      ...rows('A', 't3', 'F', { categoriesType: 'missing', pick: null, lenientPick: null, lenientCorrect: false }),
      ...rows('A', 't4', 'F', { categoriesType: 'other', pick: null, lenientPick: null, lenientCorrect: false }),
    ];
    expect(shapeStats(calls)).toEqual({ n: 10, array: 3, string: 5, missing: 1, other: 1, arrayPct: 30 });
    expect(shapeUnusable(shapeStats(calls))).toBe(true);
    expect(accuracyGivenShape(calls)).toEqual({ n: 10, correct: 2, arrays: 3, correctGivenArray: 2, lenient: 7 });
    expect(lenientMajority(calls, 'm', 'A', ['t1', 't2', 't3'])).toBe(2); // t1 and t2; t3 is missing
    expect(armShape(calls, 'm', 'A', ['t1', 't2'], ['t3'])).toMatchObject({
      shape: { n: 10 }, targets: { n: 8, correct: 2, arrays: 3, lenient: 7 }, controls: { n: 1, correct: 0, arrays: 0, lenient: 0 },
    });
    expect(armShape(calls, 'm', 'B', ['t1'], [])).toBeNull(); // the arm never ran

    // The boundary: exactly half is usable, a shade under is not, nothing at all is not a verdict.
    const halves = (arrays: number, n: number) => Array.from({ length: n }, (_, i) => mk('A', 'x', i, true, { categoriesType: i < arrays ? 'array' : 'string' }));
    expect(shapeUnusable(shapeStats(halves(5, 10)))).toBe(false);
    expect(shapeUnusable(shapeStats(halves(49, 100)))).toBe(true);
    expect(shapeUnusable(shapeStats([]))).toBe(false);
    expect(stoppedStatus(shapeStats(calls))).toBe('INCONCLUSIVE: UNUSABLE ANSWER SHAPE');
    expect(stoppedStatus(shapeStats(halves(10, 10)))).toBe('INCONCLUSIVE: NO HEADROOM');
    const note = unusableShapeNote(shapeStats(calls));
    expect(note).toContain('30.0%');
    expect(note).toContain('constrainToVocabulary'); // the printed output says why a bare string is no pick
    expect(note).toContain('qwen2.5:0.5b');
  });

  it('the shape reading names an unusable baseline, a shifted share and a placebo that shifted with it', () => {
    expect(baselineShapeLine(0).join(' ')).toContain('INCONCLUSIVE: UNUSABLE ANSWER SHAPE');
    expect(baselineShapeLine(49.9)).toHaveLength(1);
    expect(baselineShapeLine(50)).toEqual([]);
    expect(baselineShapeLine(NaN)).toEqual([]);
    expect(shapeShiftLine(100, 'B', 100, null)).toEqual([]);
    expect(shapeShiftLine(80, 'B', 99.9, null)).toEqual([]); // under the shift threshold
    const moved = shapeShiftLine(20, 'B', 75, null);
    expect(moved.join(' ')).toContain('20.0% to 75.0%');
    expect(moved.join(' ')).not.toContain('P moved');
    // P's clause reads the shares over the titles P ran on (n of them), all three cut to them.
    const basis = (aPct: number, armPct: number, placeboPct: number, n = 19): PlaceboShapeBasis => ({ n, aPct, armPct, placeboPct });
    const same = shapeShiftLine(60, 'B', 90, basis(60, 90, 88)).join(' ');
    expect(same).toContain('P moved it the same way');
    expect(same).toContain('Over the 19 titles P ran on'); // the sentence says which titles its three shares are over
    expect(same).toContain('A is at 60.0%, B at 90.0% and P at 88.0%');
    expect(shapeShiftLine(60, 'B', 90, basis(60, 90, 61)).join(' ')).not.toContain('P moved');
    expect(shapeShiftLine(60, 'B', 90, basis(60, 90, 30)).join(' ')).not.toContain('P moved'); // the other way
    expect(shapeShiftLine(60, 'P', 90, basis(60, 90, 88)).join(' ')).not.toContain('the same way'); // P does not compare itself with itself
    expect(shapeShiftLine(NaN, 'B', NaN, null)).toEqual([]);
    // Like for like: B fell 25 points over all its titles, but what P is compared with is B over P's titles.
    expect(shapeShiftLine(70, 'B', 45, basis(60, 50, 52)).join(' ')).not.toContain('P moved'); // on P's titles B moved 10, under the mark
    expect(shapeShiftLine(70, 'B', 45, basis(60, 35, 38)).join(' ')).toContain('P moved it the same way'); // on P's titles both fell 20+
    expect(shapeShiftLine(70, 'B', 45, basis(60, 58, 30)).join(' ')).not.toContain('P moved'); // B did not move there, P alone did
    expect(shapeShiftLine(70, 'B', 45, basis(60, 35, NaN)).join(' ')).not.toContain('P moved'); // no share for P on those titles
  });

  // [completion, names one of the owner's directions, makes enrichQuick ask a second direction question]
  const DIRECTION_CASES: readonly (readonly [string, boolean, boolean])[] = [
    ['{"direction":"home"}', true, false],
    ['{"direction":" Work "}', true, false], // trimmed and case-insensitive, as constrainOne reads it
    ['```json\n{"direction":"community"}\n```', true, false], // the loose parse production uses
    ['{"direction":"errands"}', false, true], // a name the owner has, but not a direction
    ['{"direction":"home."}', false, true],
    ['{"direction":null}', false, true],
    ['{"direction":["home"]}', false, true], // a list is no direction
    ['{"categories":["leisure"]}', false, true], // the key is absent: what a model that stopped early leaves
    ['{}', false, true],
    ['[]', false, true],
    ['7', false, true],
    ['"home"', false, true],
    ['', false, false], // nothing to read: the first pass fails and the caller keeps the deterministic parse
    ['not json at all', false, false],
    ['null', false, false], // mergeEnrichment throws on null
  ];

  it("direction: a completion names one of the owner's directions or makes enrichQuick ask again, and that is what enrichQuick does", async () => {
    for (const [raw, valid, secondChance] of DIRECTION_CASES) {
      expect(directionOf(raw, DIRECTIONS), JSON.stringify(raw)).toEqual({ valid, secondChance });
    }
    expect(directionOf('{"direction":"home"}', [])).toEqual({ valid: false, secondChance: false }); // an owner with no directions is asked nothing

    // The claim is held against the real enrichQuick, driven through the same completions: one model call when the
    // first answer settles it (or fails), two when it names no direction, and the first pass throwing exactly when
    // it cannot be read. A change to enrichQuick's second chance fails here, before a live run reports a stale share.
    const text = 'Leg day at the gym';
    const vocab: Vocab = { directions: DIRECTIONS, categories: CATEGORIES, others: OTHERS };
    const drive = async (raw: string, v: Vocab): Promise<{ calls: number; threw: boolean }> => {
      rec.script = [raw, '{"direction":"home"}'];
      const before = rec.calls.length;
      let threw = false;
      try { await enrichQuick(text, parseQuick(text), v); } catch { threw = true; } finally { rec.script = null; }
      return { calls: rec.calls.length - before, threw };
    };
    for (const [raw, valid, secondChance] of DIRECTION_CASES) {
      const run = await drive(raw, vocab);
      expect(run, JSON.stringify(raw)).toEqual({ calls: secondChance ? 2 : 1, threw: !valid && !secondChance });
    }
    expect(await drive('{}', { ...vocab, directions: [] })).toEqual({ calls: 1, threw: false });
  });

  it('direction shares count calls: a valid name, a second call, and the unreadable ones in neither', () => {
    const calls = [
      ...rows('A', 't1', 'TTTTT', { raw: '{"direction":"home"}' }),
      ...rows('A', 't2', 'FF', { raw: '{"direction":"errands"}' }),
      ...rows('A', 't3', 'F', { raw: '', empty: true }),
    ];
    expect(directionStats(calls, DIRECTIONS)).toEqual({ n: 8, valid: 5, secondChance: 2, validPct: 62.5, secondChancePct: 25 });
    expect(directionStats([], DIRECTIONS)).toMatchObject({ n: 0, valid: 0, secondChance: 0 });
    expect(Number.isNaN(directionStats([], DIRECTIONS).validPct)).toBe(true);
    // Per arm, cut to titles, against the owner's own vocabulary; the narrow question asks for no direction.
    expect(armShape(calls, 'm', 'A', ['t1', 't2'], ['t3'])!.direction).toMatchObject({ n: 8, valid: 5, secondChance: 2 });
    expect(armShape(calls, 'm', 'A', ['t1'], [], { only: new Set(['t1']) })!.direction).toMatchObject({ n: 5, valid: 5, secondChance: 0 });
    expect(armShape(calls, 'm', 'A', ['t1', 't2'], [], { directions: ['errands'] })!.direction).toMatchObject({ valid: 2, secondChance: 5 });
    expect(armShape(rows('N0', 't1', 'TT', { raw: '{"categories":["leisure"]}' }), 'm', 'N0', ['t1'], [])!.direction).toBeNull();
  });

  it('the direction reading prints the shares and flags a hinted arm that moves the second-call share', () => {
    const shapesOf = (raws: Record<string, string>): Record<string, ArmShape> => Object.fromEntries(
      Object.entries(raws).map(([arm, raw]) => [arm, armShape(rows(arm as Arm, 't1', 'TTTTT', { raw }), 'm', arm as Arm, ['t1'], [])!]),
    );
    const named = '{"direction":"home"}';
    const silent = '{"categories":["leisure"]}'; // the key B drops when the hint costs a small model its JSON
    const moved = directionReading(shapesOf({ A: named, B: silent, C: named }), null);
    expect(moved[0]).toContain('A 100.0% valid, 0.0% second call; B 0.0% valid, 100.0% second call; C 100.0% valid, 0.0% second call');
    expect(moved).toHaveLength(2);
    expect(moved[1]).toMatch(/^Direction: B moved the share of completions that need a second direction call from 0\.0% to 100\.0%/);
    expect(moved[1]).toContain('another sequential model call on the quick-add path');
    expect(directionReading(shapesOf({ A: named, B: named }), null)).toHaveLength(1); // no shift, no flag
    expect(directionReading({}, null)).toEqual([]);
    expect(directionReading(shapesOf({ N0: named }), null)).toEqual([]); // the narrow arms carry none
  });

  it('power notes say how little a PASS is worth, and leave PASS and FAIL as registered', () => {
    expect(powerNotes(6, 12, 100)).toEqual([]);
    expect(powerNotes(5, 12, 100)).toHaveLength(1);
    expect(powerNotes(5, 12, 100)[0]).toMatch(/^NOT POWERED: G2 can only flip 5 of 12 controls/);
    expect(powerNotes(12, 12, 49.9)[0]).toMatch(/^NOT POWERED: G3's key clause/);
    expect(powerNotes(12, 12, 50)).toEqual([]);
    expect(powerNotes(12, 12, NaN)).toHaveLength(1); // no baseline calls is not a powered gate
    expect(powerNotes(0, 12, 0)).toHaveLength(2);

    // A baseline that already omits keys (qwen2.5:0.5b: 3 of 9): G3 passes, as registered, and says it could not fail.
    const calls = (arm: Arm, n = 20, over: Partial<CallRecord> = {}) => Array.from({ length: n }, (_, i) => mk(arm, 'x', i, true, over));
    const g3 = evaluateTreatment([...calls('A', 20, { allKeys: false }), ...calls('B', 20, { allKeys: false })], 'm', 'B', [], []);
    expect(g3.g3.pass).toBe(true);
    expect(g3.power.g3BaseKeysPct).toBe(0);
    expect(g3.power.notPowered.join(' ')).toContain("G3's key clause");
  });

  // The pool the placebo draws from: the owner's six training lessons per convention, as calibrate would index them.
  const pool = CONVENTIONS.flatMap((c) => c.train.map((t, i): Exemplar => ({
    logId: `${c.id}:${i}`, inputText: t, llmValue: `${c.modelDefault}, ${c.owner}`, correctValue: c.owner,
  })));
  /** B's block: the newest lesson of each value, which is what the frequency path shows when each value is as common as the next. */
  const bBlock = CONVENTIONS.map((c) => pool.filter((e) => e.correctValue === c.owner).at(-1)!);

  it("the placebo has B's lesson count, never B's lessons, never the title's own value, and B's length as closely as the pool allows", () => {
    const own = 'leisure';
    const p = placeboLessons(pool, own, bBlock, 'Leg day at the gym');
    expect(p).toHaveLength(bBlock.length);
    expect(p.some((e) => e.correctValue === own)).toBe(false);
    expect(p.some((e) => bBlock.some((r) => r.logId === e.logId))).toBe(false);
    expect(new Set(p.map((e) => e.correctValue))).toEqual(new Set(['career', 'growth'])); // one value left per other convention, both shown
    expect(placeboLessons(pool, own, bBlock, 'Leg day at the gym')).toEqual(p); // a run repeats
    const gap = Math.abs(exemplarPrompt(p).length - exemplarPrompt(bBlock).length);
    // Better than the naive pick (the first candidates in hash order, no length search).
    const naive = pool.filter((e) => e.correctValue !== own && !bBlock.includes(e)).slice(0, 3);
    expect(gap).toBeLessThanOrEqual(Math.abs(exemplarPrompt(naive).length - exemplarPrompt(bBlock).length));
    expect(gap).toBeLessThanOrEqual(6);
    // It is a real block in B's format.
    expect(occurrences(exemplarPrompt(p), HINT_MARKER)).toBe(1);
    // Different titles see different lessons (the draw is keyed on the title).
    const draws = new Set(TARGET_ITEMS.map((t) => placeboLessons(pool, ownValueOf(t), bBlock, t.title).map((e) => e.logId).join()));
    expect(draws.size).toBeGreaterThan(1);
  });

  it('the placebo of a control avoids only the convention it sits beside, and takes every value when it sits beside none', () => {
    const dentist = ITEMS.find((i) => i.title === 'Dentist appointment')!;
    const flu = ITEMS.find((i) => i.title === 'Flu shot at the pharmacy')!;
    expect(ownValueOf(dentist)).toBe('leisure'); // beside exercise-leisure
    expect(ownValueOf(flu)).toBeNull();
    expect(ownValueOf(TARGET_ITEMS[0])).toBe(TARGET_ITEMS[0].expected);
    expect(placeboLessons(pool, ownValueOf(dentist), bBlock, dentist.title).some((e) => e.correctValue === 'leisure')).toBe(false);
    const free = placeboLessons(pool, null, bBlock, flu.title);
    expect(free).toHaveLength(3);
    expect(new Set(free.map((e) => e.correctValue)).size).toBe(3); // one lesson per value, like B's block
  });

  it('the same index content draws the same placebo lessons whatever the log ids are, ties and twin lessons included', () => {
    // Ids are minted per run (and the index is read ORDER BY log_id, so new ids mean a new row order). Keyed on them, ties between
    // equally good combinations fell to the new ids and a re-run drew other lessons from the same content.
    const textOf = (ls: readonly Exemplar[]): string[] => ls.map((e) => `${e.inputText}|${e.llmValue}|${e.correctValue}`);
    const rename = (e: Exemplar, tag: string): Exemplar => ({ ...e, logId: `${tag}-${[...e.logId].reverse().join('')}` });
    const secondRun = pool.map((e) => rename(e, 'run2')).reverse();
    const bBlock2 = bBlock.map((e) => rename(e, 'run2'));
    for (const item of [...TARGET_ITEMS, ...CONTROL_ITEMS]) {
      const first = placeboLessons(pool, ownValueOf(item), bBlock, item.title);
      expect(textOf(placeboLessons(secondRun, ownValueOf(item), bBlock2, item.title)), item.title).toEqual(textOf(first));
    }
    // Twin lessons (one input, said and chosen alike, two rows): the block is the same text whichever twin is drawn.
    const twin = (logId: string): Exemplar => ({ logId, inputText: 'Gym workout', llmValue: 'health', correctValue: 'leisure' });
    const withTwins = [twin('a1'), twin('a2'), ...pool.filter((e) => e.correctValue !== 'leisure')];
    const reversed = [...withTwins].reverse().map((e) => rename(e, 'b'));
    const realTwins = bBlock.filter((e) => e.correctValue !== 'leisure');
    expect(textOf(placeboLessons(withTwins, 'growth', realTwins, 'Silent sitting meditation')))
      .toEqual(textOf(placeboLessons(reversed, 'growth', realTwins.map((e) => rename(e, 'b')), 'Silent sitting meditation')));
  });

  it('the placebo counts the lessons that name the own value on the "you said" side, which its filter lets through', () => {
    const gym: Exemplar = { logId: 'g', inputText: 'Gym workout with the lifting group', llmValue: 'health, growth', correctValue: 'leisure' };
    expect(ownOnRejectedSide([gym], 'growth')).toBe(1); // "you said health, growth; the user chose leisure", shown to a growth title
    expect(ownOnRejectedSide([gym], 'leisure')).toBe(0); // chosen side: placeboLessons drops it before it counts
    expect(ownOnRejectedSide([gym], null)).toBe(0);
    expect(ownOnRejectedSide([{ ...gym, llmValue: 'growth-ish' }], 'growth')).toBe(0); // whole names, as namesValue reads them
    expect(ownOnRejectedSide([gym, { ...gym, logId: 'h', llmValue: 'health' }], 'growth')).toBe(1);
    // And the filter does let it through, which is the limitation the header states.
    const got = placeboLessons([gym, ...pool.filter((e) => e.correctValue === 'career')], 'growth', bBlock.slice(0, 2), 'Silent sitting meditation');
    expect(got.some((e) => e.logId === 'g')).toBe(true);
    expect(ownOnRejectedSide(got, 'growth')).toBe(1);
  });

  it('the placebo copes with a short pool, no lessons to match, and a stored pick that names the own value among others', () => {
    expect(placeboLessons(pool, 'leisure', [], 't')).toEqual([]);
    const few = pool.filter((e) => e.correctValue !== 'career' && !bBlock.includes(e)).slice(0, 2); // only leisure and growth rows left
    expect(placeboLessons(few, 'leisure', bBlock, 't').every((e) => e.correctValue === 'growth')).toBe(true);
    expect(placeboLessons([], 'leisure', bBlock, 't')).toEqual([]);
    const mixed: Exemplar[] = [{ logId: 'm1', inputText: 'x', llmValue: 'y', correctValue: 'health, leisure' }, ...pool.filter((e) => e.correctValue === 'career')];
    expect(placeboLessons(mixed, 'leisure', bBlock.slice(0, 2), 't').some((e) => e.logId === 'm1')).toBe(false);
    expect(namesValue('Health, Leisure', 'leisure')).toBe(true);
    expect(namesValue('leisure-ish', 'leisure')).toBe(false);
    expect(namesValue('health,-fitness', 'health')).toBe(false);
  });

  it("the placebo's pool is the owner's own index, through the same filter the route applies", () => {
    resetDb();
    try {
      const insert = sqlite.prepare(
        `INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '2026-11-02')`,
      );
      insert.run(OWNER, 'category', 'l1', 'Gym session', 'health', 'leisure');
      insert.run(OWNER, 'category', 'l2', 'Invoice the client', 'finance', 'career, finance');
      insert.run(OWNER, 'category', 'l3', 'Old habit', 'health', 'a-category-since-deleted'); // not answerable now: the route drops it too
      insert.run(OWNER, 'motivation', 'l4', 'Help mum', 'me', 'them'); // another field
      createOwner(SECOND_OWNER_ID);
      insert.run(SECOND_OWNER_ID, 'category', 'l5', 'Someone else', 'health', 'leisure'); // another owner
      const got = indexExemplars(OWNER, { categories: CATEGORIES } as Vocab);
      expect(got.map((e) => e.logId)).toEqual(['l1', 'l2']);
      expect(got[1]).toEqual({ logId: 'l2', inputText: 'Invoice the client', llmValue: 'finance', correctValue: 'career, finance' });
    } finally {
      resetDb();
    }
  });

  it('the placebo reading is a count and a sentence, never a registered verdict word', () => {
    expect(placeboReading({ n: 0, wins: 0, losses: 0, net: 0 }, 0)).toMatch(/did not run/);
    expect(placeboReading({ n: 12, wins: 3, losses: 1, net: 2 }, 0)).toMatch(/^B is ahead of P \(3 titles where B is right and P wrong, 1 the other way\)/);
    expect(placeboReading({ n: 5, wins: 1, losses: 0, net: 1 }, 0)).toMatch(/^B is ahead of P/); // 20 points at n = 5, the smallest n that reads as a lead
    expect(placeboReading({ n: 12, wins: 1, losses: 0, net: 1 }, 0)).toMatch(/within one title of each other/);
    expect(placeboReading({ n: 12, wins: 0, losses: 3, net: -3 }, 0)).toMatch(/^P is ahead of B/);
    for (const [c, short] of [[{ n: 12, wins: 3, losses: 1, net: 2 }, 0], [{ n: 12, wins: 1, losses: 0, net: 1 }, 0], [{ n: 12, wins: 0, losses: 3, net: -3 }, 0],
      [{ n: 4, wins: 1, losses: 0, net: 1 }, 2], [{ n: 12, wins: 3, losses: 1, net: 2 }, 1]] as const) {
      expect(placeboReading(c, short)).not.toMatch(/IMPROVED|HARMED|NO MEASURABLE CHANGE|INCONCLUSIVE/);
    }
  });

  it('"B is ahead of P" is not said when a P block was shorter than B\'s or P ran on fewer than 5 titles', () => {
    expect(DIAGNOSTICS.placeboMinTitles).toBe(5); // 100 / G1's 20 points
    // Too few titles: one title is 25 points at n = 4. Still a count, worded as one.
    const few = placeboReading({ n: 4, wins: 1, losses: 0, net: 1 }, 0);
    expect(few).not.toMatch(/ahead of P/);
    expect(few).toMatch(/^B leads P on the count \(1 titles where B is right and P wrong, 0 the other way\)/);
    expect(few).toContain('P ran on only 4 scored targets, where one title is 25 points');
    expect(placeboReading({ n: 1, wins: 1, losses: 0, net: 1 }, 0)).toContain('P ran on only 1 scored target, where one title is 100 points');
    // A shorter P block: the placebo is the weaker stand-in, even on 12 titles.
    const short = placeboReading({ n: 12, wins: 3, losses: 1, net: 2 }, 19);
    expect(short).not.toMatch(/ahead of P/);
    expect(short).toContain("P's block showed fewer lessons than B's on 19 titles");
    expect(short).not.toContain('P ran on only');
    expect(placeboReading({ n: 12, wins: 3, losses: 1, net: 2 }, 1)).toContain("fewer lessons than B's on 1 title,");
    // Both at once say both.
    const both = placeboReading({ n: 4, wins: 2, losses: 0, net: 2 }, 3);
    expect(both).toContain('P ran on only 4');
    expect(both).toContain('; and P\'s block showed fewer lessons');
    // The other two readings are conservative already and do not move.
    expect(placeboReading({ n: 12, wins: 1, losses: 0, net: 1 }, 19)).toMatch(/within one title of each other/);
    expect(placeboReading({ n: 3, wins: 0, losses: 2, net: -2 }, 3)).toMatch(/^P is ahead of B/);
  });

  it('the placebo report compares P with A and B with P over the titles P ran on only', () => {
    const before = records.length;
    try {
      const add = (arm: Arm, title: string, shape: string) => records.push(...rows(arm, title, shape, { model: 'pm' }));
      add('A', 'win', 'FFFFF'); add('B', 'win', 'TTTTT'); add('P', 'win', 'FFFFF'); // B right where P wrong
      add('A', 'same', 'FFFFF'); add('B', 'same', 'TTTTT'); add('P', 'same', 'TTTTT'); // the block alone does it
      // P had no lessons: not counted against B. Its A rows are bare strings, so A's array share differs between "all titles" and "P's titles".
      records.push(...rows('A', 'skipped', 'FFFFF', { model: 'pm', categoriesType: 'string' })); add('B', 'skipped', 'TTTTT');
      const meta = (title: string, pLessons: number, pChars: number, rejected = 0): PlaceboMeta =>
        ({ title, own: 'leisure', bLessons: 3, pLessons, bChars: 200, pChars, values: [], logIds: [], ownOnRejectedSide: rejected });
      const metas: PlaceboMeta[] = [meta('win', 3, 205), meta('same', 2, 190, 1), meta('skipped', 0, 0)];
      const r = placeboReport('pm', metas, ['win', 'same', 'skipped'], []);
      expect(r.ran).toBe(true);
      expect(r.targets.bVsP).toMatchObject({ n: 2, baseCorrect: 1, treatCorrect: 2, wins: 1, losses: 0 });
      expect(r.targets.vsA).toMatchObject({ n: 2, baseCorrect: 0, treatCorrect: 1 });
      expect(r.short).toEqual(['same']); // 'same' has 2 lessons against B's 3; 'skipped' has none and is not "short", it did not run
      expect(r.notRun).toEqual(['skipped']);
      expect(r.of).toEqual({ targets: 3, controls: 0 });
      expect(r.ranOn).toEqual({ targets: 2, controls: 0 });
      expect(r.ownOnRejectedSide).toEqual(['same']);
      expect(r.lengthDelta).toEqual({ meanAbs: 7.5, maxAbs: 10 });
      expect(r.titles.map((m) => m.title)).toEqual(['win', 'same']);
      // A, B and P are cut to the titles P ran on: A is 100% arrays there, 66.7% over all three titles.
      expect(r.sameTitles.A.shape).toMatchObject({ n: 10, array: 10, arrayPct: 100 });
      expect(r.sameTitles.B.shape).toMatchObject({ n: 10 });
      expect(r.sameTitles.P.shape).toMatchObject({ n: 10 });
      expect(r.shape).toEqual(r.sameTitles.P.shape);
      expect(armShape(records, 'pm', 'A', ['win', 'same', 'skipped'], [])!.shape).toMatchObject({ n: 15, array: 10 });
      // 1 of 2 titles was short, so even a clear lead would not be worded as "ahead of P" (it is not a lead here: n = 2).
      expect(r.reading).not.toMatch(/ahead of P/);
      expect(placeboReport('no such model', [], [], []).ran).toBe(false);
    } finally {
      records.length = before;
    }
  });

  it('a placebo that ran on all of 5 titles with every block as long as B\'s is "ahead of P" only then', () => {
    const before = records.length;
    try {
      const titles = ['q1', 'q2', 'q3', 'q4', 'q5'];
      for (const t of titles) {
        records.push(...rows('A', t, 'FFFFF', { model: 'cm' }), ...rows('B', t, 'TTTTT', { model: 'cm' }), ...rows('P', t, 'FFFFF', { model: 'cm' }));
      }
      const metas = (pLessons: number): PlaceboMeta[] => titles.map((title) => ({
        title, own: 'leisure', bLessons: 3, pLessons, bChars: 200, pChars: 200, values: [], logIds: [], ownOnRejectedSide: 0,
      }));
      expect(placeboReport('cm', metas(3), titles, []).reading).toMatch(/^B is ahead of P \(5 titles where B is right and P wrong/);
      const weaker = placeboReport('cm', metas(2), titles, []);
      expect(weaker.short).toHaveLength(5);
      expect(weaker.reading).not.toMatch(/ahead of P/);
      expect(weaker.reading).toContain("fewer lessons than B's on 5 titles");
      // Four titles: the same 100% lead on a set too small to read.
      expect(placeboReport('cm', metas(3).slice(0, 4), titles.slice(0, 4), []).reading).not.toMatch(/ahead of P/);
    } finally {
      records.length = before;
    }
  });

  it("a summary row for an arm that ran on some titles is out of those titles, and says so", () => {
    const before = records.length;
    try {
      const scored = ['t1', 't2', 't3', 't4'];
      const controls = ['c1', 'c2'];
      for (const t of [...scored, ...controls]) records.push(...rows('A', t, 'FFFFF', { model: 'am' }), ...rows('B', t, 'TTTTT', { model: 'am' }));
      // P ran on t1, t2 and c1 only, and was right on every title it ran on.
      for (const t of ['t1', 't2', 'c1']) records.push(...rows('P', t, 'TTTTT', { model: 'am' }));
      const p = armLine('am', 'P', scored, controls)!;
      expect(p).toMatchObject({ arm: 'P', calls: 15, targets: '2/2', controls: '1/1', targetsRan: 2, targetsOf: 4, controlsRan: 1, controlsOf: 2, partial: true });
      // An arm that ran on every title is out of all of them, as before.
      expect(armLine('am', 'A', scored, controls)).toMatchObject({ targets: '0/4', controls: '0/2', targetsRan: 4, controlsRan: 2, partial: false });
      expect(armLine('am', 'B', scored, controls)).toMatchObject({ targets: '4/4', controls: '2/2', partial: false });
      expect(armLine('am', 'C', scored, controls)).toBeNull(); // never ran: no row, not 0/4
      // A0 is read over all the targets and no controls.
      expect(armLine('am', 'A', scored, [])).toMatchObject({ controls: '0/0', partial: false });
    } finally {
      records.length = before;
    }
  });

  it('a baseline of bare strings reads as an unusable shape, not as no headroom, in every place the report says so', () => {
    const before = records.length;
    try {
      const M = 'shape-model';
      const targets = ['t1', 't2', 't3', 't4'];
      const controls = ['c1', 'c2', 'c3', 'c4'];
      const str = { categoriesType: 'string' as const, pick: null, correct: false, lenientPick: 'leisure', lenientCorrect: true };
      const arr = { categoriesType: 'array' as const };
      const put = (arm: Arm, titles: readonly string[], shape: string, over: Partial<CallRecord> = {}) => {
        for (const t of titles) records.push(...rows(arm, t, shape, { model: M, kind: t.startsWith('c') ? 'control' : 'target', ...over }));
      };
      // qwen2.5:0.5b-like baseline: every answer a bare string. Hinted arms answer arrays and get some right.
      put('A0', targets, 'FFFFF', str);
      put('A', targets, 'FFFFF', str); put('A2', targets, 'FFFFF', str);
      put('A', controls.slice(0, 2), 'TTTTT', arr); put('A', controls.slice(2), 'FFFFF', str);
      put('B', targets, 'TTTTT', arr); put('B', controls, 'TTTTT', arr);
      put('P', targets, 'TTTTT', arr); put('P', controls, 'TTTTT', arr);
      const a0 = shapeStats(armCalls(records, M, 'A0'));
      expect(a0).toMatchObject({ n: 20, array: 0, string: 20, arrayPct: 0 });
      expect(stoppedStatus(a0)).toBe('INCONCLUSIVE: UNUSABLE ANSWER SHAPE');
      expect(lenientMajority(records, M, 'A0', targets)).toBe(4); // what the model meant: 4 of 4, not 0

      const b = evaluateTreatment(records, M, 'B', targets, controls);
      const report = {
        model: M, gating: true, status: 'ran', note: '', baseline: [],
        baselineShape: { a0, unusable: shapeUnusable(a0), strictTargets: 0, lenientTargets: 4 },
        shapes: Object.fromEntries((['A0', 'A', 'A2', 'B', 'P'] as Arm[]).map((arm) => [arm, armShape(records, M, arm, targets, controls)!])),
        baselineKeys: keyCoverage(armCalls(records, M, 'A'), WIDE_KEYS),
        placebo: placeboReport(M, targets.concat(controls).map((title) => ({ title, own: null, bLessons: 3, pLessons: 3, bChars: 300, pChars: 296, values: [], logIds: [], ownOnRejectedSide: 0 })), targets, controls),
        capture: null, index: null, hintChars: null, retrieval: {}, evaluations: [b], summary: [], flips: [], narrow: null,
        latency: null, residency: null, g4: { checked: 1, bad: 0 }, reading: [],
      } as ModelReport;

      const shape = renderShape(report).join('\n');
      expect(shape).toContain('constrainToVocabulary');
      expect(shape).toMatch(/^P +40 +100\.0 /m);
      expect(shape).toMatch(/^A0 +20 +0\.0 +20 /m);
      // The direction block sits with the table: these completions are '{}', so none names a direction and every one asks again.
      expect(shape).toContain('Direction, the first-pass "direction" read as enrichQuick reads it (work, home, community; constrainOne)');
      expect(shape).toMatch(/^P +40 +0\.0 +100\.0$/m);
      expect(shape).toMatch(/^A0 +20 +0\.0 +100\.0$/m);
      const placeboText = renderPlacebo(report).join('\n');
      expect(placeboText).toContain('Placebo P (diagnostic, not a gate)');
      expect(placeboText).toContain('within one title of each other'); // B and P both right: the block alone does it
      const evalText = renderEval(b).join('\n');
      expect(evalText).toContain('G2 can only flip 2 controls'); // only c1 and c2 were right at baseline
      expect(evalText).toContain('NOT POWERED: G2');
      expect(evalText).toContain('G3 baseline: every requested key');
      const reading = readOff(report).join('\n');
      expect(reading).toContain('INCONCLUSIVE: UNUSABLE ANSWER SHAPE');
      expect(reading).toContain('P moved it the same way');
      expect(reading).toContain('Over the 8 titles P ran on'); // the P clause names the set its three shares are over
      expect(reading).toContain('Direction (share of completions whose "direction" names one of the owner\'s directions');
      expect(reading).toContain('Direction over the 8 titles P ran on: A 0.0% valid, 100.0% second call; B 0.0% valid, 100.0% second call; P 0.0% valid, 100.0% second call.');
      expect(reading).toContain('Placebo (P ran on 4 of 4 scored targets and 4 of 4 controls): B and P are within one title');
      const verdict = verdictLine(report);
      expect(verdict).toContain('INCONCLUSIVE: UNUSABLE ANSWER SHAPE (baseline A0 array 0.0%)');
      expect(verdict).toContain('NOT POWERED: G2');
      expect(verdict).toContain('B vs P +0 of 4 titles (P ran on 4 of 4 scored targets)'); // n and P's coverage ride along, no short blocks here
      // The registered verdicts are still the registered ones: B beats A by 4 titles, whatever the shape.
      expect(b.g1.verdict).toBe('IMPROVED');

      // The whole printout renders from such a report, and carries the new blocks.
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      let printed = '';
      try {
        report.reading = readOff(report);
        printReport(report);
        printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      } finally {
        log.mockRestore();
      }
      expect(printed).toContain('Answer shape, the JSON type of "categories"');
      expect(printed).toContain('Direction, the first-pass "direction"');
      expect(printed).toContain('P ran on 8 of 8 titles'); // the placebo block says how many titles it ran on
      expect(printed).toContain('Placebo P (diagnostic, not a gate)');
      expect(printed).toContain('G2 can only flip 2 controls');
      expect(printed).toContain('NOT POWERED: G2');
      expect(printed).toContain('Reading the pre-registered rule:');
    } finally {
      records.length = before;
    }
  });

  it('a placebo that ran on some titles is reported over those titles in the table, the block, the reading and the verdict line', () => {
    const before = records.length;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const M = 'partial-model';
      const targets = ['t1', 't2', 't3', 't4', 't5', 't6'];
      const controls = ['c1', 'c2', 'c3'];
      const named = '{"direction":"home"}';
      const put = (arm: Arm, titles: readonly string[], shape: string) => {
        for (const t of titles) records.push(...rows(arm, t, shape, { model: M, kind: t.startsWith('c') ? 'control' : 'target', raw: named }));
      };
      put('A', [...targets, ...controls], 'FFFFF'); put('A2', targets, 'FFFFF');
      put('B', [...targets, ...controls], 'TTTTT');
      put('P', ['t1', 't2', 't3', 't4', 't5', 'c1', 'c2'], 'FFFFF'); // P was built for 5 of 6 targets and 2 of 3 controls
      const metas = (shortOnT1: boolean): PlaceboMeta[] => [...targets, ...controls].map((title) => {
        const built = title !== 't6' && title !== 'c3';
        return {
          title, own: null, bLessons: 3, pLessons: !built ? 0 : shortOnT1 && title === 't1' ? 2 : 3, bChars: 300, pChars: built ? 296 : 0,
          values: [], logIds: [], ownOnRejectedSide: title === 't2' ? 1 : 0,
        };
      });
      const build = (shortOnT1: boolean): ModelReport => ({
        model: M, gating: true, status: 'ran', note: '', baseline: [], baselineShape: null, baselineKeys: null,
        shapes: Object.fromEntries((['A', 'A2', 'B', 'P'] as Arm[]).map((arm) => [arm, armShape(records, M, arm, targets, controls)!])),
        placebo: placeboReport(M, metas(shortOnT1), targets, controls),
        summary: (['A', 'A2', 'B', 'P'] as Arm[]).map((arm) => armLine(M, arm, targets, controls)!),
        capture: null, index: null, hintChars: null, retrieval: {}, evaluations: [evaluateTreatment(records, M, 'B', targets, controls)],
        flips: [], narrow: null, latency: null, residency: null, g4: { checked: 1, bad: 0 }, reading: [],
      } as ModelReport);

      const clean = build(false);
      // The summary row: P is out of the titles it ran on, A and B (which ran on all of them) are as before.
      expect(clean.summary.map((r) => [r.arm, r.targets, r.controls])).toEqual([['A', '0/6', '0/3'], ['A2', '0/6', '0/0'], ['B', '6/6', '3/3'], ['P', '0/5', '0/2']]);
      // The placebo block: counts, the like-for-like shares and the lead, worded as a lead only because nothing is short.
      expect(clean.placebo).toMatchObject({
        ran: true, of: { targets: 6, controls: 3 }, ranOn: { targets: 5, controls: 2 }, short: [], notRun: ['t6', 'c3'], ownOnRejectedSide: ['t2'],
      });
      expect(clean.placebo!.reading).toMatch(/^B is ahead of P \(5 titles where B is right and P wrong, 0 the other way\)/);
      const block = renderPlacebo(clean).join('\n');
      expect(block).toContain('P ran on 7 of 9 titles (no block could be built for the other 2); its block matched B\'s lesson count on every one; '
        + 'on 1 a lesson names the title\'s own value on the "you said" side');
      expect(block).toContain('scored targets (P ran on 5 of 6): A 0 -> P 0 of 5 titles');
      expect(block).toContain('controls (P ran on 2 of 3): A 0 -> P 0 of 2 titles');
      expect(block).toContain('Over those 7 titles, A and B cut to them');
      // The reading and the verdict line carry n and P's coverage.
      const reading = readOff(clean).join('\n');
      expect(reading).toContain('Placebo (P ran on 5 of 6 scored targets and 2 of 3 controls): B is ahead of P');
      expect(verdictLine(clean)).toContain('B vs P +5 of 5 titles (P ran on 5 of 6 scored targets)');
      // The printed table says its P figures are out of the titles it ran on.
      clean.reading = readOff(clean);
      printReport(clean);
      const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toMatch(/^P +0\/5 +0\/2 /m);
      expect(printed).toMatch(/^B +6\/6 +3\/3 /m);
      expect(printed).toContain('P ran on 5 of 6 scored targets and 2 of 3 controls: its targets and controls figures are out of those titles, and a title it never ran on is absent, not counted as a miss.');
      expect(printed).toContain('(P ran on 7 of 9 titles, so its row covers fewer calls and titles than the others;');
      expect(printed).not.toMatch(/^P +0\/6/m);

      // One P block shorter than B's: the same 5-title lead is a count, no longer "ahead of P".
      const weaker = build(true);
      expect(weaker.placebo!.short).toEqual(['t1']);
      expect(weaker.placebo!.reading).not.toMatch(/ahead of P/);
      expect(weaker.placebo!.reading).toContain("fewer lessons than B's on 1 title");
      expect(readOff(weaker).join('\n')).toContain("its block showed fewer lessons than B's on 1 title): B leads P on the count");
      expect(verdictLine(weaker)).toContain("(P ran on 5 of 6 scored targets; P's block short of B's lesson count on 1 title)");
      expect(renderPlacebo(weaker).join('\n')).toContain("on 1 of them its block showed fewer lessons than B's");
    } finally {
      log.mockRestore();
      records.length = before;
    }
  });

  it('the ship-rule reading points at the doc section whenever it is not "may ship", and only then', () => {
    const before = records.length;
    try {
      const M = 'ship-model';
      const scored = ['t1', 't2'];
      const controls = ['c1', 'c2'];
      const put = (arm: Arm, title: string, shape: string) =>
        records.push(...rows(arm, title, shape, { model: M, kind: title.startsWith('c') ? 'control' : 'target' }));
      for (const t of scored) { put('A', t, 'FFFFF'); put('A2', t, 'FFFFF'); put('B', t, 'TTTTT'); }
      for (const c of controls) { put('A', c, 'TTTTT'); put('B', c, 'TTTTT'); }
      const g6 = (pass: boolean) => ({ gateG6: { withP50: 1, withP95: 1, withoutP95: 1, pass, n: 30 } }) as unknown as LatencyReport;
      const build = (over: Partial<ModelReport>): ModelReport => ({
        model: M, gating: true, status: 'ran', note: '', baseline: [], baselineShape: null, baselineKeys: null, placebo: null,
        shapes: Object.fromEntries((['A', 'B'] as Arm[]).map((arm) => [arm, armShape(records, M, arm, scored, controls)!])),
        capture: null, index: null, hintChars: null, retrieval: {}, evaluations: [evaluateTreatment(records, M, 'B', scored, controls)],
        summary: [], flips: [], narrow: null, latency: g6(true), residency: null, g4: { checked: 1, bad: 0 }, reading: [], ...over,
      } as ModelReport);
      const POINTER = 'docs/classification-hint-measurement-2026-11.md, section Ship decision';

      // Every gate the rule names holds: the rule and the shipped state agree, nothing to point at.
      const ready = readOff(build({})).join('\n');
      expect(ready).toContain('the hint half may ship');
      expect(ready).not.toContain(POINTER);
      // A gate does not hold (here G6 was not measured, or G4 failed): the rule's own line, then the departure and where it is written down.
      for (const over of [{ latency: null }, { latency: g6(false) }, { g4: { checked: 1, bad: 1 } }]) {
        const lines = readOff(build(over));
        const at = lines.findIndex((l) => l.includes('capture ships, the hint half does not by default'));
        expect(at, JSON.stringify(over)).toBeGreaterThanOrEqual(0);
        expect(lines[at + 1]).toContain(POINTER);
        expect(lines[at + 1]).toContain('departs from the rule');
        expect(lines[at + 1]).toContain('the small tiers');
      }
      // Not the fast tier: the gates do not apply and the ship line is not printed at all.
      expect(readOff(build({ gating: false })).join('\n')).not.toContain(POINTER);
    } finally {
      records.length = before;
    }
  });

  it('the registered gates, the ship rule and the thresholds are as registered, and the header says where the shipped state departs from them', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const header = src.slice(0, src.indexOf('\nimport { describe'));
    const between = (from: string, to: string): string => header.slice(header.indexOf(from), header.indexOf(to, header.indexOf(from)) + to.length);
    const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
    // Hashes of the two blocks as committed at c2248bc1 (the gates as registered; the ship rule up to its last sentence). A dated note goes
    // UNDER them; an edit of them changes the hash and fails here.
    expect(sha16(between('PRE-REGISTERED GATES (fast tier only)', '(plus INCONCLUSIVE: NOISE for the A-versus-A2 rule above).'))).toBe('c3c7db769c16e180');
    expect(sha16(between('DECISION RULE (the ship rule, restated', 'C is only there to show whether it still\n * does.'))).toBe('0d9a55dd4806e8ec');
    expect(GATES).toEqual({
      headroomCeiling: 0.75, g1MinPoints: 20, g1MinNet: 2, noiseFlipsMax: 2, g2MaxFlips: 1, g3MaxDropPoints: 5,
      hintReadMs: { withP50: 20, withP95: 60, withoutP95: 5 }, reloadFactor: 3,
    });
    // The prose that was wrong, in one line each: what a run costs on the tier that yields no pick, and the departure from the rule.
    const prose = header.replace(/\n \*/g, ' ').replace(/\s+/g, ' ');
    expect(prose).toContain('60 when the tier yields no pick');
    expect(prose).toContain('660 to 1,020 otherwise');
    expect(prose).toContain('the state that ships departs from this rule on the small tiers');
    expect(prose).toContain('docs/classification-hint-measurement-2026-11.md, section Ship decision');
  });

  it('C is labelled the adjacent layout and a diagnostic wherever it prints, and the rule reads B only', () => {
    const before = records.length;
    try {
      const M = 'layout-model';
      const scored = ['t1', 't2'];
      const controls = ['c1', 'c2'];
      const put = (arm: Arm, title: string, shape: string) =>
        records.push(...rows(arm, title, shape, { model: M, kind: title.startsWith('c') ? 'control' : 'target' }));
      for (const t of scored) { put('A', t, 'FFFFF'); put('A2', t, 'FFFFF'); put('B', t, 'TTTTT'); put('C', t, 'TTTTT'); }
      for (const c of controls) { put('A', c, 'TTTTT'); put('B', c, 'TTTTT'); put('C', c, 'FFFFF'); } // the adjacent layout flips both controls
      const [b, c] = (['B', 'C'] as Arm[]).map((arm) => evaluateTreatment(records, M, arm, scored, controls));
      expect(renderEval(b)[0]).toBe('  B vs A');
      expect(renderEval(c)[0]).toBe('  C vs A (diagnostic, not a gate: the adjacent layout, which is not the shipped one)');
      const report = {
        model: M, gating: true, status: 'ran', note: '', baseline: [], baselineShape: null, baselineKeys: null, placebo: null,
        shapes: Object.fromEntries((['A', 'B', 'C'] as Arm[]).map((arm) => [arm, armShape(records, M, arm, scored, controls)!])),
        capture: null, index: null, hintChars: null, retrieval: {}, evaluations: [b, c], summary: [], flips: [], narrow: null,
        latency: null, residency: null, g4: { checked: 1, bad: 0 }, reading: [],
      } as ModelReport;
      const reading = readOff(report).join('\n');
      expect(reading).toContain('Diagnostic, not part of the rule (C is the adjacent layout, the one B had in the first three runs): C: G1 IMPROVED (+2 titles net), G2 FAIL, G3 pass.');
      expect(reading).toContain('B passes G1, G2 and G3.'); // C's G2 FAIL does not enter the rule
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      let printed = '';
      try {
        report.reading = readOff(report);
        printReport(report);
        printed = log.mock.calls.map((x) => String(x[0])).join('\n');
      } finally {
        log.mockRestore();
      }
      expect(printed).toContain('Layouts: B, S, B1 and P put the hint blocks last');
      expect(printed).toContain('C is the adjacent layout');
      expect(printed).toContain('C vs A (diagnostic, not a gate');
    } finally {
      records.length = before;
    }
  });

  it('provenance: only OLLAMA_* is read, credentials are redacted, and the command is the starter argv', () => {
    const env = {
      OLLAMA_FAST: 'gemma3n:e4b', OLLAMA_URL: 'http://user:pw@host:11434', OLLAMA_API_KEY: 'sekret', OLLAMA_MAX_LOADED_MODELS: '2',
      PATH: '/bin', HOME: '/home/x', LIVE_HINT: '1', LIVE_HINT_RUNS: '5',
    };
    expect(envWithPrefix(env, 'OLLAMA_')).toEqual({
      OLLAMA_API_KEY: '[redacted]', OLLAMA_FAST: 'gemma3n:e4b', OLLAMA_MAX_LOADED_MODELS: '2', OLLAMA_URL: 'http://[redacted]@host:11434',
    });
    expect(Object.keys(envWithPrefix(env, 'LIVE_HINT'))).toEqual(['LIVE_HINT', 'LIVE_HINT_RUNS']);
    expect(redactUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(redactUrl('https://tok@example.com/x')).toBe('https://[redacted]@example.com/x');

    const worker = ['/usr/bin/node', '/x/node_modules/vitest/dist/workers/forks.js'];
    const parent = ['node', './node_modules/.bin/../vitest/vitest.mjs', 'run', 'test/a.test.ts', '-t', 'pure helpers'];
    expect(pickCommand(worker, parent)).toMatchObject({ source: 'parent process (/proc cmdline)', command: 'node ./node_modules/.bin/../vitest/vitest.mjs run test/a.test.ts -t "pure helpers"' });
    expect(pickCommand(worker, null).source).toBe('this process (process.argv)');
    expect(pickCommand(worker, ['bash', '-c', 'x']).argv).toEqual(worker); // a parent that is not vitest is not the starter
  });

  it('provenance: the gating tier note says when a pin, not the box default, set it', () => {
    const base = { registeredDefault: 'qwen2.5:0.5b' };
    const pinned = gatingTierNote({ ...base, resolved: { name: 'gemma3n:e4b', source: 'pin' }, pinned: true, pinVar: 'OLLAMA_FAST' });
    expect(pinned).toContain('set by OLLAMA_FAST');
    expect(pinned).toContain('NOT by the box default');
    expect(pinned).toContain('qwen2.5:0.5b');
    expect(gatingTierNote({ ...base, resolved: { name: 'qwen2.5:0.5b', source: 'pin' }, pinned: true, pinVar: 'OLLAMA_SMALL' })).toContain('also the box default');
    expect(gatingTierNote({ ...base, resolved: { name: 'qwen2.5:0.5b', source: 'default' }, pinned: false, pinVar: null })).toContain('is the box default');
    expect(gatingTierNote({ ...base, resolved: { name: 'gemma3n:e4b', source: 'auto' }, pinned: false, pinVar: null })).toContain("'auto'");
    expect(gatingTierNote({ ...base, resolved: { name: 'gemma3:1b', source: 'override' }, pinned: false, pinVar: null })).toContain('Settings override');
    expect(fastPinVar(false, { OLLAMA_FAST: 'x' })).toBeNull();
    expect(fastPinVar(true, { OLLAMA_FAST: 'x' })).toBe('OLLAMA_FAST');
    expect(fastPinVar(true, { OLLAMA_SMALL: 'x' })).toBe('OLLAMA_SMALL');
  });

  it('provenance: the harness reads its own commit, the paths that differ from it and a hash of the sources, best effort', () => {
    const h = harnessProvenance();
    expect(h.commit === null || /^[0-9a-f]{40}$/.test(h.commit)).toBe(true);
    expect(h.differingFromCommit === null || Array.isArray(h.differingFromCommit)).toBe(true);
    expect(h.sha256Prefix['test/classification-hint-live.test.ts']).toMatch(/^[0-9a-f]{12}$/);
    expect(h.sha256Prefix['src/routes/tasks.ts']).toMatch(/^[0-9a-f]{12}$/);
  });

  it('key coverage counts the share of completions carrying each key', () => {
    const c = (raw: string) => mk('A', 'x', 0, true, { raw });
    expect(keyCoverage([c('{"direction":"home","categories":"leisure"}'), c('{"direction":"work"}'), c('oops'), c('{"direction":"home","tags":[]}')], ['direction', 'categories', 'tags']))
      .toEqual({ direction: 75, categories: 25, tags: 25 });
  });

  it('the fixture is well formed against the real parser', () => {
    expect(fixtureProblems()).toEqual([]);
    expect(TRAIN_ITEMS).toHaveLength(18);
    expect(TARGET_ITEMS).toHaveLength(12);
    expect(CONTROL_ITEMS).toHaveLength(12);
  });

  it('the fixture has exactly RETRIEVE_K distinct owner values, as the header says it does', () => {
    // WHAT THIS DOES NOT SHOW rests on this: with as many owner values as the hint carries, the frequency
    // hint can be a complete convention table. If either number moves, the sentence there is stale.
    expect(new Set(CONVENTIONS.map((c) => c.owner)).size).toBe(RETRIEVE_K);
  });
});

// ── Live harness ──────────────────────────────────────────────────────────────

const say = (line = ''): void => {
  // eslint-disable-next-line no-console
  console.log(line);
};

let srv: TestServer;
const records: CallRecord[] = [];
const distinctPrompts = new Map<string, string>();
const violations: string[] = [];
const reports: ModelReport[] = [];
const startedAt = new Date().toISOString();
let ollamaVersion = '';
/** What this run was and ran on; filled in beforeAll, written into every artifact flush. */
let provenance: Record<string, unknown> = {};
let haveEmbedder = false;
const caps = new Map<string, string[]>();

const violate = (model: string, message: string): void => { violations.push(`[${model}] ${message}`); };

type Hints = { category: string; motivation: string };
type Vocab = TagVocabulary;

interface BaselineRow { convention: ConventionId; correct: number; n: number; headroom: boolean; perTitle: Record<string, string> }
interface CaptureStats {
  parsed: number;
  claims: number;
  noClaim: number;
  /** The claim named exactly the owner's value. */
  exact: number;
  /** The claim's first category was the owner's value. */
  firstMatch: number;
  /** The claim differed from the saved set: a row born closed, a correction. */
  corrections: number;
  /** The JSON type of "categories" in each training parse's raw completion (the route's own call). */
  shapes: Record<CategoriesType, number>;
}
interface Stat { p50: number; p95: number; max: number }
interface LatencyReport {
  gateG6: { withP50: number; withP95: number; withoutP95: number; pass: boolean; n: number };
  hintReadMs: Record<string, Stat>;
  routeWallMs: Record<string, Stat>;
  routeModelMs: Record<string, Stat>;
  medianDifferenceMs: number;
  split: Record<string, { hintReadMs: Stat; enrichQuickMs: Stat; embedMsWithinHint: Stat }>;
}
interface ResidencyReport {
  warmMedianGenerateMs: number;
  perArm: Record<string, {
    residentSets: Record<string, number>;
    slowerThanThreeTimesWarmMedian: number;
    of: number;
    slowest: { title: string; run: number; ms: number }[];
  }>;
  /** S calls whose embed ran into EMBED_TIMEOUT_MS, so retrieval fell back to the frequency path. */
  similarityEmbedTimeouts: number;
  twoModelsResident: {
    ran: boolean;
    why?: string;
    fast?: string;
    partner?: string;
    residentBefore?: string[];
    embedMs?: Stat;
    generateMs?: Stat;
    generateSlowerThanThreeTimesWarmMedian?: number;
    residentSetsSeen?: string[];
    steps?: { title: string; embedMs: number; generateMs: number; resident: string[] }[];
  };
}
/** Arm P's lessons for one title, against B's block for the same title. */
interface PlaceboMeta {
  title: string;
  /** The value the lessons must not carry. */
  own: string | null;
  bLessons: number;
  pLessons: number;
  bChars: number;
  pChars: number;
  values: string[];
  logIds: string[];
  /**
   * How many of P's lessons name `own` on the "you said" side. The filter that keeps `own` off
   * the "user chose" side does not look there, so this is the count of what it lets through.
   */
  ownOnRejectedSide: number;
}
type Comparison = ReturnType<typeof compareArms>;
/** The arms set beside P, each cut to the titles P ran on. */
const PLACEBO_COMPARED: readonly Arm[] = ['A', 'B', 'C', 'S', 'B1', 'P'];
interface PlaceboReport {
  ran: boolean;
  why?: string;
  /** Titles P ran on. */
  titles: PlaceboMeta[];
  /** The scored targets and the controls the report was asked about, and how many of each P ran on. Every P figure is out of the second. */
  of: { targets: number; controls: number };
  ranOn: { targets: number; controls: number };
  /** Titles P ran on whose block showed fewer lessons than B's (too few lessons about other values to match its count). */
  short: string[];
  /** Titles P did not run on: no block could be built, so there is nothing to compare there. */
  notRun: string[];
  /** Titles P ran on whose block names the title's own value on the "you said" side. */
  ownOnRejectedSide: string[];
  lengthDelta: { meanAbs: number; maxAbs: number };
  /** P's answer shape; the same calls as sameTitles.P, which has the rest. */
  shape: ShapeStats;
  /**
   * Every arm in PLACEBO_COMPARED that ran, cut to the titles P ran on: shape, accuracy and
   * direction over the same set, which is the only set P can be set beside.
   */
  sameTitles: Record<string, ArmShape>;
  /** P against A: the format effect on its own. B against P: base = P, so a win is a title where B is right and P wrong. */
  targets: { vsA: Comparison; bVsP: Comparison };
  controls: { vsA: Comparison; bVsP: Comparison };
  reading: string;
}
interface ModelReport {
  model: string;
  gating: boolean;
  status: 'ran' | StoppedStatus;
  note: string;
  baseline: BaselineRow[];
  /** The JSON type of "categories" over all the A0 completions, and whether it is mostly not an array. */
  baselineShape: { a0: ShapeStats; unusable: boolean; lenientTargets: number; strictTargets: number } | null;
  /** Per arm: answer shape and accuracy among array answers, on the scored targets and on the controls. */
  shapes: Record<string, ArmShape>;
  /** Share of A's completions carrying each requested key. */
  baselineKeys: Record<string, number> | null;
  placebo: PlaceboReport | null;
  capture: CaptureStats | null;
  index: { corrections: number; indexed: number; heldOut: number; byValue: Record<string, number>; withVectors: number } | null;
  hintChars: { category: number; motivation: number } | null;
  retrieval: Record<string, { n: number; p1: number; pk: number }>;
  evaluations: TreatmentEval[];
  summary: Record<string, unknown>[];
  flips: Record<string, unknown>[];
  narrow: Record<string, unknown> | null;
  latency: LatencyReport | null;
  residency: ResidencyReport | null;
  /** G4: titles whose prompt was compared with the stock prompt, and how many differed. */
  g4: { checked: number; bad: number };
  reading: string[];
}

const realEmbed = (text: string): Promise<number[]> => embed(text, EMBED_TIMEOUT_MS);

/** What routes/tasks.ts enrichEntry fetches, argument for argument. */
async function prodHints(owner: string, vocab: Vocab, title: string, k?: number): Promise<Hints> {
  const input = classificationInput(title, null);
  const [category, motivation] = await Promise.all([
    vocab.categories.length
      ? classificationHint(owner, 'category', input, { embedFn: null, accept: choosable(vocab.categories), ...(k ? { k } : {}) })
      : '',
    classificationHint(owner, 'motivation', input, { embedFn: null, accept: choosable(MOTIVATION_VALUES), ...(k ? { k } : {}) }),
  ]);
  return { category, motivation };
}

/** The same two fields by similarity: the real embedder injected, so embedReady is never consulted. */
async function similarityHints(owner: string, vocab: Vocab, title: string, embedFn: (t: string) => Promise<number[]>): Promise<Hints> {
  const input = classificationInput(title, null);
  const [category, motivation] = await Promise.all([
    vocab.categories.length ? classificationHint(owner, 'category', input, { embedFn, accept: choosable(vocab.categories) }) : '',
    classificationHint(owner, 'motivation', input, { embedFn, accept: choosable(MOTIVATION_VALUES) }),
  ]);
  return { category, motivation };
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

function parseViaRoute(text: string, owner: string = OWNER) {
  return api(srv.url, '/api/tasks/quick/parse', {
    method: 'POST',
    json: { text },
    headers: owner === OWNER ? {} : { 'x-test-owner': owner },
  });
}

function seedVocabulary(owner: string): void {
  const insert = sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`);
  for (const name of DIRECTIONS) insert.run(name, owner, 'direction');
  for (const name of CATEGORIES) insert.run(name, owner, 'category');
  for (const name of OTHERS) insert.run(name, owner, 'intention');
}

/** A clean slate for one model: both owners, the same vocabulary, no tasks, no evidence. */
function resetWorld(): void {
  resetDb();
  createOwner(SECOND_OWNER_ID);
  seedVocabulary(OWNER);
  seedVocabulary(SECOND_OWNER_ID);
}

async function warm(model: string): Promise<void> {
  await generate('Reply with the single word: ok', { model, timeoutMs: 180_000, think: false });
}

async function residentModels(): Promise<string[]> {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/ps`);
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

const residency: Record<string, { calls: number; sets: Map<string, number> }> = {};
async function noteResidency(model: string, arm: Arm): Promise<void> {
  const key = (await residentModels()).join(' + ') || '(none)';
  const slot = (residency[`${model}|${arm}`] ??= { calls: 0, sets: new Map() });
  slot.calls++;
  slot.sets.set(key, (slot.sets.get(key) ?? 0) + 1);
}

function pickFromRaw(raw: string, vocab: Vocab): string | null {
  let obj: Record<string, unknown> | null = null;
  try { obj = parseJsonLoose<Record<string, unknown>>(raw); } catch { /* unparseable: no pick */ }
  return constrainToVocabulary(obj?.categories, vocab.categories, 3)[0] ?? null;
}

function toRecord(
  arm: Arm, model: string, item: FixtureItem, run: number, seam: SeamCall | undefined, vocab: Vocab,
  opts: { pick?: string | null; retrievalIds?: string[]; error?: string | null; narrow?: boolean; embedMs?: number | null } = {},
): CallRecord {
  const raw = seam?.raw ?? '';
  const prompt = seam?.prompt ?? '';
  let strict: Record<string, unknown> | null = null;
  try {
    const j: unknown = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) strict = j as Record<string, unknown>;
  } catch { /* not strict JSON */ }
  const keys: readonly string[] = opts.narrow ? NARROW_KEYS : WIDE_KEYS;
  const pick = opts.pick !== undefined ? opts.pick : pickFromRaw(raw, vocab);
  const lenientPick = lenientPickOf(raw, vocab.categories);
  const sha = sha12(prompt);
  if (prompt) distinctPrompts.set(sha, prompt);
  const r: CallRecord = {
    arm, model, title: item.title, kind: item.kind === 'control' ? 'control' : 'target',
    convention: item.convention, expected: item.expected, run,
    promptSha: sha, hintPresent: occurrences(prompt, HINT_MARKER) > 0, retrievalIds: opts.retrievalIds ?? [],
    raw, categoriesType: categoriesTypeOf(raw), pick, correct: pick !== null && pick.toLowerCase() === item.expected.toLowerCase(),
    lenientPick, lenientCorrect: lenientPick !== null && lenientPick.toLowerCase() === item.expected.toLowerCase(),
    validJson: strict !== null, allKeys: strict !== null && keys.every((k) => k in strict!),
    empty: raw.trim() === '', error: opts.error ?? seam?.error ?? null, ms: seam?.ms ?? NaN,
    embedMs: opts.embedMs ?? null,
  };
  records.push(r);
  return r;
}

/**
 * What is wrong with where the hints sit in the prompt that carries them, and with the prompt
 * around them; empty means nothing. 'last' is the shipped layout (B, S, B1, P): the blocks
 * follow the 'never invent.' line and nothing but the blocks stands between it and 'Entry:'.
 * 'adjacent' is arm C's (each block beside the field it governs, the layout of the old
 * enrichQuick). 'narrow' is the one-field question of N, where only the count is checked.
 */
function promptProblems(label: string, title: string, prompt: string, hints: Hints | null, layout: Layout): string[] {
  const problems: string[] = [];
  const markers = occurrences(prompt, HINT_MARKER);
  if (hints === null) {
    if (markers !== 0) problems.push(`${label}: a hint reached a prompt that must have none`);
    return problems;
  }
  const expected = (hints.category ? 1 : 0) + (hints.motivation ? 1 : 0);
  if (markers !== expected) problems.push(`${label}: ${markers} hint blocks in the prompt, expected ${expected}`);
  const rulesAt = prompt.indexOf(RULES_END);
  const entryAt = prompt.lastIndexOf(ENTRY_OPEN) + 1;
  for (const [field, hint] of [['motivation', hints.motivation], ['category', hints.category]] as const) {
    if (!hint) continue;
    if (occurrences(prompt, hint) !== 1) { problems.push(`${label}: the ${field} hint is not in the prompt exactly once`); continue; }
    const at = prompt.indexOf(hint);
    if (layout === 'adjacent') {
      const after = prompt.indexOf(field === 'category' ? '"categories":' : '"motivation":');
      const before = prompt.indexOf(field === 'category' ? '"tags":' : '"categories":');
      if (!(after >= 0 && after < at && at < before)) problems.push(`${label}: the ${field} hint is not beside its field`);
    } else if (layout === 'last') {
      if (!(rulesAt >= 0 && entryAt > 0 && at >= rulesAt + RULES_END.length && at + hint.length <= entryAt)) {
        problems.push(`${label}: the ${field} hint is not between the never-invent line and Entry:`);
      }
    }
  }
  if (layout === 'last') {
    if (rulesAt < 0 || entryAt <= 0) problems.push(`${label}: the prompt has no never-invent line or no Entry: line`);
    else {
      // The slot is the hint blocks and nothing else: no separator, no second line of rules.
      let between = prompt.slice(rulesAt + RULES_END.length, entryAt);
      for (const h of [hints.motivation, hints.category]) if (h) between = between.replace(h, '');
      if (between !== '') problems.push(`${label}: something besides the hint blocks stands between the never-invent line and Entry:`);
    }
  }
  if (layout !== 'narrow' && !prompt.endsWith(`Entry: "${title}"`)) problems.push(`${label}: the prompt does not end with the entry`);
  return problems;
}

function checkPrompt(
  model: string, arm: Arm, item: FixtureItem, prompt: string, hints: Hints | null, layout: Layout,
): void {
  for (const problem of promptProblems(`${arm} "${item.title}"`, item.title, prompt, hints, layout)) violate(model, problem);
}

// The retrieval each mode makes for a title is deterministic, so it is made once per title.
const retrievalCache = new Map<string, Exemplar[]>();
async function retrieveFor(mode: 'frequency' | 'similarity', title: string, vocab: Vocab, k = RETRIEVE_K): Promise<Exemplar[]> {
  const key = `${mode}|${k}|${title}`;
  let hit = retrievalCache.get(key);
  if (!hit) {
    hit = await retrieveExemplars(OWNER, 'category', classificationInput(title, null), {
      embedFn: mode === 'frequency' ? null : realEmbed, accept: choosable(vocab.categories), k,
    });
    retrievalCache.set(key, hit);
  }
  return hit;
}
const idsOf = (ex: readonly Exemplar[]): string[] => ex.map((e) => e.logId);

/**
 * Every lesson the owner's category index holds that the production filter would let through:
 * the pool arm P draws from. A plain read of the table calibrate wrote, as the harness already
 * does for the vector counts; the retrieval functions only ever return the top k of it.
 */
function indexExemplars(owner: string, vocab: Vocab): Exemplar[] {
  const rows = sqlite.prepare(
    `SELECT log_id, input_text, llm_value, correct_value FROM classification_exemplars WHERE owner_id = ? AND field = 'category' ORDER BY log_id`,
  ).all(owner) as { log_id: string; input_text: string; llm_value: string; correct_value: string }[];
  return rows
    .map((r) => ({ logId: r.log_id, inputText: r.input_text, llmValue: r.llm_value, correctValue: r.correct_value }))
    .filter(choosable(vocab.categories));
}

const stockPrompts = new Map<string, string>();

/**
 * G4, asserted rather than sampled: for every fixture title the prompt the route would send
 * is compared, in dry mode (no model call), with the prompt enrichQuick builds directly.
 * 'stock' = no hints expected (no index, another owner, after a reset); 'hinted' = the hints
 * enrichEntry's arguments produce, which must also come out again to leave the stock prompt.
 */
async function promptSweep(
  model: string, label: string, owner: string, expect_: 'stock' | 'hinted', vocab: Vocab,
): Promise<{ checked: number; bad: number }> {
  let checked = 0;
  const before = violations.length;
  for (const item of ITEMS) {
    const text = item.title;
    const viaRoute = await dryPrompt(() => parseViaRoute(text, owner));
    if (!viaRoute) { violate(model, `${label}: the route put no prompt in front of the model for "${text}"`); continue; }
    checked++;
    if (expect_ === 'stock') {
      const stock = await dryPrompt(() => enrichQuick(text, parseQuick(text), vocab));
      if (owner === OWNER && !stockPrompts.has(text)) stockPrompts.set(text, stock);
      if (viaRoute !== stock) violate(model, `${label}: "${text}" the route prompt is not the stock prompt`);
      if (occurrences(viaRoute, HINT_MARKER) !== 0) violate(model, `${label}: "${text}" carries a hint it must not`);
    } else {
      const hints = await prodHints(owner, vocab, text);
      const direct = await dryPrompt(() => enrichQuick(text, parseQuick(text), vocab, hints));
      if (viaRoute !== direct) violate(model, `${label}: "${text}" the route prompt differs from enrichQuick with the production hints`);
      checkPrompt(model, 'B', item, viaRoute, hints, 'last');
      const stock = stockPrompts.get(text);
      try {
        if (stock !== undefined && withoutHints(viaRoute, [hints.motivation, hints.category]) !== stock) {
          violate(model, `${label}: "${text}" taking the hints out does not give the stock prompt (not additive)`);
        }
      } catch (err) {
        violate(model, `${label}: "${text}" ${(err as Error).message}`);
      }
      // Arm C is built from this prompt in the live arms. Build it here, dry, so a layout the
      // builder cannot read stops the run before the arms spend model time on it.
      try {
        const adjacent = adjacentLayout(viaRoute, hints);
        checkPrompt(model, 'C', item, adjacent, hints, 'adjacent');
        if (stock !== undefined && withoutHints(adjacent, [hints.motivation, hints.category], 'adjacent') !== stock) {
          violate(model, `${label}: "${text}" the adjacent rebuild (arm C) does not give the stock prompt without its hints`);
        }
      } catch (err) {
        violate(model, `${label}: "${text}" arm C ${(err as Error).message}`);
      }
    }
  }
  return { checked, bad: violations.length - before };
}

interface Ctx { model: string; vocab: Vocab }

/** An arm that calls enrichQuick directly (A0, A, A2, S, B1). */
async function viaEnrich(
  arm: Arm, ctx: Ctx, item: FixtureItem, run: number, hints?: QuickHints,
  extra: { retrievalIds?: string[]; embedMs?: number | null } = {},
): Promise<{ record: CallRecord; prompt: string }> {
  const { calls, thrown } = await seamOf(() => enrichQuick(item.title, parseQuick(item.title), ctx.vocab, hints));
  const seam = calls.find((c) => !c.dry);
  const record = toRecord(arm, ctx.model, item, run, seam, ctx.vocab, { error: thrown ?? seam?.error ?? null, ...extra });
  await noteResidency(ctx.model, arm);
  return { record, prompt: seam?.prompt ?? '' };
}

/** B: the shipped route, end to end. The pick is what the route RETURNED, cross-checked against the raw completion. */
async function viaRoute(ctx: Ctx, item: FixtureItem, run: number, hints: Hints): Promise<{ record: CallRecord; prompt: string }> {
  const { value: res, thrown, calls } = await seamOf(() => parseViaRoute(item.title));
  const seam = calls.find((c) => !c.dry);
  const routePick = (res?.body?.parsed?.categories as string[] | undefined)?.[0] ?? null;
  if (res && res.status !== 200) violate(ctx.model, `B "${item.title}": the parse route answered ${res.status}`);
  if (seam && !seam.error && pickFromRaw(seam.raw, ctx.vocab) !== routePick) {
    violate(ctx.model, `B "${item.title}": the route returned ${routePick} but the raw completion says ${pickFromRaw(seam.raw, ctx.vocab)}`);
  }
  if (seam) {
    checkPrompt(ctx.model, 'B', item, seam.prompt, hints, 'last');
    // The route changed nothing but the hint: take it out and it is the prompt A sends.
    try {
      if (withoutHints(seam.prompt, [hints.motivation, hints.category]) !== stockPrompts.get(item.title)) {
        violate(ctx.model, `B "${item.title}": the route's prompt differs from the stock prompt by more than the hint`);
      }
    } catch (err) {
      violate(ctx.model, `B "${item.title}": ${(err as Error).message}`);
    }
  }
  const ids = idsOf(await retrieveFor('frequency', item.title, ctx.vocab));
  const record = toRecord('B', ctx.model, item, run, seam, ctx.vocab, { pick: routePick, retrievalIds: ids, error: thrown ?? seam?.error ?? null });
  await noteResidency(ctx.model, 'B');
  return { record, prompt: seam?.prompt ?? '' };
}

/**
 * C: B's own prompt with the hint blocks moved back beside their fields (the layout the hint
 * first shipped in), sent straight to the seam.
 */
async function viaAdjacent(ctx: Ctx, item: FixtureItem, run: number, bPrompt: string, hints: Hints): Promise<CallRecord | null> {
  if (!bPrompt) return null;
  let prompt: string;
  try {
    prompt = adjacentLayout(bPrompt, hints);
  } catch (err) {
    violate(ctx.model, `C "${item.title}": ${(err as Error).message}`);
    return null;
  }
  const { calls, thrown } = await seamOf(() => generateJson(prompt, { purpose: 'classify' }));
  const seam = calls.find((c) => !c.dry);
  if (seam) {
    checkPrompt(ctx.model, 'C', item, seam.prompt, hints, 'adjacent');
    // Moved, not changed: take the blocks out again (each with its extra newline) and it is the stock prompt.
    try {
      if (withoutHints(seam.prompt, [hints.motivation, hints.category], 'adjacent') !== stockPrompts.get(item.title)) {
        violate(ctx.model, `C "${item.title}": moving the hints beside their fields changed something else in the prompt`);
      }
    } catch (err) {
      violate(ctx.model, `C "${item.title}": ${(err as Error).message}`);
    }
  }
  const record = toRecord('C', ctx.model, item, run, seam, ctx.vocab, {
    error: thrown ?? seam?.error ?? null, retrievalIds: idsOf(await retrieveFor('frequency', item.title, ctx.vocab)),
  });
  await noteResidency(ctx.model, 'C');
  return record;
}

async function viaSimilarity(ctx: Ctx, item: FixtureItem, run: number): Promise<CallRecord> {
  let embedMs = 0;
  const timed = async (t: string): Promise<number[]> => {
    const t0 = performance.now();
    try { return await realEmbed(t); } finally { embedMs += performance.now() - t0; }
  };
  const hints = await similarityHints(OWNER, ctx.vocab, item.title, timed);
  const { record, prompt } = await viaEnrich('S', ctx, item, run, hints, {
    retrievalIds: idsOf(await retrieveFor('similarity', item.title, ctx.vocab)), embedMs,
  });
  if (prompt) checkPrompt(ctx.model, 'S', item, prompt, hints, 'last');
  return record;
}

/**
 * P: enrichQuick with B's block swapped for the placebo block, in the same place. Called as S is
 * (straight at enrichQuick), and B's route prompt is asserted equal to enrichQuick's with the
 * same hints, so the two differ in the lessons only.
 */
async function viaPlacebo(ctx: Ctx, item: FixtureItem, run: number, hints: Hints, retrievalIds: string[]): Promise<CallRecord> {
  const { record, prompt } = await viaEnrich('P', ctx, item, run, hints, { retrievalIds });
  if (prompt) {
    checkPrompt(ctx.model, 'P', item, prompt, hints, 'last');
    // Added, not rewritten: take the block out and it is the stock prompt, as for B.
    try {
      if (withoutHints(prompt, [hints.motivation, hints.category]) !== stockPrompts.get(item.title)) {
        violate(ctx.model, `P "${item.title}": the placebo prompt differs from the stock prompt by more than the block`);
      }
    } catch (err) {
      violate(ctx.model, `P "${item.title}": ${(err as Error).message}`);
    }
  }
  return record;
}

/** N0 / N: the narrow one-field question, exactly as ollamaScorer sends it. */
async function viaNarrow(
  arm: 'N0' | 'N', ctx: Ctx, item: FixtureItem, run: number, hint: string, score: NonNullable<Awaited<ReturnType<typeof ollamaScorer>>>,
): Promise<CallRecord> {
  const { calls, thrown } = await seamOf(() => score({ field: 'category', inputText: classificationInput(item.title, null), hint }));
  const seam = calls.find((c) => !c.dry);
  if (seam) checkPrompt(ctx.model, arm, item, seam.prompt, hint ? { category: hint, motivation: '' } : null, 'narrow');
  const record = toRecord(arm, ctx.model, item, run, seam, ctx.vocab, { error: thrown ?? seam?.error ?? null, narrow: true });
  await noteResidency(ctx.model, arm);
  return record;
}

/** Share of the calls (in percent) whose raw completion carries each requested key. */
function keyCoverage(calls: readonly CallRecord[], keys: readonly string[]): Record<string, number> {
  const objects = calls.map((c): Record<string, unknown> => {
    try {
      const o = parseJsonLoose<unknown>(c.raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  });
  return Object.fromEntries(keys.map((k) => [k, Number(fmt1(pct(objects.filter((o) => k in o).length, calls.length)))]));
}

/**
 * Arm P against A (the format effect alone) and against B (the lessons' content), on the titles
 * P ran on, and A, B and the other arms' shapes cut to those same titles (`sameTitles`).
 * `directions` is the owner's direction vocabulary the direction shares are read against.
 */
function placeboReport(
  model: string, metas: readonly PlaceboMeta[], scoredTitles: readonly string[], controlTitles: readonly string[],
  directions: readonly string[] = DIRECTIONS,
): PlaceboReport {
  const ran = new Set(armCalls(records, model, 'P').map((c) => c.title));
  const used = metas.filter((m) => ran.has(m.title));
  const deltas = used.map((m) => Math.abs(m.pChars - m.bChars));
  const onP = (titles: readonly string[]) => titles.filter((t) => ran.has(t));
  const against = (titles: readonly string[]) => ({
    vsA: compareArms(records, model, 'A', 'P', onP(titles)),
    bVsP: compareArms(records, model, 'P', 'B', onP(titles)),
  });
  const targets = against(scoredTitles);
  const short = used.filter((m) => m.pLessons < m.bLessons).map((m) => m.title);
  const sameTitles: Record<string, ArmShape> = {};
  for (const arm of PLACEBO_COMPARED) {
    const s = armShape(records, model, arm, onP(scoredTitles), onP(controlTitles), { only: ran, directions });
    if (s) sameTitles[arm] = s;
  }
  return {
    ran: ran.size > 0,
    ...(ran.size === 0 ? { why: 'no title had lessons about other values to build a placebo from' } : {}),
    titles: used,
    of: { targets: scoredTitles.length, controls: controlTitles.length },
    ranOn: { targets: onP(scoredTitles).length, controls: onP(controlTitles).length },
    short,
    notRun: metas.filter((m) => !ran.has(m.title)).map((m) => m.title),
    ownOnRejectedSide: used.filter((m) => m.ownOnRejectedSide > 0).map((m) => m.title),
    lengthDelta: {
      meanAbs: Number(fmt1(deltas.reduce((a, b) => a + b, 0) / (deltas.length || NaN))),
      maxAbs: deltas.length ? Math.max(...deltas) : NaN,
    },
    shape: shapeStats(armCalls(records, model, 'P')),
    sameTitles,
    targets,
    controls: against(controlTitles),
    reading: placeboReading(targets.bVsP, short.length),
  };
}

/** The shares of A, an arm and P over the titles P ran on, or null when any of the three has no share there. */
function placeboBasis(p: PlaceboReport | null, arm: Arm): PlaceboShapeBasis | null {
  const a = p?.sameTitles.A?.shape;
  const x = p?.sameTitles[arm]?.shape;
  const q = p?.sameTitles.P?.shape;
  return p?.ran && a && x && q ? { n: p.titles.length, aPct: a.arrayPct, armPct: x.arrayPct, placeboPct: q.arrayPct } : null;
}

/**
 * One row of the summary table. `targets` and `controls` are x/n out of the titles the arm
 * RAN ON among those asked about, not out of all of them: a title an arm never ran on is
 * absent, not wrong (run 5's P printed 0/12 for 0/8, every missing title counted as a miss).
 * For an arm that ran on every title nothing changes. `partial` says an arm ran on fewer.
 */
const armLine = (model: string, arm: Arm, scored: readonly string[], controls: readonly string[]): Record<string, unknown> | null => {
  const calls = armCalls(records, model, arm);
  if (calls.length === 0) return null;
  const s = schemaStats(calls);
  const ranTitles = new Set(calls.map((c) => c.title));
  const scoredRan = scored.filter((t) => ranTitles.has(t));
  const controlsRan = controls.filter((t) => ranTitles.has(t));
  const score = (titles: readonly string[]) => titles.filter((t) => majorityCorrect(flagsFor(records, model, arm, t))).length;
  const ms = calls.map((c) => c.ms).filter(Number.isFinite);
  return {
    arm, calls: s.n, targets: `${score(scoredRan)}/${scoredRan.length}`, controls: `${score(controlsRan)}/${controlsRan.length}`,
    targetsRan: scoredRan.length, targetsOf: scored.length, controlsRan: controlsRan.length, controlsOf: controls.length,
    partial: scoredRan.length < scored.length || controlsRan.length < controls.length,
    validJsonPct: Number(fmt1(s.validJsonPct)), allKeysPct: Number(fmt1(s.allKeysPct)),
    categoriesArrayPct: Number(fmt1(shapeStats(calls).arrayPct)), empty: s.empty, errored: s.errored,
    meanMs: Number(fmt0(ms.reduce((a, b) => a + b, 0) / (ms.length || NaN))), p95Ms: Number(fmt0(percentile(ms, 95))),
  };
};

const cell = (model: string, arm: Arm, title: string): string => flipCell(records, model, arm, title);

function renderEval(e: TreatmentEval): string[] {
  const { g1, g2, g3, g5 } = e;
  const signed = (x: number) => (x >= 0 ? `+${x}` : `${x}`);
  const lines = [
    `  ${e.arm} vs A${e.arm === 'C' ? ' (diagnostic, not a gate: the adjacent layout, which is not the shipped one)' : ''}`,
    `    G1 efficacy         ${g1.verdict}: ${g1.baseCorrect} -> ${g1.treatCorrect} of ${g1.n} scored targets correct `
      + `(${signed(g1.net)} net: ${g1.wins} wins, ${g1.losses} losses = ${fmt1(g1.deltaPoints)} points); `
      + `A vs A2 flipped ${g1.noiseFlips}; minimum detectable effect one title = ${fmt1(g1.mdePoints)} points`,
  ];
  if (g1.winTitles.length) lines.push(`      wins:   ${g1.winTitles.join('; ')}`);
  if (g1.lossTitles.length) lines.push(`      losses: ${g1.lossTitles.join('; ')}`);
  if (g1.noiseTitles.length) lines.push(`      A vs A2 flips: ${g1.noiseTitles.join('; ')}`);
  lines.push(
    `    G2 over-application ${g2.pass ? 'PASS' : 'FAIL'}: ${g2.flipped.length} of ${g2.baseCorrect} baseline-correct controls went wrong `
      + `(allowed ${GATES.g2MaxFlips})${g2.flipped.length ? `: ${g2.flipped.join('; ')}` : ''}${g2.healed.length ? ` | controls that went right: ${g2.healed.join('; ')}` : ''}`,
    `      G2 can only flip ${e.power.g2FlippableControls} controls (the baseline-correct ones, ${e.power.g2FlippableControls} of ${e.power.controls}; the rest are wrong already)`,
    `    G3 schema safety    ${g3.pass ? 'PASS' : 'FAIL'}: valid JSON ${fmt1(g3.base.validJsonPct)}% -> ${fmt1(g3.treat.validJsonPct)}%, `
      + `all keys ${fmt1(g3.base.allKeysPct)}% -> ${fmt1(g3.treat.allKeysPct)}%, empty ${g3.base.empty} -> ${g3.treat.empty}, errored ${g3.base.errored} -> ${g3.treat.errored}`,
    `      G3 baseline: every requested key on ${fmt1(e.power.g3BaseKeysPct)}% of calls, "categories" an array on ${fmt1(e.power.g3BaseArrayPct)}% of calls `
      + `(${e.arm}: ${fmt1(e.power.g3TreatArrayPct)}%); the registered clause reads key presence only, not its type`,
    `    G5 loop             ${g5.pass ? 'PASS' : 'FAIL'}: the owner's value ${fmt1(g5.baseShare)}% -> ${fmt1(g5.treatShare)}% of scored targets`,
    ...e.power.notPowered.map((note) => `    ${note}`),
  );
  return lines;
}

function renderShape(report: ModelReport): string[] {
  const lines = [
    `Answer shape, the JSON type of "categories" in each completion. ${SHAPE_WHY.charAt(0).toUpperCase()}${SHAPE_WHY.slice(1)}.`,
    'arm  calls  array%  string  missing  other   correct (production)         given an array answer       read leniently',
  ];
  const acc = (a: ShapeAccuracy): string => (a.n === 0 ? '-' : `${a.correct}/${a.n}`);
  const given = (a: ShapeAccuracy): string => (a.n === 0 ? '-' : `${a.correctGivenArray}/${a.arrays}`);
  const lenient = (a: ShapeAccuracy): string => (a.n === 0 ? '-' : `${a.lenient}/${a.n}`);
  for (const arm of ARMS_REPORTED) {
    const x = report.shapes[arm];
    if (!x) continue;
    lines.push(`${arm.padEnd(4)} ${String(x.shape.n).padEnd(6)} ${fmt1(x.shape.arrayPct).padEnd(7)} ${String(x.shape.string).padEnd(7)} ${String(x.shape.missing).padEnd(8)} ${String(x.shape.other).padEnd(7)} `
      + `T ${acc(x.targets).padEnd(7)} C ${acc(x.controls).padEnd(7)}   T ${given(x.targets).padEnd(7)} C ${given(x.controls).padEnd(7)}   T ${lenient(x.targets).padEnd(7)} C ${lenient(x.controls)}`);
  }
  lines.push('  (call counts, not titles; T = scored targets, A0 = all 12 targets, C = controls)');
  if (report.placebo?.ran && report.placebo.notRun.length) {
    lines.push(`  (P ran on ${report.placebo.titles.length} of ${report.placebo.titles.length + report.placebo.notRun.length} titles, so its row covers fewer calls and titles than the others; `
      + 'the placebo block below cuts A and B to the titles P ran on)');
  }
  lines.push(...renderDirection(report));
  if (report.baselineKeys) {
    const gaps = Object.entries(report.baselineKeys).filter(([, v]) => !(v >= DIAGNOSTICS.minBaselineKeyCoveragePct));
    lines.push(`  keys A's completions carry (percent of calls): ${Object.entries(report.baselineKeys).map(([k, v]) => `${k} ${v}`).join(', ')}`
      + (gaps.length ? `; present on under ${DIAGNOSTICS.minBaselineKeyCoveragePct}%: ${gaps.map(([k]) => k).join(', ')}` : ''));
  }
  return lines;
}

/**
 * The direction block of the shape table: per arm, how often "direction" names one of the
 * owner's directions and how often enrichQuick would spend a second model call on it. Calls,
 * not titles, and first-pass completions only (the second call is made, not recorded).
 */
function renderDirection(report: ModelReport): string[] {
  const rows = ARMS_REPORTED.filter((arm) => report.shapes[arm]?.direction);
  if (rows.length === 0) return [];
  const lines = [
    `Direction, the first-pass "direction" read as enrichQuick reads it (${DIRECTIONS.join(', ')}; constrainOne). `
      + 'A completion with none of them makes enrichQuick ask a second, single-field direction question: one more sequential model call before quick-add answers.',
    'arm  calls  valid%  second-call%',
  ];
  for (const arm of rows) {
    const d = report.shapes[arm].direction!;
    lines.push(`${arm.padEnd(4)} ${String(d.n).padEnd(6)} ${fmt1(d.validPct).padEnd(7)} ${fmt1(d.secondChancePct)}`);
  }
  lines.push('  (unreadable completions, empty or not JSON, count in calls and in neither share: production never gets as far as a second question there)');
  return lines;
}

function renderPlacebo(report: ModelReport): string[] {
  const p = report.placebo;
  if (!p) return [];
  if (!p.ran) return [`Placebo P (diagnostic, not a gate): not run (${p.why ?? 'no reason recorded'}).`];
  // Everything below is out of the titles P ran on (n of them), never out of all of them.
  const side = (label: string, c: PlaceboReport['targets'], ranOn: number, of: number): string =>
    `  ${label} (P ran on ${ranOn} of ${of}): A ${c.vsA.baseCorrect} -> P ${c.vsA.treatCorrect} of ${c.vsA.n} titles (the block alone); `
    + `P ${c.bVsP.baseCorrect} -> B ${c.bVsP.treatCorrect} (${c.bVsP.wins} titles B right where P wrong, ${c.bVsP.losses} the other way)`;
  const pct1 = (arm: string): string => fmt1(p.sameTitles[arm]?.shape.arrayPct ?? NaN);
  const second = (arm: string): string => fmt1(p.sameTitles[arm]?.direction?.secondChancePct ?? NaN);
  const lines = [
    "Placebo P (diagnostic, not a gate): B's block with the owner's lessons swapped for real lessons about other values, same place, "
      + `as many lessons as B shows where the index allows, length within ${p.lengthDelta.maxAbs} chars of B's (mean ${p.lengthDelta.meanAbs}). `
      + `P ran on ${p.titles.length} of ${p.titles.length + p.notRun.length} titles${p.notRun.length ? ` (no block could be built for the other ${p.notRun.length})` : ''}`
      + (p.short.length ? `; on ${p.short.length} of them its block showed fewer lessons than B's` : "; its block matched B's lesson count on every one")
      + (p.ownOnRejectedSide.length
        ? `; on ${p.ownOnRejectedSide.length} a lesson names the title's own value on the "you said" side (the filter keeps it off the "user chose" side only)` : ''),
    side('scored targets', p.targets, p.ranOn.targets, p.of.targets),
    side('controls', p.controls, p.ranOn.controls, p.of.controls),
  ];
  if (p.targets.bVsP.winTitles.length) lines.push(`    B right, P wrong: ${p.targets.bVsP.winTitles.join('; ')}`);
  if (p.targets.bVsP.lossTitles.length) lines.push(`    P right, B wrong: ${p.targets.bVsP.lossTitles.join('; ')}`);
  lines.push(
    `  Over those ${p.titles.length} titles, A and B cut to them (the shape table above is over all of an arm's titles): `
      + `"categories" an array on A ${pct1('A')}%, B ${pct1('B')}%, P ${pct1('P')}%; `
      + `second direction call on A ${second('A')}%, B ${second('B')}%, P ${second('P')}%`,
    `  ${p.reading}`,
  );
  return lines;
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

function flush(): void {
  if (!OUT) return;
  const artifact = {
    harness: 'classification-hint-live',
    startedAt, writtenAt: new Date().toISOString(),
    // The starter's real argv (see pickCommand), not a line assembled from the harness's own variables.
    command: provenance.command ?? null,
    env: {
      runs: RUNS, models: MODELS, ollamaUrl: redactUrl(config.ollamaUrl), ollamaVersion,
      // The OLLAMA_* of the TEST PROCESS. OLLAMA_MAX_LOADED_MODELS here says nothing about the
      // Ollama server's own setting (null here is not "one model at a time"): see provenance.ollama.apiPsAtStart.
      ollamaInTestProcess: envWithPrefix(process.env, 'OLLAMA_'),
      liveHint: envWithPrefix(process.env, 'LIVE_HINT'),
    },
    provenance,
    // Arm C changed meaning on 2026-11-02: an artifact without this key is from the first three runs,
    // where B was adjacent and C was hint last.
    layouts: ARM_LAYOUTS,
    gates: GATES,
    diagnostics: DIAGNOSTICS,
    fixture: { conventions: CONVENTIONS, controls: CONTROLS },
    reports,
    violations,
    prompts: Object.fromEntries(distinctPrompts),
    calls: records,
  };
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
}

// ── One model, end to end ─────────────────────────────────────────────────────

async function runModel(model: string, gating: boolean, partner: string | undefined): Promise<ModelReport> {
  const report: ModelReport = {
    model, gating, status: 'ran', note: '', baseline: [], baselineShape: null, shapes: {}, baselineKeys: null, placebo: null,
    capture: null, index: null, hintChars: null,
    retrieval: {}, evaluations: [], summary: [], flips: [], narrow: null, latency: null, residency: null,
    g4: { checked: 0, bad: 0 }, reading: [],
  };
  reports.push(report);
  rec.model = model;
  say(`\n=== ${model} ${gating ? '(fast tier: the gates apply here)' : '(informational)'} ===`);
  await warm(model);
  // A cold embedder would blow EMBED_TIMEOUT_MS on its first use and quietly turn every
  // similarity retrieval into the frequency fallback, so load it before anything asks.
  if (haveEmbedder) await embed('warm up', 180_000);
  resetWorld();
  retrievalCache.clear();
  stockPrompts.clear();
  const vocab = await suggestibleVocabulary(OWNER);
  const ctx: Ctx = { model, vocab };

  // Phase 0: the baseline on the targets, before any evidence exists. It decides headroom.
  for (const item of TARGET_ITEMS) {
    for (let run = 0; run < RUNS; run++) {
      const { record, prompt } = await viaEnrich('A0', ctx, item, run);
      checkPrompt(model, 'A0', item, prompt, null, 'last');
      if (record.empty) violate(model, `A0 "${item.title}" run ${run}: empty or errored completion ${record.error ?? ''}`);
    }
    flush();
  }
  for (const c of CONVENTIONS) {
    const mine = TARGET_ITEMS.filter((t) => t.convention === c.id);
    const correct = mine.filter((t) => majorityCorrect(flagsFor(records, model, 'A0', t.title))).length;
    report.baseline.push({
      convention: c.id, correct, n: mine.length, headroom: hasHeadroom(correct, mine.length),
      perTitle: Object.fromEntries(mine.map((t) => [t.title, cell(model, 'A0', t.title)])),
    });
  }
  // The answer shape of the baseline comes first: with a shape production discards, the
  // accuracy below counts answers that never became picks, whatever the model knew.
  const a0Shape = shapeStats(armCalls(records, model, 'A0'));
  const allTargetTitles = TARGET_ITEMS.map((t) => t.title);
  const strictTargets = allTargetTitles.filter((t) => majorityCorrect(flagsFor(records, model, 'A0', t))).length;
  const lenientTargets = lenientMajority(records, model, 'A0', allTargetTitles);
  report.baselineShape = { a0: a0Shape, unusable: shapeUnusable(a0Shape), strictTargets, lenientTargets };
  say('Baseline on the targets, before any evidence (a convention at or above 75% is not scored):');
  for (const b of report.baseline) {
    say(`  ${b.convention.padEnd(18)} ${b.correct}/${b.n} = ${fmt0((100 * b.correct) / b.n)}%  `
      + `${b.headroom ? (report.baselineShape.unusable ? 'headroom (shape-confounded, see below)' : 'headroom') : 'INCONCLUSIVE: NO HEADROOM'}`);
    for (const [title, c] of Object.entries(b.perTitle)) say(`      ${c.padEnd(8)} ${title}`);
  }
  say(`Answer shape of the baseline: "categories" was an array on ${a0Shape.array} of ${a0Shape.n} completions (${fmt1(a0Shape.arrayPct)}%), `
    + `a string on ${a0Shape.string}, missing on ${a0Shape.missing}, something else on ${a0Shape.other}. Production keeps only arrays. `
    + `Read leniently (a bare string taken as a one-item list; NOT what production does) the baseline is ${lenientTargets} of ${allTargetTitles.length} targets, not ${strictTargets}.`);
  if (report.baselineShape.unusable) {
    say(`INCONCLUSIVE: UNUSABLE ANSWER SHAPE for the baseline: ${unusableShapeNote(a0Shape)}. The headroom above is not a headroom reading.`);
  }
  const scoredConventions = report.baseline.filter((b) => b.headroom).map((b) => b.convention);
  if (scoredConventions.length === 0) {
    report.status = stoppedStatus(a0Shape);
    report.note = report.baselineShape.unusable
      ? unusableShapeNote(a0Shape)
      : 'the model already files every convention the way the owner does; nothing to teach';
    say(`${report.status} (${report.note})`);
    flush();
    return report;
  }
  const scoredTargets = TARGET_ITEMS.filter((t) => t.convention && scoredConventions.includes(t.convention));
  const scoredTitles = scoredTargets.map((t) => t.title);
  const controlTitles = CONTROL_ITEMS.map((c) => c.title);

  // G4 while there is no index: the route's prompt is the stock prompt, for both owners.
  const sweepA = await promptSweep(model, 'no index, owner 1', OWNER, 'stock', vocab);
  const sweepB = await promptSweep(model, 'no index, owner 2', SECOND_OWNER_ID, 'stock', vocab);
  for (const sweep of [sweepA, sweepB]) { report.g4.checked += sweep.checked; report.g4.bad += sweep.bad; }

  // Phase 1: the evidence, through the real capture path.
  const capture: CaptureStats = {
    parsed: 0, claims: 0, noClaim: 0, exact: 0, firstMatch: 0, corrections: 0,
    shapes: { array: 0, string: 0, missing: 0, other: 0 },
  };
  report.capture = capture;
  const queues = CONVENTIONS.filter((c) => scoredConventions.includes(c.id)).map((c) => TRAIN_ITEMS.filter((t) => t.convention === c.id));
  const order: FixtureItem[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) order.push(q[i]);
  for (const item of order) {
    const { value: parsed, calls } = await seamOf(() => parseViaRoute(item.title));
    capture.parsed++;
    const seam = calls.find((c) => !c.dry);
    if (seam) capture.shapes[categoriesTypeOf(seam.raw)]++;
    if (seam) checkPrompt(model, 'A', item, seam.prompt, null, 'last'); // no index yet: no hint
    if (seam && seam.prompt !== stockPrompts.get(item.title)) violate(model, `capture "${item.title}": the live prompt is not the stock prompt`);
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
      capture.noClaim++;
      if (rows.length !== 0) violate(model, `capture "${item.title}": no claim was sent but a log row was written`);
      continue;
    }
    capture.claims++;
    const claimed = claim.categories.join(', ');
    const differs = claimed !== item.expected;
    if (claim.categories.length === 1 && !differs) capture.exact++;
    if (claim.categories[0] === item.expected) capture.firstMatch++;
    if (differs) capture.corrections++;
    const row = rows[0];
    const wanted = differs ? { final: item.expected, closed: true } : { final: null, closed: false };
    if (rows.length !== 1 || row.llm_value !== claimed || row.final_value !== wanted.final || (row.corrected_at !== null) !== wanted.closed) {
      violate(model, `capture "${item.title}": the log row is not what the echoed claim should write (${JSON.stringify(rows)})`);
    }
  }
  // "No claim" is not "the model did not answer": the route offers a claim only for an array that names the
  // owner's own categories, so a bare string, an abstention and an unknown name all look the same from here.
  say(`Capture: ${capture.parsed} titles parsed, ${capture.claims} claims echoed (${capture.noClaim} with none: no category pick survived the route), `
    + `${capture.exact} exactly the owner's value, ${capture.firstMatch} with the owner's value first, ${capture.corrections} corrections written. `
    + `"categories" in those ${capture.parsed} completions: array ${capture.shapes.array}, string ${capture.shapes.string}, `
    + `missing ${capture.shapes.missing}, other ${capture.shapes.other} (production keeps only arrays). `
    + `Stock-prompt sweeps before the index: ${sweepA.checked} + ${sweepB.checked} titles, ${sweepA.bad + sweepB.bad} differing from the stock prompt.`);

  // Calibrate once, as shipped (no embedder), then check what it produced.
  const cal = await calibrateClassification(OWNER, new Date(), { embedFn: null });
  const category = cal.fields.find((f) => f.field === 'category');
  const indexRows = (): { log_id: string; correct_value: string; has_vec: number }[] => sqlite.prepare(
    `SELECT log_id, correct_value, embedding IS NOT NULL AS has_vec FROM classification_exemplars WHERE owner_id = ? AND field = 'category' ORDER BY log_id`,
  ).all(OWNER) as { log_id: string; correct_value: string; has_vec: number }[];
  let rows = indexRows();
  const byValue: Record<string, number> = {};
  for (const r of rows) byValue[r.correct_value] = (byValue[r.correct_value] ?? 0) + 1;
  report.index = {
    corrections: category?.corrections ?? 0, indexed: rows.length, heldOut: (category?.corrections ?? 0) - rows.length,
    byValue, withVectors: rows.filter((r) => r.has_vec).length,
  };
  if (report.index.withVectors !== 0) violate(model, `calibrate with embedFn: null wrote ${report.index.withVectors} vectors`);
  say(`Index after calibrate (embedFn: null): ${report.index.corrections} category corrections, ${report.index.indexed} indexed, `
    + `${report.index.heldOut} held out; by owner value ${JSON.stringify(byValue)}`);
  if (report.index.corrections < CORRECTION_FLOOR) {
    report.status = stoppedStatus(a0Shape);
    report.note = `only ${report.index.corrections} corrections (the floor is ${CORRECTION_FLOOR}) from ${capture.claims} claims on ${capture.parsed} training titles `
      + `(${capture.noClaim} produced no claim): there is no evidence to learn from`
      + (report.baselineShape.unusable ? `. ${unusableShapeNote(a0Shape)}` : '');
    say(`${report.status} (${report.note})`);
    flush();
    return report;
  }

  // A second calibrate adds vectors for arm S only. Same rows, asserted, so B is unaffected
  // (the frequency path never reads a vector).
  const idsBefore = rows.map((r) => r.log_id).join();
  if (haveEmbedder) {
    await calibrateClassification(OWNER, new Date(), { embedFn: realEmbed });
    rows = indexRows();
    if (rows.map((r) => r.log_id).join() !== idsBefore) violate(model, 'the embedding calibrate changed which rows are indexed');
    report.index.withVectors = rows.filter((r) => r.has_vec).length;
    say(`Second calibrate with the real embedder (arm S only): ${report.index.withVectors} of ${rows.length} indexed rows now carry a vector.`);
  }

  // Hints the production arguments produce, per title; prompt growth; the sweeps with an index.
  const hintFor = new Map<string, Hints>();
  for (const item of [...scoredTargets, ...CONTROL_ITEMS]) hintFor.set(item.title, await prodHints(OWNER, vocab, item.title));
  const lens = [...hintFor.values()];
  report.hintChars = {
    category: Math.round(lens.reduce((s, h) => s + (h.category ? h.category.length + 1 : 0), 0) / lens.length),
    motivation: Math.round(lens.reduce((s, h) => s + (h.motivation ? h.motivation.length + 1 : 0), 0) / lens.length),
  };
  const sample = hintFor.get(scoredTargets[0].title)!;
  say(`The category hint the production arguments build (${report.hintChars.category} chars added per prompt; motivation ${report.hintChars.motivation}):${sample.category.replace(/\n$/, '')}`);
  if (!lens.some((h) => h.category)) violate(model, 'the production arguments produce no category hint although the index has rows');
  const sweepHinted = await promptSweep(model, 'index, owner 1', OWNER, 'hinted', vocab);
  const sweepLeak = await promptSweep(model, 'index, owner 2 (no leak)', SECOND_OWNER_ID, 'stock', vocab);
  report.g4.checked += sweepLeak.checked;
  report.g4.bad += sweepLeak.bad;
  say(`Dry sweeps with the index: ${sweepHinted.checked} titles checked for the hint exactly once and nothing else (${sweepHinted.bad} violations); `
    + `${sweepLeak.checked} titles for the owner without an index checked for stock (${sweepLeak.bad} violations).`);

  // Retrieval precision: a property of the fixture and the retrieval mode, no generation model.
  for (const mode of haveEmbedder ? (['frequency', 'similarity'] as const) : (['frequency'] as const)) {
    let p1 = 0;
    let pk = 0;
    for (const item of scoredTargets) {
      const got = await retrieveFor(mode, item.title, vocab);
      if (got[0]?.correctValue.toLowerCase() === item.expected) p1++;
      if (got.some((e) => e.correctValue.toLowerCase() === item.expected)) pk++;
    }
    report.retrieval[mode] = { n: scoredTargets.length, p1, pk };
  }
  say(`Retrieval on the scored targets (the top lesson / any of ${RETRIEVE_K} carries the owner's value): `
    + Object.entries(report.retrieval).map(([m, r]) => `${m} p@1 ${r.p1}/${r.n}, p@k ${r.pk}/${r.n}`).join('; '));

  // The arms, interleaved per (title, run).
  const armItems = [...scoredTargets, ...CONTROL_ITEMS];

  // Arm P's block for each title, built once from the index (see placeboLessons).
  const pool = indexExemplars(OWNER, vocab);
  const placebo = new Map<string, { hint: string; meta: PlaceboMeta }>();
  for (const item of armItems) {
    const real = await retrieveFor('frequency', item.title, vocab);
    const own = ownValueOf(item);
    const lessons = placeboLessons(pool, own, real, item.title);
    const hint = exemplarPrompt(lessons);
    if (own !== null && lessons.some((e) => namesValue(e.correctValue, own))) violate(model, `P "${item.title}": a placebo lesson carries the title's own value ${own}`);
    if (lessons.some((e) => real.some((r) => r.logId === e.logId))) violate(model, `P "${item.title}": a placebo lesson is one B shows`);
    placebo.set(item.title, {
      hint,
      meta: {
        title: item.title, own, bLessons: real.length, pLessons: lessons.length,
        bChars: hintFor.get(item.title)!.category.length, pChars: hint.length,
        values: lessons.map((e) => e.correctValue), logIds: idsOf(lessons),
        ownOnRejectedSide: ownOnRejectedSide(lessons, own),
      },
    });
  }
  const metas = [...placebo.values()].map((v) => v.meta);
  const built = metas.filter((m) => m.pLessons > 0);
  const deltas = built.map((m) => Math.abs(m.pChars - m.bChars));
  say(`Placebo block (arm P) built for ${built.length} of ${metas.length} titles from ${pool.length} lessons in the index (P runs on those only); `
    + `on ${built.filter((m) => m.pLessons < m.bLessons).length} of them it shows fewer lessons than B's block; never a lesson chosen for the title's own value `
    + `(${built.filter((m) => m.ownOnRejectedSide > 0).length} blocks name it on the "you said" side); length within `
    + `${deltas.length ? Math.max(...deltas) : 'n/a'} chars of B's (mean ${fmt1(deltas.reduce((a, b) => a + b, 0) / (deltas.length || NaN))}).`);
  const pSample = placebo.get(scoredTargets[0].title);
  if (pSample?.hint) {
    say(`The placebo block for "${scoredTargets[0].title}" (its own value is ${pSample.meta.own}; ${pSample.meta.pChars} chars against B's ${pSample.meta.bChars}):${pSample.hint.replace(/\n$/, '')}`);
  }

  const t0 = Date.now();
  for (const item of armItems) {
    const hints = hintFor.get(item.title)!;
    const ph = placebo.get(item.title)!;
    for (let run = 0; run < RUNS; run++) {
      const a = await viaEnrich('A', ctx, item, run);
      checkPrompt(model, 'A', item, a.prompt, null, 'last');
      const b = await viaRoute(ctx, item, run, hints);
      await viaAdjacent(ctx, item, run, b.prompt, hints);
      if (haveEmbedder) await viaSimilarity(ctx, item, run);
      const a2 = await viaEnrich('A2', ctx, item, run);
      checkPrompt(model, 'A2', item, a2.prompt, null, 'last');
      for (const r of [a.record, a2.record]) if (r.empty) violate(model, `${r.arm} "${item.title}" run ${run}: empty or errored completion ${r.error ?? ''}`);
      if (ph.meta.pLessons > 0) await viaPlacebo(ctx, item, run, { category: ph.hint, motivation: hints.motivation }, ph.meta.logIds);
    }
    flush();
  }
  say(`Arms A, B, C${haveEmbedder ? ', S' : ''}, A2, P done: ${armItems.length} titles x ${RUNS} runs in ${Math.round((Date.now() - t0) / 1000)} s.`);

  let evalB = evaluateTreatment(records, model, 'B', scoredTitles, controlTitles);

  // The named remedy: B with k: 1, only when B fails over-application or schema safety.
  if (!evalB.g2.pass || !evalB.g3.pass) {
    say(`B fails ${[!evalB.g2.pass && 'G2', !evalB.g3.pass && 'G3'].filter(Boolean).join(' and ')}: running arm B1 (k: 1).`);
    for (const item of armItems) {
      const hints = await prodHints(OWNER, vocab, item.title, 1);
      for (let run = 0; run < RUNS; run++) {
        const { prompt } = await viaEnrich('B1', ctx, item, run, hints, { retrievalIds: idsOf(await retrieveFor('frequency', item.title, vocab, 1)) });
        checkPrompt(model, 'B1', item, prompt, hints, 'last');
      }
      flush();
    }
  }

  // The diagnostic for a null result: the narrow question, with and without the hint.
  evalB = evaluateTreatment(records, model, 'B', scoredTitles, controlTitles);
  if (evalB.g1.net <= 0) {
    const score = await ollamaScorer(OWNER);
    if (!score) {
      report.narrow = { ran: false, why: 'ollamaScorer declined: Ollama is not ready for the scorer' };
    } else {
      say('B shows no gain on the targets: running the narrow question with and without the hint (arms N0, N).');
      for (const item of armItems) {
        const hint = hintFor.get(item.title)!.category;
        for (let run = 0; run < RUNS; run++) {
          const n0 = await viaNarrow('N0', ctx, item, run, '', score);
          await viaNarrow('N', ctx, item, run, hint, score);
          if (n0.empty) violate(model, `N0 "${item.title}" run ${run}: empty or errored completion ${n0.error ?? ''}`);
        }
        flush();
      }
    }
  }

  // Everything evaluated from the records.
  for (const arm of ['B', 'C', 'S', 'B1', 'N'] as Arm[]) {
    if (armCalls(records, model, arm).length === 0) continue;
    // N is read against N0 (the narrow baseline), the rest against A.
    if (arm === 'N') {
      const c = compareArms(records, model, 'N0', 'N', scoredTitles);
      const vsA = compareArms(records, model, 'A', 'N', scoredTitles);
      report.narrow = {
        ran: true, scored: c.n, narrowBaseline: c.baseCorrect, narrowHinted: c.treatCorrect, winsOverN0: c.winTitles, lossesVsN0: c.lossTitles,
        hintedNarrowVsWideBaseline: `${vsA.baseCorrect} -> ${vsA.treatCorrect} of ${vsA.n}`,
      };
      continue;
    }
    report.evaluations.push(evaluateTreatment(records, model, arm, scoredTitles, controlTitles));
  }
  for (const arm of ARMS_REPORTED) {
    const line = armLine(model, arm, arm === 'A0' ? allTargetTitles : scoredTitles, arm === 'A0' ? [] : controlTitles);
    if (line) report.summary.push(line);
    const shape = armShape(records, model, arm, arm === 'A0' ? allTargetTitles : scoredTitles, arm === 'A0' ? [] : controlTitles, { directions: vocab.directions });
    if (shape) report.shapes[arm] = shape;
  }
  report.baselineKeys = keyCoverage(armCalls(records, model, 'A'), WIDE_KEYS);
  report.placebo = placeboReport(model, metas, scoredTitles, controlTitles, vocab.directions);
  for (const item of armItems) {
    report.flips.push({
      title: item.title, kind: item.kind, convention: item.convention, expected: item.expected,
      ...Object.fromEntries(ARMS_REPORTED.filter((arm) => arm !== 'A0').map((arm) => [arm, cell(model, arm, item.title)])),
      pickA: modalPick(armCalls(records, model, 'A').filter((r) => r.title === item.title).map((r) => r.pick)),
      pickB: modalPick(armCalls(records, model, 'B').filter((r) => r.title === item.title).map((r) => r.pick)),
    });
  }

  // Latency and residency, on the gating model only (the index is still in place).
  if (gating) await measureLatency(report, ctx, armItems, partner);

  // The reset restores the stock prompt: the hint is a pure read of the index.
  const reset = await api(srv.url, '/api/classification/exemplars', { method: 'DELETE' });
  if (reset.status !== 200) violate(model, `DELETE /api/classification/exemplars answered ${reset.status}`);
  const sweepReset = await promptSweep(model, 'after DELETE /api/classification/exemplars', OWNER, 'stock', vocab);
  report.g4.checked += sweepReset.checked;
  report.g4.bad += sweepReset.bad;
  say(`After the reset: ${sweepReset.checked} titles checked for stock (${sweepReset.bad} violations).`);

  report.reading = readOff(report);
  printReport(report);
  flush();
  return report;
}

// ── Latency and residency (gating model only) ────────────────────────────────

async function measureLatency(report: ModelReport, ctx: Ctx, armItems: readonly FixtureItem[], partner: string | undefined): Promise<void> {
  const { model, vocab } = ctx;
  const timeHints = async (owner: string, title: string): Promise<number> => {
    const t = performance.now();
    await prodHints(owner, vocab, title);
    return performance.now() - t;
  };

  // (a) GATING: the hint read, in process, with an index interleaved with without one.
  const withIndex: number[] = [];
  const withoutIndex: number[] = [];
  for (let i = 0; i <= LATENCY_N; i++) {
    const title = armItems[i % armItems.length].title;
    const order = i % 2 === 0 ? [OWNER, SECOND_OWNER_ID] : [SECOND_OWNER_ID, OWNER];
    for (const owner of order) {
      const ms = await timeHints(owner, title);
      if (i === 0) continue; // the first run is discarded
      (owner === OWNER ? withIndex : withoutIndex).push(ms);
    }
  }
  const gate = hintLatencyGate(withIndex, withoutIndex);

  // (b) REPORTED: the route's wall time without an index (A-style) versus with one (B).
  const wall: Record<'A-style' | 'B', number[]> = { 'A-style': [], B: [] };
  const modelMs: Record<'A-style' | 'B', number[]> = { 'A-style': [], B: [] };
  for (let i = -1; i < LATENCY_N; i++) { // -1 is a discarded warm-up pair
    const title = armItems[Math.max(i, 0) % armItems.length].title;
    const order = i % 2 === 0 ? (['A-style', 'B'] as const) : (['B', 'A-style'] as const);
    for (const which of order) {
      const t = performance.now();
      const { calls } = await seamOf(() => parseViaRoute(title, which === 'B' ? OWNER : SECOND_OWNER_ID));
      const ms = performance.now() - t;
      if (i < 0) continue;
      wall[which].push(ms);
      modelMs[which].push(calls.find((c) => !c.dry)?.ms ?? NaN);
    }
  }

  // The in-process split: hint read versus enrichQuick, for B and for S.
  const split: Record<'B' | 'S', { hint: number[]; enrich: number[]; embed: number[] }> = {
    B: { hint: [], enrich: [], embed: [] }, S: { hint: [], enrich: [], embed: [] },
  };
  for (let i = 0; i < LATENCY_N; i++) {
    const title = armItems[i % armItems.length].title;
    for (const which of ['B', 'S'] as const) {
      let embedMs = 0;
      const timed = async (t: string): Promise<number[]> => {
        const s = performance.now();
        try { return await realEmbed(t); } finally { embedMs += performance.now() - s; }
      };
      if (which === 'S' && !haveEmbedder) continue;
      const h0 = performance.now();
      const hints = which === 'B' ? await prodHints(OWNER, vocab, title) : await similarityHints(OWNER, vocab, title, timed);
      const h1 = performance.now();
      await seamOf(() => enrichQuick(title, parseQuick(title), vocab, hints));
      split[which].hint.push(h1 - h0);
      split[which].enrich.push(performance.now() - h1);
      split[which].embed.push(embedMs);
    }
  }
  const stats = (all: readonly number[]): Stat => {
    const xs = all.filter(Number.isFinite);
    return { p50: Number(fmt1(percentile(xs, 50))), p95: Number(fmt1(percentile(xs, 95))), max: Number(fmt1(xs.length ? Math.max(...xs) : NaN)) };
  };
  report.latency = {
    gateG6: { withP50: gate.withP50, withP95: gate.withP95, withoutP95: gate.withoutP95, pass: gate.pass, n: LATENCY_N },
    hintReadMs: { 'with an index': stats(withIndex), 'without an index': stats(withoutIndex) },
    routeWallMs: { 'A-style (no index)': stats(wall['A-style']), 'B (index)': stats(wall.B) },
    routeModelMs: { 'A-style (no index)': stats(modelMs['A-style']), 'B (index)': stats(modelMs.B) },
    medianDifferenceMs: Number(fmt1(percentile(wall.B, 50) - percentile(wall['A-style'], 50))),
    split: Object.fromEntries((['B', 'S'] as const).filter((w) => split[w].hint.length).map((w) => [w, {
      hintReadMs: stats(split[w].hint), enrichQuickMs: stats(split[w].enrich), embedMsWithinHint: stats(split[w].embed),
    }])),
  };

  // (c) RESIDENCY: resident sets per arm, and suspected reloads against the warm median.
  const warmMedian = percentile(armCalls(records, model, 'A').map((c) => c.ms).filter(Number.isFinite), 50);
  const perArm: ResidencyReport['perArm'] = {};
  for (const arm of ['A', 'B', 'C', 'S', 'A2', 'P', 'B1', 'N0', 'N'] as Arm[]) {
    const slot = residency[`${model}|${arm}`];
    if (!slot) continue;
    const calls = armCalls(records, model, arm).filter((c) => Number.isFinite(c.ms));
    const reloadAt = GATES.reloadFactor * warmMedian;
    const slow = Number.isFinite(reloadAt) && reloadAt > 0 ? calls.filter((c) => c.ms > reloadAt) : [];
    perArm[arm] = {
      residentSets: Object.fromEntries(slot.sets), slowerThanThreeTimesWarmMedian: slow.length, of: calls.length,
      slowest: slow.sort((a, b) => b.ms - a.ms).slice(0, 3).map((c) => ({ title: c.title, run: c.run, ms: Math.round(c.ms) })),
    };
  }
  const residencyReport: ResidencyReport = {
    warmMedianGenerateMs: Math.round(warmMedian),
    perArm,
    similarityEmbedTimeouts: armCalls(records, model, 'S').filter((c) => (c.embedMs ?? 0) >= 0.98 * EMBED_TIMEOUT_MS).length,
    twoModelsResident: { ran: false, why: haveEmbedder ? 'only one model in LIVE_HINT_MODELS' : 'no embedder installed' },
  };
  report.residency = residencyReport;

  // S once with both generation models resident (this box holds two): embed ms and generate ms.
  if (haveEmbedder && partner) {
    await warm(partner);
    await warm(model);
    rec.model = model;
    const before = await residentModels();
    const probe: { title: string; embedMs: number; generateMs: number; resident: string[] }[] = [];
    for (const item of armItems.slice(0, PROBE_N)) {
      let embedMs = 0;
      const timed = async (t: string): Promise<number[]> => {
        const s = performance.now();
        try { return await realEmbed(t); } finally { embedMs += performance.now() - s; }
      };
      const hints = await similarityHints(OWNER, vocab, item.title, timed);
      const { calls } = await seamOf(() => enrichQuick(item.title, parseQuick(item.title), vocab, hints));
      probe.push({ title: item.title, embedMs: Math.round(embedMs), generateMs: Math.round(calls.find((c) => !c.dry)?.ms ?? NaN), resident: await residentModels() });
    }
    residencyReport.twoModelsResident = {
      ran: true, fast: model, partner, residentBefore: before,
      embedMs: stats(probe.map((p) => p.embedMs)), generateMs: stats(probe.map((p) => p.generateMs)),
      generateSlowerThanThreeTimesWarmMedian: warmMedian > 0 ? probe.filter((p) => p.generateMs > GATES.reloadFactor * warmMedian).length : 0,
      residentSetsSeen: [...new Set(probe.map((p) => p.resident.join(' + ')))],
      steps: probe,
    };
  }
}

// ── Reading the result off the pre-registered rule ───────────────────────────

/**
 * Non-gating (added 2026-11-02): what each arm does to the "direction" key, in the one number
 * that costs something on the quick-add path, the share of completions that make enrichQuick
 * wait for a second model call. `p`, when P ran, adds A, B and P over the titles P ran on.
 */
function directionReading(shapes: Record<string, ArmShape>, p: PlaceboReport | null): string[] {
  const hinted: Arm[] = ['B', 'C', 'S', 'B1'];
  const arms = (['A', ...hinted] as Arm[]).filter((arm) => shapes[arm]?.direction);
  if (arms.length === 0) return [];
  const share = (d: DirectionStats | null | undefined): string => `${fmt1(d?.validPct ?? NaN)}% valid, ${fmt1(d?.secondChancePct ?? NaN)}% second call`;
  const out = [`Direction (share of completions whose "direction" names one of the owner's directions, and share that make enrichQuick ask a second, single-field direction question first): `
    + `${arms.map((arm) => `${arm} ${share(shapes[arm].direction)}`).join('; ')}.`];
  const aSecond = shapes.A?.direction?.secondChancePct ?? NaN;
  for (const arm of hinted) {
    const d = shapes[arm]?.direction;
    if (d && shapeShifted(aSecond, d.secondChancePct)) {
      out.push(`Direction: ${arm} moved the share of completions that need a second direction call from ${fmt1(aSecond)}% to ${fmt1(d.secondChancePct)}%; `
        + 'each one is another sequential model call on the quick-add path, so this is a latency cost (or saving) the hint carries, whatever it does to the picks.');
    }
  }
  if (p?.ran) {
    out.push(`Direction over the ${p.titles.length} titles P ran on: ${(['A', 'B', 'P'] as Arm[]).filter((arm) => p.sameTitles[arm]?.direction)
      .map((arm) => `${arm} ${share(p.sameTitles[arm].direction)}`).join('; ')}.`);
  }
  return out;
}

/**
 * The line readOff adds under the ship rule's reading whenever that reading is not "the hint
 * half may ship" (see the dated note under DECISION RULE). Dated and conditional on purpose:
 * on a run where every gate holds the rule and the shipped state agree and it is not printed.
 */
const SHIPPED_STATE_NOTE = 'As of 2026-11-02 the change this harness measures ships the hint half. Where the reading above is not "may ship" (the small tiers, in the recorded runs) that departs from the rule; '
  + 'the decision, what it rests on and what it leaves open: docs/classification-hint-measurement-2026-11.md, section Ship decision.';

function readOff(report: ModelReport): string[] {
  const out: string[] = [];
  const b = report.evaluations.find((e) => e.arm === 'B');
  if (!b) return out;
  // Added 2026-11-02, non-gating, for every model: what the answer shape, the placebo and the
  // power of G2 and G3 do to how far the verdicts below can be read.
  const aShape = report.shapes.A?.shape.arrayPct ?? NaN;
  out.push(...baselineShapeLine(aShape));
  for (const arm of ['B', 'C', 'S', 'B1'] as Arm[]) {
    out.push(...shapeShiftLine(aShape, arm, report.shapes[arm]?.shape.arrayPct ?? NaN, placeboBasis(report.placebo, arm)));
  }
  out.push(...directionReading(report.shapes, report.placebo));
  const p = report.placebo;
  if (p) {
    out.push(`Placebo (P ran on ${p.ranOn.targets} of ${p.of.targets} scored targets and ${p.ranOn.controls} of ${p.of.controls} controls`
      + `${p.short.length ? `; its block showed fewer lessons than B's on ${titlesN(p.short.length)}` : ''}): ${p.reading}`);
  }
  out.push(...b.power.notPowered);
  if (!report.gating) {
    out.push('Not the fast tier: informational, the gates do not apply to this model.');
    return out;
  }
  const b1 = report.evaluations.find((e) => e.arm === 'B1');
  const s = report.evaluations.find((e) => e.arm === 'S');
  const brief = (e: TreatmentEval) =>
    `${e.arm}: G1 ${e.g1.verdict} (${e.g1.net >= 0 ? '+' : ''}${e.g1.net} titles net), G2 ${e.g2.pass ? 'pass' : 'FAIL'}, G3 ${e.g3.pass ? 'pass' : 'FAIL'}`;
  const g4 = report.g4.checked > 0 && report.g4.bad === 0;
  const g6 = report.latency?.gateG6.pass === true;
  if (!b.g2.pass || !b.g3.pass) {
    out.push(`B fails ${[!b.g2.pass && 'G2', !b.g3.pass && 'G3'].filter(Boolean).join(' and ')}. Rule: re-run with k: 1, then S; if both still fail, drop the hint half.`);
    if (b1) out.push(`  ${brief(b1)}`);
    if (s) out.push(`  ${brief(s)}`);
    const remedied = (b1 ? b1.g2.pass && b1.g3.pass : false) || (s ? s.g2.pass && s.g3.pass : false);
    out.push(remedied
      ? '  At least one remedy passes G2 and G3: the lead decides whether it is worth its change.'
      : '  Neither remedy passes G2 and G3: by the rule, do not ship the hint half.');
  } else if (b.g1.verdict.startsWith('INCONCLUSIVE')) {
    out.push(`B passes G2 and G3 but G1 is ${b.g1.verdict}: the rule has no verdict. Re-run with more runs or more titles before deciding.`);
  } else if (b.g1.verdict !== 'IMPROVED') {
    out.push(`B passes G2 and G3 but G1 is ${b.g1.verdict}. Rule: do not ship the hint half by default; arm N is the basis for a follow-up.`);
    if (report.narrow?.ran) out.push(`  Narrow question: ${JSON.stringify(report.narrow)}`);
  } else {
    out.push('B passes G1, G2 and G3.');
  }
  out.push(`G4 no-op: ${g4 ? 'PASS' : 'FAIL'} (${report.g4.checked} prompts compared with the stock prompt, ${report.g4.bad} differing).`);
  out.push(`G6 hint-read latency: ${report.latency ? (g6 ? 'PASS' : 'FAIL') : 'not measured'}.`);
  const shipReady = b.g1.verdict === 'IMPROVED' && b.g2.pass && b.g3.pass && g4 && g6;
  out.push(shipReady
    ? 'Every gate the ship rule names holds on the fast tier for B: the hint half may ship.'
    : 'Not every gate the ship rule names holds for B on the fast tier: capture ships, the hint half does not by default.');
  if (!shipReady) out.push(SHIPPED_STATE_NOTE);
  const c = report.evaluations.find((e) => e.arm === 'C');
  if (c) out.push(`Diagnostic, not part of the rule (C is the adjacent layout, the one B had in the first three runs): ${brief(c)}.`);
  if (s) {
    const edge = compareArms(records, report.model, 'B', 'S', report.flips.filter((f) => f.kind === 'target').map((f) => String(f.title)));
    out.push(`S against B on the scored targets: ${edge.baseCorrect} -> ${edge.treatCorrect} of ${edge.n} (${edge.net >= 0 ? '+' : ''}${edge.net} net; `
      + `"categories" an array on ${fmt1(report.shapes.B?.shape.arrayPct ?? NaN)}% of B's calls and ${fmt1(report.shapes.S?.shape.arrayPct ?? NaN)}% of S's). `
      + 'Flipping embedFn: null to {} needs a clear edge AND no latency or residency damage (see the residency block).');
  }
  return out;
}

const statText = (x: Stat): string => `p50 ${x.p50} / p95 ${x.p95} / max ${x.max} ms`;

function renderLatency(l: LatencyReport): string[] {
  const lim = GATES.hintReadMs;
  const lines = [
    `Latency (G6 gates the first line; the rest is reported, never gated):`,
    `  G6 ${l.gateG6.pass ? 'PASS' : 'FAIL'}  hint read (the two classificationHint calls, production arguments, n=${l.gateG6.n}): `
      + `with an index p50 ${fmt1(l.gateG6.withP50)} ms (limit ${lim.withP50}), p95 ${fmt1(l.gateG6.withP95)} ms (limit ${lim.withP95}); `
      + `without an index p95 ${fmt1(l.gateG6.withoutP95)} ms (limit ${lim.withoutP95})`,
  ];
  for (const [k, v] of Object.entries(l.routeWallMs)) lines.push(`  POST /api/tasks/quick/parse wall time, ${k}: ${statText(v)}`);
  for (const [k, v] of Object.entries(l.routeModelMs)) lines.push(`    of which the model call, ${k}: ${statText(v)}`);
  lines.push(`  median wall-time difference, B minus no-index: ${l.medianDifferenceMs} ms (confounded by model jitter and the longer prompt)`);
  for (const [k, v] of Object.entries(l.split)) {
    lines.push(`  in-process split, ${k}: hint read ${statText(v.hintReadMs)} (of which embed ${statText(v.embedMsWithinHint)}); enrichQuick ${statText(v.enrichQuickMs)}`);
  }
  return lines;
}

function renderResidency(r: ResidencyReport): string[] {
  const lines = [`Residency (GET /api/ps after every call; a reload is a generate call slower than ${GATES.reloadFactor}x the warm median of ${r.warmMedianGenerateMs} ms):`];
  for (const [arm, v] of Object.entries(r.perArm)) {
    const sets = Object.entries(v.residentSets).map(([set, n]) => `${set} x${n}`).join('; ');
    lines.push(`  ${arm.padEnd(3)} ${v.slowerThanThreeTimesWarmMedian}/${v.of} calls slower than ${GATES.reloadFactor}x median`
      + `${v.slowest.length ? ` (slowest ${v.slowest.map((c) => `${c.ms} ms`).join(', ')})` : ''}; resident: ${sets}`);
  }
  lines.push(`  arm S calls whose embed ran into the ${EMBED_TIMEOUT_MS} ms timeout (retrieval fell back to frequency): ${r.similarityEmbedTimeouts}`);
  const two = r.twoModelsResident;
  if (!two.ran) lines.push(`  S with both generation models resident: not run (${two.why})`);
  else {
    lines.push(`  S with ${two.fast} and ${two.partner} resident beforehand (${(two.residentBefore ?? []).join(' + ')}), n=${two.steps?.length}: `
      + `embed ${statText(two.embedMs!)}; generate ${statText(two.generateMs!)}; `
      + `${two.generateSlowerThanThreeTimesWarmMedian} generate calls slower than ${GATES.reloadFactor}x the warm median; resident sets seen: ${(two.residentSetsSeen ?? []).join(' | ')}`);
  }
  return lines;
}

function printReport(report: ModelReport): void {
  const lines: string[] = [`\n--- ${report.model}: results (${RUNS} runs per title and arm) ---`];
  lines.push(`Scored targets: ${report.flips.filter((f) => f.kind === 'target').length} titles; controls: ${CONTROL_ITEMS.length}. A0 is the pre-training baseline on all 12 targets.`);
  lines.push(
    'Layouts: B, S, B1 and P put the hint blocks last (after the never-invent line, before Entry:), the shipped layout; '
      + 'C is the adjacent layout (blocks beside their fields), a non-gating diagnostic.',
    'arm  targets  controls  validJSON  allKeys  catArray  empty  err  meanMs  p95Ms',
  );
  for (const r of report.summary) {
    lines.push(`${String(r.arm).padEnd(4)} ${String(r.targets).padEnd(8)} ${String(r.controls).padEnd(9)} ${String(r.validJsonPct).padEnd(10)} ${String(r.allKeysPct).padEnd(8)} `
      + `${String(r.categoriesArrayPct).padEnd(9)} ${String(r.empty).padEnd(6)} ${String(r.errored).padEnd(4)} ${String(r.meanMs).padEnd(7)} ${r.p95Ms}`);
  }
  // An arm that ran on fewer titles is scored out of the titles it ran on; say so, so x/n is not read as x/12.
  for (const r of report.summary.filter((s) => s.partial)) {
    lines.push(`  ${r.arm} ran on ${r.targetsRan} of ${r.targetsOf} scored targets and ${r.controlsRan} of ${r.controlsOf} controls: its targets and controls figures `
      + 'are out of those titles, and a title it never ran on is absent, not counted as a miss.');
  }
  if (report.hintChars) lines.push(`Prompt growth per hinted prompt (mean): ${report.hintChars.category} chars for the category hint, ${report.hintChars.motivation} for motivation.`);
  lines.push('', ...renderShape(report));
  lines.push('', "Per title (run string > majority; T = the owner's value first):");
  for (const f of report.flips) {
    lines.push(`  [${String(f.convention ?? 'control').padEnd(17)}] ${String(f.title).padEnd(44)} -> ${String(f.expected).padEnd(13)} `
      + ARMS_REPORTED.filter((k) => k !== 'A0' && f[k] !== '-').map((k) => `${k} ${f[k]}`).join('  ')
      + `   (A said ${f.pickA ?? '-'}, B said ${f.pickB ?? '-'})`);
  }
  lines.push('', 'Gates (fast tier only; the other models are informational):');
  for (const e of report.evaluations) lines.push(...renderEval(e));
  if (report.placebo) lines.push('', ...renderPlacebo(report));
  if (report.narrow) lines.push('', `Narrow question (diagnostic): ${JSON.stringify(report.narrow)}`);
  if (report.latency) lines.push('', ...renderLatency(report.latency));
  if (report.residency) lines.push('', ...renderResidency(report.residency));
  lines.push('', 'Reading the pre-registered rule:', ...report.reading.map((l) => `  ${l}`));
  say(lines.join('\n'));
}

/**
 * "B vs P +N of n titles (P ran on n of N scored targets[; P's block short of B's lesson count on k])":
 * the net carries the n it is out of, as G1's figure in the same line does, and how much of the
 * scored set P covered.
 */
function bVsPNote(p: PlaceboReport): string {
  const c = p.targets.bVsP;
  return `B vs P ${c.net >= 0 ? '+' : ''}${c.net} of ${c.n} titles (P ran on ${p.ranOn.targets} of ${p.of.targets} scored targets`
    + `${p.short.length ? `; P's block short of B's lesson count on ${titlesN(p.short.length)}` : ''})`;
}

/** One line per model for the end of the run: where each pre-registered gate landed. */
function verdictLine(r: ModelReport): string {
  if (r.status !== 'ran') return `[live-hint] ${r.model}: ${r.status}${r.note ? ` (${r.note})` : ''}`;
  const b = r.evaluations.find((e) => e.arm === 'B');
  if (!b) return `[live-hint] ${r.model}: no B arm was recorded`;
  const tag = r.gating ? 'FAST TIER' : 'informational';
  // Annotations only: they never change a registered verdict, they say how far it can be read.
  const aPct = r.shapes.A?.shape.arrayPct ?? NaN;
  const notes = [
    r.baselineShape?.unusable ? `INCONCLUSIVE: UNUSABLE ANSWER SHAPE (baseline A0 array ${fmt1(r.baselineShape.a0.arrayPct)}%)` : '',
    shapeShifted(aPct, r.shapes.B?.shape.arrayPct ?? NaN) ? `B moved the array share ${fmt1(aPct)}% -> ${fmt1(r.shapes.B?.shape.arrayPct ?? NaN)}%` : '',
    r.placebo?.ran ? bVsPNote(r.placebo) : '',
    b.power.notPowered.length ? `NOT POWERED: ${[b.power.g2FlippableControls < DIAGNOSTICS.minFlippableControls && 'G2', !(b.power.g3BaseKeysPct >= DIAGNOSTICS.minBaselineKeyCoveragePct) && 'G3'].filter(Boolean).join(', ')}` : '',
  ].filter(Boolean);
  return `[live-hint] ${r.model} (${tag}) B: G1 ${b.g1.verdict} (${b.g1.net >= 0 ? '+' : ''}${b.g1.net} of ${b.g1.n} titles, minimum detectable one title) | `
    + `G2 ${b.g2.pass ? 'PASS' : 'FAIL'} (${b.g2.flipped.length} flipped) | G3 ${b.g3.pass ? 'PASS' : 'FAIL'} | `
    + `G4 ${r.g4.bad === 0 && r.g4.checked > 0 ? 'PASS' : 'FAIL'} (${r.g4.checked} asserted) | G5 ${b.g5.pass ? 'PASS' : 'FAIL'} | `
    + `G6 ${r.latency ? (r.latency.gateG6.pass ? 'PASS' : 'FAIL') : 'not measured'}`
    + (notes.length ? ` || ${notes.join(' | ')}` : '');
}

// ── The suite ─────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE)('classification hint · live measurement', () => {
  beforeAll(async () => {
    expect(MODELS.length, 'LIVE_HINT_MODELS names no model').toBeGreaterThan(0);
    // vitest sets NODE_ENV=test, which stops ollama.status() from filling the installed
    // cache, so do it here: with the cache filled, resolveModel() performs the SAME
    // auto-selection production does, and embedReady() can answer. (It is not what the
    // production hint path uses: enrichEntry passes embedFn: null, which never asks.)
    const res = await fetch(`${config.ollamaUrl}/api/tags`);
    const data = (await res.json()) as {
      models?: { name: string; capabilities?: string[]; details?: { parameter_size?: string } }[];
    };
    const installed = (data.models ?? []).map((m) => ({
      name: m.name, capabilities: m.capabilities ?? [], paramB: parseParamB(m.details?.parameter_size),
    }));
    setInstalledModels(installed);
    for (const m of installed) caps.set(m.name, m.capabilities);
    try {
      ollamaVersion = ((await (await fetch(`${config.ollamaUrl}/api/version`)).json()) as { version?: string }).version ?? '';
    } catch { /* the version is a note, not a precondition */ }

    // The empty-response trap: no model under test may be thinking-capable. And the first
    // is the fast tier the app resolves, because that is the only model that gates.
    for (const model of MODELS) {
      const picked = matchInstalled(model);
      expect(picked, `${model} is not installed`).toBeTruthy();
      expect(picked!.capabilities, `${model} is thinking-capable`).not.toContain('thinking');
      say(`[live-hint] ${model} resolves to ${picked!.name} (caps: ${picked!.capabilities.join(',') || 'none listed'})`);
    }
    const fast = await resolveModel('fast');
    expect(matchInstalled(fast)?.name, `LIVE_HINT_MODELS[0] must be the fast tier the app resolves (${fast}): it is the only model that gates`)
      .toBe(matchInstalled(MODELS[0])?.name);
    const embedModel = await resolveEmbedModel();
    haveEmbedder = matchInstalled(embedModel) !== null;
    say(`[live-hint] fast tier ${fast}; embedder ${embedModel} ${haveEmbedder ? 'installed' : 'NOT installed: arm S and the similarity retrieval are skipped'}; `
      + `Ollama ${ollamaVersion || 'unknown version'}, OLLAMA_MAX_LOADED_MODELS in this process: ${process.env.OLLAMA_MAX_LOADED_MODELS ?? 'unset'} `
      + '(the test process only: the server\'s own value is not visible from here)');

    // Provenance: how the fast tier resolved, what started the run, what code it ran.
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
    say(`[live-hint] ${note}`);
    say(`[live-hint] command: ${start.command} (${start.source})`);
    expect(fixtureProblems()).toEqual([]);
    srv = await startTestServer();
  });

  afterAll(async () => {
    await srv?.close();
  });

  for (const [i, model] of MODELS.entries()) {
    it(
      `${model}: capture, calibrate, arms${i === 0 ? ', latency and residency' : ''}`,
      async () => {
        await runModel(model, i === 0, MODELS[1]);
      },
      6 * 60 * 60_000,
    );
  }

  it('the mechanism held on every call (the effect sizes are reported, never asserted)', () => {
    flush();
    say(`\n[live-hint] ${records.length} model calls recorded${OUT ? `, artifact at ${OUT}` : ' (set LIVE_HINT_OUT to keep them)'}.`);
    for (const r of reports) say(verdictLine(r));
    expect(violations, `mechanism violations:\n${violations.join('\n')}`).toEqual([]);
    expect(reports.length, 'no model ran').toBe(MODELS.length);
  });
});
