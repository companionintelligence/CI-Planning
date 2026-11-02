/**
 * Live measurement harness for the classification hint in quick-add (follow-up to the
 * learning-loop audit of 2026-11-02). It settles whether the hint half of that change
 * ships; the write-up goes in docs/classification-hint-measurement-2026-11.md, in the
 * shape of docs/complexity-rubric-measurement-2026-08.md.
 *
 * OPT-IN ONLY: inert unless `LIVE_HINT=1`, because it needs a running Ollama with the
 * models named below and the embedder, and takes tens of minutes (about 1,000 model calls
 * per model, the 0.5B tier in minutes, the 4B-class tier in the better part of an hour).
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
 *                     sha256 prefix, hint present, retrieval ids, raw completion, parsed
 *                     pick, correct, ms), plus the report, the distinct prompts and the
 *                     latency and residency numbers. Rewritten as the run proceeds.
 *   Offline self-check of the pure helpers below, no Ollama and no model time:
 *   LIVE_HINT=1 ./node_modules/.bin/vitest run test/classification-hint-live.test.ts -t "pure helpers"
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
 * A, B, C, S, A2 so warm-up drift cannot favour one arm:
 *   A   baseline: enrichQuick(text, parse, vocab) with no hints (today's prompt)
 *   A2  a repeat of A: the noise floor
 *   B   SHIPPED: POST /api/tasks/quick/parse through the real route (frequency hints, accept filter)
 *   C   B's captured prompt with the hint blocks moved to just before 'Entry:' (hint last).
 *       NON-GATING diagnostic, so a null result can be explained.
 *   S   classificationHint with the real embedder injected (similarity), for the record
 *   B1  B with k: 1; runs only when B fails G2 or G3 (the named remedy)
 *   N0  the narrow one-field question exactly as services/classification-score.ts sends it,
 *       with no hint; N the same with B's hint. Both run only when B shows no gain on the
 *       targets, to see whether the width of the wide prompt is what dilutes the hint.
 *       (N0 is an addition to the plan: without it a gain of N over A could be the narrow
 *       prompt rather than the hint.)
 *   A0  not an arm of the comparison: the pre-training baseline on the targets that decides headroom.
 *
 * METRICS. First-category accuracy, per model and arm, on TARGET titles and on CONTROL
 * titles, as per-ITEM majority over RUNS (strict: more than half the runs; at temperature
 * 0.1 the runs are near-identical, so titles, not trials, are the sample). Valid-JSON rate
 * (strict JSON.parse) and presence of every requested key. A per-title flip table (the
 * per-run string, then the majority: A FFTTT then B TTTTT). Wins (A wrong, B right) and
 * losses (A right, B wrong). The A-versus-A2 flips. Prompt growth in characters.
 * Retrieval precision@1 and @k (does the top lesson carry the owner's value for this
 * title; a property of the fixture and the retrieval mode, no generation model involved).
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
 * DECISION RULE (the ship rule, restated; the lead decides, the harness only reads it off).
 * Capture ships regardless. The hint half ships only if on the fast tier G2, G3 and G4 hold
 * AND G1 holds. G2 or G3 fails: re-run B with k: 1 (arm B1), then S; if both still fail,
 * drop the hint half. G1 fails with G2 and G3 passing: do not ship the hint half by default,
 * and put arm N in the evidence doc as the basis for a follow-up. If S shows a clear
 * accuracy edge over B AND no latency or residency damage, flip { embedFn: null } to {} in
 * enrichEntry and cite the doc.
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
 * model follow a vocabulary it is shown, not how often real owners correct anything. A call
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
 * a retrieval and in the right place, none in any A/A2/A0/N0 prompt, removing the hints from
 * a B prompt gives the stock prompt, the no-index prompts are byte-identical, the capture
 * wrote the rows it should. REPORTED, never asserted: every effect size, every gate verdict,
 * and any empty or errored completion in a hinted arm (that is G3's finding, and asserting it
 * would abort the very verdict the gate exists to give).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
// Installs the SQLite store; model resolution reads the per-owner Settings override.
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { parseQuick } from '../src/engine/quickadd.js';
import { enrichQuick, type QuickHints } from '../src/agents/quickadd.js';
import { constrainToVocabulary } from '../src/agents/constrain.js';
import { MOTIVATION_VALUES } from '../src/agents/rubric.js';
import { generateJson, generate, embed, parseJsonLoose } from '../src/mcp/ollama.js';
import {
  setInstalledModels, parseParamB, resolveModel, resolveEmbedModel, matchInstalled,
} from '../src/lib/models.js';
import { suggestibleVocabulary, type TagVocabulary } from '../src/services/tags.js';
import { ollamaScorer } from '../src/services/classification-score.js';
import {
  calibrateClassification, classificationHint, classificationInput, retrieveExemplars,
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
}));

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return {
    ...real,
    // Same call, but the model under test is injected and the prompt and the raw
    // completion are retained before parsing. In dry mode nothing reaches Ollama.
    generateJson: async (prompt: string, opts: Parameters<typeof real.generate>[1] = {}) => {
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

const LATENCY_N = 30;
const PROBE_N = 10;

// ── Pure helpers ──────────────────────────────────────────────────────────────

type Arm = 'A0' | 'A' | 'A2' | 'B' | 'C' | 'S' | 'B1' | 'N0' | 'N';
type Verdict =
  | 'IMPROVED' | 'HARMED' | 'NO MEASURABLE CHANGE' | 'INCONCLUSIVE: NO HEADROOM' | 'INCONCLUSIVE: NOISE';

/** The keys enrichQuick's prompt asks for (categories included: the owner has them). */
const WIDE_KEYS = [
  'direction', 'isComplex', 'priority', 'estimatedMinutes', 'timeOfDay', 'timeOfDayReason',
  'motivation', 'categories', 'tags',
] as const;
const NARROW_KEYS = ['categories'] as const;
/** The first line of exemplarPrompt's block; every hint contains it exactly once. */
const HINT_MARKER = 'This user has corrected you before.';

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
  pick: string | null;
  correct: boolean;
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
 * violation instead of as a quietly different experiment.
 */
function choosable(allowed: readonly string[]): (e: Exemplar) => boolean {
  const set = new Set(allowed.map((a) => a.toLowerCase()));
  return (e) => {
    const names = e.correctValue.split(',').map((n) => n.trim()).filter(Boolean);
    return names.length > 0 && names.every((n) => set.has(n.toLowerCase()));
  };
}

/** The prompt with each hint block (the hint plus the one newline enrichQuick adds) taken out. */
function withoutHints(prompt: string, hints: readonly string[]): string {
  let bare = prompt;
  for (const h of hints) {
    if (!h) continue;
    const block = `${h}\n`;
    const at = bare.indexOf(block);
    if (at < 0 || bare.indexOf(block, at + 1) >= 0) throw new Error('withoutHints: the hint block is not in the prompt exactly once');
    bare = bare.slice(0, at) + bare.slice(at + block.length);
  }
  return bare;
}

/** Arm C: the same prompt with the hint blocks moved from beside their fields to just before `Entry:`. */
function hintLast(prompt: string, hints: readonly string[]): string {
  const bare = withoutHints(prompt, hints);
  const entryAt = bare.lastIndexOf('\nEntry: "') + 1;
  if (entryAt <= 0) throw new Error('hintLast: no Entry: line in the prompt');
  return bare.slice(0, entryAt) + hints.filter(Boolean).join('') + bare.slice(entryAt);
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
    promptSha: '', hintPresent: false, retrievalIds: [], raw: '{}', pick: correct ? 'leisure' : 'health', correct,
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

  it('hints go in once, come out again, and move to the end for arm C', () => {
    const hintA = '\nThis user has corrected you before. Follow their vocabulary, not your own:\n- For "x" you said a; the user chose b.\n';
    const hintB = '\nThis user has corrected you before. Follow their vocabulary, not your own:\n- For "y" you said c; the user chose d.\n';
    const stock = '"motivation": m\n"categories": c\n"tags": t\nChoose ONLY from the lists.\nEntry: "gym"';
    const hinted = '"motivation": m\n' + `${hintA}\n` + '"categories": c\n' + `${hintB}\n` + '"tags": t\nChoose ONLY from the lists.\nEntry: "gym"';
    expect(occurrences(hinted, HINT_MARKER)).toBe(2);
    expect(withoutHints(hinted, [hintA, hintB])).toBe(stock);
    expect(withoutHints(stock, [''])).toBe(stock);
    expect(() => withoutHints(stock, [hintA])).toThrow();
    const last = hintLast(hinted, [hintA, hintB]);
    expect(last.endsWith(`${hintA}${hintB}Entry: "gym"`)).toBe(true);
    expect(last.replace(hintA + hintB, '')).toBe(stock); // moved, nothing else changed
    expect(last.indexOf(hintA)).toBeGreaterThan(last.indexOf('Choose ONLY'));
    expect(occurrences(last, hintA)).toBe(1);
    expect(hintLast(stock, ['', ''])).toBe(stock); // nothing to move
  });

  it('choosable keeps only lessons whose every value the model may still answer with', () => {
    const ok = choosable(['Health', 'leisure']);
    const e = (correctValue: string): Exemplar => ({ logId: 'l', inputText: 't', llmValue: 'x', correctValue });
    expect(ok(e('health'))).toBe(true);
    expect(ok(e('leisure, health'))).toBe(true);
    expect(ok(e('leisure, finance'))).toBe(false);
    expect(ok(e(''))).toBe(false);
    expect(ok(e('career'))).toBe(false);
  });

  it('the fixture is well formed against the real parser', () => {
    expect(fixtureProblems()).toEqual([]);
    expect(TRAIN_ITEMS).toHaveLength(18);
    expect(TARGET_ITEMS).toHaveLength(12);
    expect(CONTROL_ITEMS).toHaveLength(12);
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
interface ModelReport {
  model: string;
  gating: boolean;
  status: 'ran' | 'INCONCLUSIVE: NO HEADROOM';
  note: string;
  baseline: BaselineRow[];
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
  const sha = sha12(prompt);
  if (prompt) distinctPrompts.set(sha, prompt);
  const r: CallRecord = {
    arm, model, title: item.title, kind: item.kind === 'control' ? 'control' : 'target',
    convention: item.convention, expected: item.expected, run,
    promptSha: sha, hintPresent: occurrences(prompt, HINT_MARKER) > 0, retrievalIds: opts.retrievalIds ?? [],
    raw, pick, correct: pick !== null && pick.toLowerCase() === item.expected.toLowerCase(),
    validJson: strict !== null, allKeys: strict !== null && keys.every((k) => k in strict!),
    empty: raw.trim() === '', error: opts.error ?? seam?.error ?? null, ms: seam?.ms ?? NaN,
    embedMs: opts.embedMs ?? null,
  };
  records.push(r);
  return r;
}

/**
 * Where a hint must sit in the prompt that carries it, and that nothing else was added.
 * 'adjacent' is enrichQuick's layout (beside the field it governs), 'last' is arm C's.
 */
function checkPrompt(
  model: string, arm: Arm, item: FixtureItem, prompt: string, hints: Hints | null, layout: 'adjacent' | 'last' | 'narrow',
): void {
  const label = `${arm} "${item.title}"`;
  const markers = occurrences(prompt, HINT_MARKER);
  if (hints === null) {
    if (markers !== 0) violate(model, `${label}: a hint reached a prompt that must have none`);
    return;
  }
  const expected = (hints.category ? 1 : 0) + (hints.motivation ? 1 : 0);
  if (markers !== expected) violate(model, `${label}: ${markers} hint blocks in the prompt, expected ${expected}`);
  for (const [field, hint] of [['motivation', hints.motivation], ['category', hints.category]] as const) {
    if (!hint) continue;
    if (occurrences(prompt, hint) !== 1) { violate(model, `${label}: the ${field} hint is not in the prompt exactly once`); continue; }
    const at = prompt.indexOf(hint);
    if (layout === 'adjacent') {
      const after = prompt.indexOf(field === 'category' ? '"categories":' : '"motivation":');
      const before = prompt.indexOf(field === 'category' ? '"tags":' : '"categories":');
      if (!(after >= 0 && after < at && at < before)) violate(model, `${label}: the ${field} hint is not beside its field`);
    } else if (layout === 'last') {
      if (!(at > prompt.lastIndexOf('never invent') && at < prompt.lastIndexOf('Entry: "'))) {
        violate(model, `${label}: the ${field} hint is not just before Entry:`);
      }
    }
  }
  if (layout !== 'narrow' && !prompt.endsWith(`Entry: "${item.title}"`)) violate(model, `${label}: the prompt does not end with the entry`);
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
      checkPrompt(model, 'B', item, viaRoute, hints, 'adjacent');
      const stock = stockPrompts.get(text);
      try {
        if (stock !== undefined && withoutHints(viaRoute, [hints.motivation, hints.category]) !== stock) {
          violate(model, `${label}: "${text}" taking the hints out does not give the stock prompt (not additive)`);
        }
      } catch (err) {
        violate(model, `${label}: "${text}" ${(err as Error).message}`);
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
    checkPrompt(ctx.model, 'B', item, seam.prompt, hints, 'adjacent');
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

/** C: B's own prompt with the hint blocks moved to the end, sent straight to the seam. */
async function viaHintLast(ctx: Ctx, item: FixtureItem, run: number, bPrompt: string, hints: Hints): Promise<CallRecord | null> {
  if (!bPrompt) return null;
  let prompt: string;
  try {
    prompt = hintLast(bPrompt, [hints.motivation, hints.category]);
  } catch (err) {
    violate(ctx.model, `C "${item.title}": ${(err as Error).message}`);
    return null;
  }
  const { calls, thrown } = await seamOf(() => generateJson(prompt, { purpose: 'classify' }));
  const seam = calls.find((c) => !c.dry);
  if (seam) {
    checkPrompt(ctx.model, 'C', item, seam.prompt, hints, 'last');
    // Moved, not changed: take the blocks out again and it is the stock prompt.
    const stock = stockPrompts.get(item.title);
    if (stock !== undefined && seam.prompt.replace(hints.motivation + hints.category, '') !== stock) {
      violate(ctx.model, `C "${item.title}": moving the hints to the end changed something else in the prompt`);
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
  if (prompt) checkPrompt(ctx.model, 'S', item, prompt, hints, 'adjacent');
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

const armLine = (model: string, arm: Arm, scored: readonly string[], controls: readonly string[]): Record<string, unknown> | null => {
  const calls = armCalls(records, model, arm);
  if (calls.length === 0) return null;
  const s = schemaStats(calls);
  const score = (titles: readonly string[]) => titles.filter((t) => majorityCorrect(flagsFor(records, model, arm, t))).length;
  const ms = calls.map((c) => c.ms).filter(Number.isFinite);
  return {
    arm, calls: s.n, targets: `${score(scored)}/${scored.length}`, controls: `${score(controls)}/${controls.length}`,
    validJsonPct: Number(fmt1(s.validJsonPct)), allKeysPct: Number(fmt1(s.allKeysPct)), empty: s.empty, errored: s.errored,
    meanMs: Number(fmt0(ms.reduce((a, b) => a + b, 0) / (ms.length || NaN))), p95Ms: Number(fmt0(percentile(ms, 95))),
  };
};

const cell = (model: string, arm: Arm, title: string): string => flipCell(records, model, arm, title);

function renderEval(e: TreatmentEval): string[] {
  const { g1, g2, g3, g5 } = e;
  const signed = (x: number) => (x >= 0 ? `+${x}` : `${x}`);
  const lines = [
    `  ${e.arm} vs A`,
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
    `    G3 schema safety    ${g3.pass ? 'PASS' : 'FAIL'}: valid JSON ${fmt1(g3.base.validJsonPct)}% -> ${fmt1(g3.treat.validJsonPct)}%, `
      + `all keys ${fmt1(g3.base.allKeysPct)}% -> ${fmt1(g3.treat.allKeysPct)}%, empty ${g3.base.empty} -> ${g3.treat.empty}, errored ${g3.base.errored} -> ${g3.treat.errored}`,
    `    G5 loop             ${g5.pass ? 'PASS' : 'FAIL'}: the owner's value ${fmt1(g5.baseShare)}% -> ${fmt1(g5.treatShare)}% of scored targets`,
  );
  return lines;
}

function flush(): void {
  if (!OUT) return;
  const artifact = {
    harness: 'classification-hint-live',
    startedAt, writtenAt: new Date().toISOString(),
    command: `LIVE_HINT=1 LIVE_HINT_RUNS=${RUNS} LIVE_HINT_MODELS=${MODELS.join(',')} LIVE_HINT_OUT=${OUT} vitest run test/classification-hint-live.test.ts`,
    env: { runs: RUNS, models: MODELS, ollamaUrl: config.ollamaUrl, ollamaVersion, maxLoadedModels: process.env.OLLAMA_MAX_LOADED_MODELS ?? null },
    gates: GATES,
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
    model, gating, status: 'ran', note: '', baseline: [], capture: null, index: null, hintChars: null,
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
      checkPrompt(model, 'A0', item, prompt, null, 'adjacent');
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
  say('Baseline on the targets, before any evidence (a convention at or above 75% is not scored):');
  for (const b of report.baseline) {
    say(`  ${b.convention.padEnd(18)} ${b.correct}/${b.n} = ${fmt0((100 * b.correct) / b.n)}%  ${b.headroom ? 'headroom' : 'INCONCLUSIVE: NO HEADROOM'}`);
    for (const [title, c] of Object.entries(b.perTitle)) say(`      ${c.padEnd(8)} ${title}`);
  }
  const scoredConventions = report.baseline.filter((b) => b.headroom).map((b) => b.convention);
  if (scoredConventions.length === 0) {
    report.status = 'INCONCLUSIVE: NO HEADROOM';
    report.note = 'the model already files every convention the way the owner does; nothing to teach';
    say(`INCONCLUSIVE: NO HEADROOM (${report.note})`);
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
  const capture: CaptureStats = { parsed: 0, claims: 0, noClaim: 0, exact: 0, firstMatch: 0, corrections: 0 };
  report.capture = capture;
  const queues = CONVENTIONS.filter((c) => scoredConventions.includes(c.id)).map((c) => TRAIN_ITEMS.filter((t) => t.convention === c.id));
  const order: FixtureItem[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) order.push(q[i]);
  for (const item of order) {
    const { value: parsed, calls } = await seamOf(() => parseViaRoute(item.title));
    capture.parsed++;
    const seam = calls.find((c) => !c.dry);
    if (seam) checkPrompt(model, 'A', item, seam.prompt, null, 'adjacent'); // no index yet: no hint
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
  say(`Capture: ${capture.parsed} titles parsed, ${capture.claims} claims echoed (${capture.noClaim} with none: the model abstained or did not answer), `
    + `${capture.exact} exactly the owner's value, ${capture.firstMatch} with the owner's value first, ${capture.corrections} corrections written. `
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
    report.status = 'INCONCLUSIVE: NO HEADROOM';
    report.note = `only ${report.index.corrections} corrections (the floor is ${CORRECTION_FLOOR}) from ${capture.claims} claims on ${capture.parsed} training titles `
      + `(${capture.noClaim} produced no claim): there is no evidence to learn from`;
    say(`INCONCLUSIVE: NO HEADROOM (${report.note})`);
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
  const t0 = Date.now();
  for (const item of armItems) {
    const hints = hintFor.get(item.title)!;
    for (let run = 0; run < RUNS; run++) {
      const a = await viaEnrich('A', ctx, item, run);
      checkPrompt(model, 'A', item, a.prompt, null, 'adjacent');
      const b = await viaRoute(ctx, item, run, hints);
      await viaHintLast(ctx, item, run, b.prompt, hints);
      if (haveEmbedder) await viaSimilarity(ctx, item, run);
      const a2 = await viaEnrich('A2', ctx, item, run);
      checkPrompt(model, 'A2', item, a2.prompt, null, 'adjacent');
      for (const r of [a.record, a2.record]) if (r.empty) violate(model, `${r.arm} "${item.title}" run ${run}: empty or errored completion ${r.error ?? ''}`);
    }
    flush();
  }
  say(`Arms A, B, C${haveEmbedder ? ', S' : ''}, A2 done: ${armItems.length} titles x ${RUNS} runs in ${Math.round((Date.now() - t0) / 1000)} s.`);

  let evalB = evaluateTreatment(records, model, 'B', scoredTitles, controlTitles);

  // The named remedy: B with k: 1, only when B fails over-application or schema safety.
  if (!evalB.g2.pass || !evalB.g3.pass) {
    say(`B fails ${[!evalB.g2.pass && 'G2', !evalB.g3.pass && 'G3'].filter(Boolean).join(' and ')}: running arm B1 (k: 1).`);
    for (const item of armItems) {
      const hints = await prodHints(OWNER, vocab, item.title, 1);
      for (let run = 0; run < RUNS; run++) {
        const { prompt } = await viaEnrich('B1', ctx, item, run, hints, { retrievalIds: idsOf(await retrieveFor('frequency', item.title, vocab, 1)) });
        checkPrompt(model, 'B1', item, prompt, hints, 'adjacent');
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
  for (const arm of ['A0', 'A', 'A2', 'B', 'C', 'S', 'B1', 'N0', 'N'] as Arm[]) {
    const line = armLine(model, arm, arm === 'A0' ? TARGET_ITEMS.map((t) => t.title) : scoredTitles, arm === 'A0' ? [] : controlTitles);
    if (line) report.summary.push(line);
  }
  for (const item of armItems) {
    report.flips.push({
      title: item.title, kind: item.kind, convention: item.convention, expected: item.expected,
      ...Object.fromEntries((['A', 'A2', 'B', 'C', 'S', 'B1', 'N0', 'N'] as Arm[]).map((arm) => [arm, cell(model, arm, item.title)])),
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
  for (const arm of ['A', 'B', 'C', 'S', 'A2', 'B1', 'N0', 'N'] as Arm[]) {
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

function readOff(report: ModelReport): string[] {
  const out: string[] = [];
  const b = report.evaluations.find((e) => e.arm === 'B');
  if (!b) return out;
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
  if (s) {
    const edge = compareArms(records, report.model, 'B', 'S', report.flips.filter((f) => f.kind === 'target').map((f) => String(f.title)));
    out.push(`S against B on the scored targets: ${edge.baseCorrect} -> ${edge.treatCorrect} of ${edge.n} (${edge.net >= 0 ? '+' : ''}${edge.net} net). `
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
  lines.push('arm  targets  controls  validJSON  allKeys  empty  err  meanMs  p95Ms');
  for (const r of report.summary) {
    lines.push(`${String(r.arm).padEnd(4)} ${String(r.targets).padEnd(8)} ${String(r.controls).padEnd(9)} ${String(r.validJsonPct).padEnd(10)} ${String(r.allKeysPct).padEnd(8)} `
      + `${String(r.empty).padEnd(6)} ${String(r.errored).padEnd(4)} ${String(r.meanMs).padEnd(7)} ${r.p95Ms}`);
  }
  if (report.hintChars) lines.push(`Prompt growth per hinted prompt (mean): ${report.hintChars.category} chars for the category hint, ${report.hintChars.motivation} for motivation.`);
  lines.push('', "Per title (run string > majority; T = the owner's value first):");
  for (const f of report.flips) {
    lines.push(`  [${String(f.convention ?? 'control').padEnd(17)}] ${String(f.title).padEnd(44)} -> ${String(f.expected).padEnd(13)} `
      + (['A', 'A2', 'B', 'C', 'S', 'B1', 'N0', 'N'] as const).filter((k) => f[k] !== '-').map((k) => `${k} ${f[k]}`).join('  ')
      + `   (A said ${f.pickA ?? '-'}, B said ${f.pickB ?? '-'})`);
  }
  lines.push('', 'Gates (fast tier only; the other models are informational):');
  for (const e of report.evaluations) lines.push(...renderEval(e));
  if (report.narrow) lines.push('', `Narrow question (diagnostic): ${JSON.stringify(report.narrow)}`);
  if (report.latency) lines.push('', ...renderLatency(report.latency));
  if (report.residency) lines.push('', ...renderResidency(report.residency));
  lines.push('', 'Reading the pre-registered rule:', ...report.reading.map((l) => `  ${l}`));
  say(lines.join('\n'));
}

/** One line per model for the end of the run: where each pre-registered gate landed. */
function verdictLine(r: ModelReport): string {
  if (r.status !== 'ran') return `[live-hint] ${r.model}: ${r.status}${r.note ? ` (${r.note})` : ''}`;
  const b = r.evaluations.find((e) => e.arm === 'B');
  if (!b) return `[live-hint] ${r.model}: no B arm was recorded`;
  const tag = r.gating ? 'FAST TIER' : 'informational';
  return `[live-hint] ${r.model} (${tag}) B: G1 ${b.g1.verdict} (${b.g1.net >= 0 ? '+' : ''}${b.g1.net} of ${b.g1.n} titles, minimum detectable one title) | `
    + `G2 ${b.g2.pass ? 'PASS' : 'FAIL'} (${b.g2.flipped.length} flipped) | G3 ${b.g3.pass ? 'PASS' : 'FAIL'} | `
    + `G4 ${r.g4.bad === 0 && r.g4.checked > 0 ? 'PASS' : 'FAIL'} (${r.g4.checked} asserted) | G5 ${b.g5.pass ? 'PASS' : 'FAIL'} | `
    + `G6 ${r.latency ? (r.latency.gateG6.pass ? 'PASS' : 'FAIL') : 'not measured'}`;
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
      + `Ollama ${ollamaVersion || 'unknown version'}, OLLAMA_MAX_LOADED_MODELS in this process: ${process.env.OLLAMA_MAX_LOADED_MODELS ?? 'unset'}`);
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
