/**
 * Head-to-head for quick add: qwen2.5:3b against gemma3n:e4b (LIVE_H2H=1). PRE-REGISTERED 2026-11-02, written and committed
 * BEFORE its first live run. Do not edit a gate, a threshold or a rule after seeing a result; add a dated note under it.
 *
 * THE QUESTION. gemma3n:e4b (the quality model) is what quick add asks today. qwen2.5:3b learned from the owner's corrections
 * in the hint measurements (docs/quick-add-hint-learning-curve-2026-11.md, docs/quickadd-hint-guard-2026-11.md) and was faster,
 * by about 1.4 to 1.6 times, but on 12 natural titles it got 9 right against 12, named a valid direction 75% of the time against
 * 88 to 92%, and the two were a title apart on the combined score. Is qwen2.5:3b the better quick-add model, or a faster one
 * that is less accurate? This is a bigger comparison: more titles, more runs, the cost of the direction retry, a cold start, the
 * models taking turns on a two-slot server, and a second owner with conventions the first never saw.
 *
 * OPT-IN. Inert unless LIVE_H2H=1; needs Ollama with both models. No model is injected: the app resolves quick add's model
 * itself, the way an owner chooses it. gemma3n:e4b (the reference) runs with no override anywhere; qwen2.5:3b (the candidate) is
 * set as the owner's quality-tier model in Settings (scheduling_prefs.quality_model), which is how quick add would be given it
 * today, and the run asserts the app resolved it. The fast tier must resolve to qwen2.5:0.5b (it serves the mix probe).
 *
 *   cd server
 *   LIVE_H2H=1 LIVE_H2H_OUT=<out>/h2h-run-1.json ./node_modules/.bin/vitest run test/quickadd-model-h2h-live.test.ts --reporter=verbose
 *   Do not pin OLLAMA_FAST or OLLAMA_QUALITY. Do not run the server test suite during it (it skews latency).
 *   Env, read by this file only: LIVE_H2H (run), LIVE_H2H_OUT (per-call JSON artifact), LIVE_H2H_RUNS (runs per natural title, 6),
 *   LIVE_H2H_MODELS (candidate,reference; default qwen2.5:3b,gemma3n:e4b), LIVE_H2H_RESUME (an earlier artifact: phases a model
 *   already completed are kept and the others re-run; see the note under the gates). The pure parts run in every test run.
 *
 * WHAT RUNS, per model, in this order, through the REAL parse route (POST /api/tasks/quick/parse), owner as the app seeds it:
 *   A  NATURAL: 120 invented titles, 20 for each of the six categories, each with an obvious category (a dentist is health, an
 *      electricity bill is finance), no corrections and so no hint, x 6 runs. Scored by TITLE: a title is right when a strict
 *      majority of its 6 runs name the expected category first. Per call: route wall time, the first model call's time, how many
 *      model calls the route made (more than one is the direction retry), the categories returned, strict-JSON all nine keys,
 *      whether the direction names one of the owner's.
 *   C  COLD: 3 trials of: unload the model under test (POST /api/generate with keep_alive 0, then wait up to 15 s for GET /api/ps
 *      to stop listing it), then ONE route call. Default Ollama unloads an idle model after 5 minutes.
 *   M  MIX: 20 cycles of [a route parse] [one fast-tier generateJson, purpose brainstorm] [one embed], with GET /api/ps after
 *      every call, on a server with OLLAMA_MAX_LOADED_MODELS=2 (recorded in the write-up, not visible from here).
 *   B  LEARNING on a SECOND owner (conventions the first run never used), 18 training titles taken three conventions at a time,
 *      levels 0, 3, 6, 9, 12 and 18 corrections, as in the learning-curve measurement: to reach a level the new training titles
 *      go through the route (the model's own pick, with last week's hint if the guard allows it), then POST /api/tasks with the
 *      owner's category and the claim echoed, then one calibrateClassification; at each level the 18 target and 18 control titles
 *      x 3 runs are measured through the route. After level 18 the owner is reset to nothing learned and level 0 is measured
 *      again (the noise pass). Conventions: reading and podcasts go to growth (not leisure), volunteering and charity go to
 *      relationships (not career or leisure), cooking and meal prep go to health (not leisure). Controls are natural career,
 *      finance and leisure titles, near-misses included (a film beside the reading convention, a bill beside nothing).
 *
 * GATES (the candidate is qwen2.5:3b, the reference gemma3n:e4b):
 *   H1 ACCURACY   Of the 120 natural titles the candidate is right on at least as many as the reference minus 5 points (6
 *                 titles). INCONCLUSIVE: NOISE if, for either model, the runs 0 to 2 against the runs 3 to 5 move more than 8 titles.
 *   H2 SPEED      Over the route calls of A (the whole call, retry included, which is what the owner waits for): the candidate's
 *                 p50 is at most 0.75 of the reference's, and its p95 no higher than the reference's.
 *   H3 DIRECTION  The candidate's share of valid directions in A is at least the reference's minus 10 points. (The retry's cost is
 *                 in H2; the share and the cost per call are printed beside it.)
 *   H4 LEARNING   On the second owner the candidate: gains at least 3 of the 18 target titles from level 0 to level 18 (INCONCLUSIVE:
 *                 NOISE if level 0 against its repeat moves more than 3 target titles), loses at most 2 of the 18 controls, keeps all
 *                 nine keys within 5 points and a valid direction within 10 points of level 0, AND is right on at least as many of
 *                 the 36 titles at level 18 as the reference minus 3.
 *   H5 COLD       Each of the candidate's 3 cold calls ran the model overlay inside the 15 s ceiling, and the median is no slower than
 *                 the reference's median.
 *   H6 RESIDENCY  In the candidate's MIX, at most 10% of the route calls take longer than 3 x its warm A p50, and every one ran the
 *                 overlay.
 *   Reported, never gated: accuracy by category; the retry share and the extra milliseconds per call; the whole learning curve of both;
 *   the reference's own gates for comparison.
 * RULE (the lead decides; the harness reads it off and prints each line).
 *   D1  H1 to H6 all PASS: the candidate is the better quick-add model on every axis tested; recommended.
 *   D2  H2 PASSES and H1 or H4 does not: a speed-for-accuracy trade, not an improvement. The reference stays the default; the
 *       candidate is at most an opt-in, and the owner decides.
 *   D3  H2 does not pass: no reason to move.
 *   D4  Otherwise (faster, as accurate, learns, but H3, H5 or H6 fails): say which, with the numbers.
 * NOT SHOWN, whatever the result: one box (AMD Strix Halo, unified memory, a shared machine), the labels of the 120 titles are
 * my judgement of "obvious" (an ambiguous title would move both models alike), two invented owners, temperature 0.1, the two
 * models only (not gemma3:4b or any other), the quality of the fields other than category, and what setting qwen2.5:3b as the
 * quality model would do to briefings, extraction and the planning judge (it would change them too; see the write-up).
 *
 * NOTES ADDED AFTER THE FIRST RUN (2026-11-02, 22:53 to 23:48 PST). Nothing below edits a gate, a threshold or the rule.
 *   - The first run died in the candidate's MIX phase: the fast-tier probe call hit its 20 s ceiling in cycle 4 (the Ollama server
 *     is shared and was loaded), the probe was not guarded, and the whole model run threw. For qwen2.5:3b that left A (720 calls)
 *     and COLD (3) complete, MIX at 4 of 20 cycles and B not run; the reference completed every phase. The probes now record a
 *     failed probe (`llm: false`) instead of throwing, and LIVE_H2H_RESUME=<artifact> re-runs only the phases a model has not
 *     completed (a half-finished phase is discarded, not kept), so the candidate's MIX and B were run from the first artifact
 *     and every other number is the first run's. The artifact records `resumedFrom`.
 *   - The decision the rule gives does not depend on the missing phases: H1 and H3 failed on A alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
// Installs the SQLite store; model resolution reads the per-owner Settings override.
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { parseQuick } from '../src/engine/quickadd.js';
import { constrainOne } from '../src/agents/constrain.js';
import { generateJson, generate, embed } from '../src/mcp/ollama.js';
import { setInstalledModels, parseParamB, resolveModel, matchInstalled } from '../src/lib/models.js';
import { calibrateClassification } from '../src/services/classification-learning.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const LIVE = process.env.LIVE_H2H === '1';
const OUT = process.env.LIVE_H2H_OUT ?? '';
const RUNS_A = Number(process.env.LIVE_H2H_RUNS ?? 6);
const [CANDIDATE, REFERENCE] = (process.env.LIVE_H2H_MODELS ?? 'qwen2.5:3b,gemma3n:e4b').split(',').map((m) => m.trim());
const MODELS = [CANDIDATE, REFERENCE];
/** The built-in quality default: the reference runs with no override so the default path is the one exercised. */
const DEFAULT_QUALITY = 'gemma3n:e4b';
const OWNER = SYSTEM_OWNER;

// ── The model seam ────────────────────────────────────────────────────────────

const rec = vi.hoisted(() => ({ calls: [] as { prompt: string; raw: string; ms: number; error?: string }[] }));

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return {
    ...real,
    // The same call, with the prompt and the raw completion kept. No model is injected: the app resolves its own tiers.
    generateJson: async (prompt: string, opts: Parameters<typeof real.generate>[1] = {}) => {
      const t0 = performance.now();
      let raw: string;
      try {
        raw = await real.generate(prompt, { ...opts, json: true });
      } catch (err) {
        rec.calls.push({ prompt, raw: '', ms: performance.now() - t0, error: (err as Error).message });
        throw err;
      }
      rec.calls.push({ prompt, raw, ms: performance.now() - t0 });
      return real.parseJsonLoose(raw);
    },
  };
});

// ── Fixture ───────────────────────────────────────────────────────────────────

const CATEGORIES = ['health', 'career', 'relationships', 'growth', 'leisure', 'finance'];
const DIRECTIONS = ['work', 'home', 'community'];
const OTHERS = ['email', 'errands'];

/** 120 invented titles, 20 per category, each with an obvious category. No title carries a date or time word (fixtureProblems). */
const NATURAL: Record<string, readonly string[]> = {
  health: [
    'Book the dentist appointment', 'Book a physical with the GP', 'Refill the blood pressure prescription', 'Get the flu shot at the pharmacy',
    'Book an eye test', 'Go for the blood test', 'Physio appointment for the knee', 'Renew the vaccinations', 'Book a hearing test',
    'Get the mole checked by the dermatologist', 'Sleep clinic follow-up', 'Allergy test at the clinic', 'Have the wisdom tooth looked at',
    'Collect the prescription from the pharmacy', 'Check the blood pressure', 'Book the cholesterol check', 'Asthma review with the nurse',
    'Get the vitamin D level tested', 'Book a general check-up', 'Schedule the dental cleaning',
  ],
  career: [
    'Send the proposal to the client', 'Prepare the board presentation', 'Review the pull request', 'Schedule the one-on-one with my manager',
    'Update the project roadmap', 'Write the job description for the new hire', 'Finalise the sales deck', 'Reply to the recruiter',
    'Prepare for the promotion discussion', 'Submit the conference talk proposal', 'Draft the onboarding plan', 'Review the team objectives',
    'Update my LinkedIn headline', 'Plan the product launch', 'Fix the production bug', 'Write the release notes',
    'Interview the candidate for the design role', 'Negotiate the contract terms', 'Finish the client workshop slides', 'Update my CV',
  ],
  relationships: [
    'Call mum', 'Ring grandad', "Plan dad's birthday dinner", 'Text my sister', 'Organise the family reunion', 'Buy an anniversary gift for Alex',
    'Coffee with Priya', 'Write a thank-you card to the neighbours', 'Send my cousin a wedding present', 'Check in on my friend who moved away',
    'Plan a surprise for my partner', 'Video call with my brother', 'Invite the neighbours for dinner', 'Help my friend move house',
    'Babysit my nephew', "Remember my godson's birthday", "Reply to my aunt's letter", 'Organise a get-together with the old school friends',
    'Send flowers to my mother-in-law', 'Plan a special dinner for my wife',
  ],
  growth: [
    'Finish the online data science course', 'Practise Spanish vocabulary', 'Study for the project management certification',
    'Attend the public speaking workshop', 'Watch the lecture on machine learning', 'Learn to touch type', 'Practise presentation skills',
    'Take the first aid course', 'Study for the driving theory test', 'Complete the language lesson', 'Learn about project management methods',
    'Set my learning goals', 'Read a book on critical thinking', 'Take a coding bootcamp lesson', 'Practise public speaking',
    'Do the grammar exercises', 'Study the software architecture book', 'Learn a new programming language', 'Review my flashcards',
    'Take the writing course',
  ],
  leisure: [
    'Watch the new film', 'Buy concert tickets', 'Binge the new series', 'Go to the cinema', 'Paint a landscape', 'Play video games',
    'Build the model railway', 'Visit the art gallery', 'Go fishing at the lake', 'Bake a cake for fun', 'Do a jigsaw puzzle',
    'Listen to the new album', 'Browse the vinyl shop', 'Try the new pizza place', 'Visit the theme park', 'Play a board game',
    'Take photographs at the harbour', 'Go on a scenic drive', 'Read the new thriller novel', 'Watch the football match on TV',
  ],
  finance: [
    'Pay the electricity bill', 'Check the savings account balance', 'File the tax return', 'Renew the car insurance',
    'Pay the credit card statement', 'Transfer money to the savings account', 'Compare mortgage rates', 'Set up the direct debit for rent',
    'Cancel the unused subscription', 'Check the pension statement', 'Pay the water bill', 'Reconcile the bank statement',
    'Claim the insurance refund', 'Pay the council tax', 'Update the household budget spreadsheet', 'Review the credit report',
    'Pay the loan instalment', 'Pay the phone bill', 'Order a new cheque book', 'Review the household budget',
  ],
};
const NATURAL_ITEMS = Object.entries(NATURAL).flatMap(([expected, titles]) => titles.map((title) => ({ title, expected })));

type ConventionId = 'reading-growth' | 'volunteering-relationships' | 'cooking-health';
interface Convention { id: ConventionId; owner: string; rule: string; train: string[]; targets: string[] }
/** The second owner. The owner's value is counter-natural for each (a thriller is leisure, a shelter shift is community). */
const CONVENTIONS2: readonly Convention[] = [
  {
    id: 'reading-growth', owner: 'growth', rule: 'reading and podcasts go to growth, not leisure',
    train: ['Read a chapter of the novel', 'Finish the library book', 'Browse the new arrivals at the bookshop', 'Start the audiobook',
      'Listen to the history podcast', 'Read the magazine on the porch'],
    targets: ['Read the new thriller', 'Pick up the poetry collection', 'Listen to the science podcast', 'Audiobook for the long drive',
      'Read the graphic novel', 'Read the biography of the explorer'],
  },
  {
    id: 'volunteering-relationships', owner: 'relationships', rule: 'volunteering and charity go to relationships, not career or leisure',
    train: ['Volunteer at the food bank', 'Help at the animal shelter', 'Organise the charity bake sale', 'Visit the care home',
      'Tutor kids at the youth centre', 'Join the neighbourhood clean-up'],
    targets: ['Serve meals at the shelter', 'Walk dogs for the rescue', 'Sort donations at the church', 'Read to children at the library',
      'Plant trees with the community group', 'Collect for the school fundraiser'],
  },
  {
    id: 'cooking-health', owner: 'health', rule: 'cooking and meal prep go to health, not leisure',
    train: ['Meal prep the lunches', 'Cook a big batch of soup', 'Bake the wholemeal bread', 'Prepare the lentil stew', 'Try the new salad recipe',
      'Make the green smoothies'],
    targets: ['Cook the vegetable curry', 'Bake sourdough bread', 'Prepare the soup for the freezer', 'Chop the vegetables for the stir fry',
      'Roast the tray of vegetables', 'Make the bean chilli'],
  },
];
/** Natural answers that are not a convention value of the second owner: career, finance and leisure, near-misses included. */
const CONTROLS2: readonly { title: string; expected: string }[] = [
  { title: 'Finish the client workshop slides', expected: 'career' }, { title: 'Fix the production bug', expected: 'career' },
  { title: 'Draft the onboarding plan', expected: 'career' }, { title: 'Reply to the recruiter', expected: 'career' },
  { title: 'Negotiate the contract terms', expected: 'career' }, { title: 'Plan the product launch', expected: 'career' },
  { title: 'Pay the electricity bill', expected: 'finance' }, { title: 'Check the savings account balance', expected: 'finance' },
  { title: 'File the tax return', expected: 'finance' }, { title: 'Renew the car insurance', expected: 'finance' },
  { title: 'Pay the credit card statement', expected: 'finance' }, { title: 'Compare mortgage rates', expected: 'finance' },
  { title: 'Watch the new film', expected: 'leisure' }, { title: 'Buy concert tickets', expected: 'leisure' },
  { title: 'Binge the new series', expected: 'leisure' }, { title: 'Go to the cinema', expected: 'leisure' },
  { title: 'Paint a landscape', expected: 'leisure' }, { title: 'Play video games', expected: 'leisure' },
];
interface Item2 { title: string; kind: 'train' | 'target' | 'control'; expected: string; convention: ConventionId | null }
const TRAIN2: Item2[] = Array.from({ length: 6 }, (_, i) => CONVENTIONS2.map((c): Item2 => ({ title: c.train[i], kind: 'train', expected: c.owner, convention: c.id }))).flat();
const TARGETS2: Item2[] = CONVENTIONS2.flatMap((c) => c.targets.map((title): Item2 => ({ title, kind: 'target', expected: c.owner, convention: c.id })));
const CONTROL_ITEMS2: Item2[] = CONTROLS2.map((c): Item2 => ({ title: c.title, kind: 'control', expected: c.expected, convention: null }));
const LEVELS = [0, 3, 6, 9, 12, 18] as const;
const TOP = LEVELS[LEVELS.length - 1];
const RUNS_B = 3;

const H2H_GATES = {
  /** H1: the candidate may be this many titles of 120 below the reference. */
  h1MaxTitlesBelow: 6,
  /** H1: the runs 0 to 2 against the runs 3 to 5 may move at most this many titles, for either model. */
  h1NoiseTitles: 8,
  /** H2. */
  h2MaxP50Share: 0.75,
  /** H3: points. */
  h3MaxDirectionDropPoints: 10,
  /** H4, on 18 targets and 18 controls. */
  h4MinNetTargets: 3,
  h4NoiseTargets: 3,
  h4MaxLostControls: 2,
  h4MaxKeysDropPoints: 5,
  h4MaxDirectionDropPoints: 10,
  h4MaxTitlesBelowReference: 3,
  /** H5 and the ceiling every call is held to (CALL_POLICY.classify.timeoutMs). */
  ceilingMs: 15_000,
  coldTrials: 3,
  /** H6. */
  h6MaxSlowPct: 10,
  h6SlowFactor: 3,
  mixCycles: 20,
} as const;

// ── Small helpers ─────────────────────────────────────────────────────────────

const pct = (num: number, den: number): number => (den === 0 ? NaN : (100 * num) / den);
const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const WIDE_KEYS = [
  'direction', 'isComplex', 'priority', 'estimatedMinutes', 'timeOfDay', 'timeOfDayReason', 'motivation', 'categories', 'tags',
] as const;
/** The first line of exemplarPrompt's block: present in a prompt exactly when a hint reached it. */
const HINT_MARKER = 'This user has corrected you before.';

/** Nearest-rank percentile, p in 0..100; NaN for an empty sample. */
function percentileOf(sample: readonly number[], p: number): number {
  if (sample.length === 0) return NaN;
  const sorted = [...sample].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

function directionIsValid(raw: string): boolean {
  try {
    const obj = JSON.parse(raw) as { direction?: unknown } | null;
    return !!obj && typeof obj === 'object' && constrainOne(obj.direction, DIRECTIONS) !== null;
  } catch {
    return false;
  }
}

/** What is wrong with the fixtures, checked against the real parser. Empty means usable. */
function fixtureProblems(): string[] {
  const problems: string[] = [];
  const checkTitle = (t: string): void => {
    if (t !== t.trim() || t.length === 0 || t.length > 120) problems.push(`title not usable: ${JSON.stringify(t)}`);
    const p = parseQuick(t);
    if (p.title !== t || p.scheduledFor || p.dueAt || p.taskTime || p.tags.length) problems.push(`${t}: the deterministic parse changes it (${JSON.stringify(p)})`);
  };
  const seen = new Set<string>();
  for (const { title, expected } of NATURAL_ITEMS) {
    checkTitle(title);
    if (seen.has(title.toLowerCase())) problems.push(`duplicate natural title: ${title}`);
    seen.add(title.toLowerCase());
    if (!CATEGORIES.includes(expected)) problems.push(`${title}: ${expected} is not a category`);
  }
  for (const [c, titles] of Object.entries(NATURAL)) if (titles.length !== 20) problems.push(`${c}: ${titles.length} natural titles, wanted 20`);
  const seen2 = new Set<string>();
  const values = new Set(CONVENTIONS2.map((c) => c.owner));
  for (const i of [...TRAIN2, ...TARGETS2, ...CONTROL_ITEMS2]) {
    checkTitle(i.title);
    if (seen2.has(i.title.toLowerCase())) problems.push(`duplicate title in the second owner's set: ${i.title}`);
    seen2.add(i.title.toLowerCase());
    if (!CATEGORIES.includes(i.expected)) problems.push(`${i.title}: ${i.expected} is not a category`);
    if (i.kind === 'control' && values.has(i.expected)) problems.push(`control ${i.title}: its natural answer ${i.expected} is a convention value`);
  }
  for (const c of CONVENTIONS2) {
    if (c.train.length !== 6 || c.targets.length !== 6) problems.push(`${c.id}: ${c.train.length} training and ${c.targets.length} target titles, wanted 6 and 6`);
  }
  if (CONTROLS2.length !== 18) problems.push(`${CONTROLS2.length} controls, wanted 18`);
  return problems;
}

// ── Calls ─────────────────────────────────────────────────────────────────────

type Phase = 'A' | 'COLD' | 'MIX_Q' | 'MIX_F' | 'MIX_E' | 'B';
interface Call {
  model: string;
  phase: Phase;
  /** Corrections at this level (phase B only, else 0). */
  level: number;
  /** Phase B: the repeat of level 0 on a clean owner is 'noise'. */
  pass: 'curve' | 'noise';
  title: string;
  kind: 'natural' | 'target' | 'control' | 'probe';
  expected: string;
  run: number;
  /** The whole call: the route's, or for MIX_F and MIX_E the one model call's. */
  wallMs: number;
  /** The first model call's own time inside a route call; null elsewhere. */
  firstMs: number | null;
  /** Model calls the route made: 2 is the direction retry. */
  modelCalls: number;
  llm: boolean | null;
  categories: string[];
  raw: string;
  allKeys: boolean;
  directionValid: boolean;
  hinted: boolean;
  resident: string[] | null;
}
const calls: Call[] = [];
interface LevelRun { model: string; level: number; captured: number; claims: number; corrections: number; indexed: number }
const levelsRun: LevelRun[] = [];

const say = (line = ''): void => {
  // eslint-disable-next-line no-console
  console.log(line);
};
let srv: TestServer;
const distinctPrompts = new Map<string, string>();
const violations: string[] = [];
const startedAt = new Date().toISOString();
let ollamaVersion = '';
let provenance: Record<string, unknown> = {};
/** The artifact this run resumed (LIVE_H2H_RESUME), or null. */
let resumedFrom: string | null = null;
const violate = (message: string): void => { violations.push(message); };

function flush(): void {
  if (!OUT) return;
  writeFileSync(OUT, JSON.stringify({
    harness: 'quickadd-model-h2h-live', startedAt, writtenAt: new Date().toISOString(),
    env: { models: MODELS, runsA: RUNS_A, runsB: RUNS_B, ollamaUrl: config.ollamaUrl.replace(/\/\/[^/@\s]*@/, '//[redacted]@'), ollamaVersion },
    provenance, resumedFrom, gates: H2H_GATES, violations, prompts: Object.fromEntries(distinctPrompts), levelsRun, calls,
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

function seedVocabulary(): void {
  const insert = sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, ?)`);
  for (const name of DIRECTIONS) insert.run(name, OWNER, 'direction');
  for (const name of CATEGORIES) insert.run(name, OWNER, 'category');
  for (const name of OTHERS) insert.run(name, OWNER, 'intention');
}

/** A clean owner on `model`: no tasks, no evidence, and the quality tier set to it unless it is the built-in default. */
async function resetWorldFor(model: string): Promise<void> {
  resetDb();
  seedVocabulary();
  if (model !== DEFAULT_QUALITY) sqlite.prepare('UPDATE scheduling_prefs SET quality_model = ? WHERE owner_id = ?').run(model, OWNER);
  const resolved = await resolveModel('quality');
  if (matchInstalled(resolved)?.name !== matchInstalled(model)?.name) violate(`the app resolved the quality tier to ${resolved}, not ${model}`);
}

const warm = (model: string): Promise<string> => generate('Reply with the single word: ok', { model, timeoutMs: 180_000, think: false });

/** One route call, timed, with what the model seam saw of it. */
async function routeCall(
  model: string, phase: Phase, level: number, pass: 'curve' | 'noise',
  item: { title: string; kind: Call['kind']; expected: string }, run: number, record = true,
): Promise<Call> {
  rec.calls.length = 0;
  const t0 = performance.now();
  const res = await api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text: item.title } }).catch(() => undefined);
  const wallMs = performance.now() - t0;
  const seen = [...rec.calls];
  const first = seen[0];
  const raw = first?.raw ?? '';
  if (first?.prompt) distinctPrompts.set(sha12(first.prompt), first.prompt);
  let strict: Record<string, unknown> | null = null;
  try {
    const j: unknown = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) strict = j as Record<string, unknown>;
  } catch { /* not strict JSON */ }
  const call: Call = {
    model, phase, level, pass, title: item.title, kind: item.kind, expected: item.expected, run, wallMs, firstMs: first ? first.ms : null,
    modelCalls: seen.length, llm: typeof res?.body?.llm === 'boolean' ? res.body.llm : null,
    categories: Array.isArray(res?.body?.parsed?.categories) ? (res!.body.parsed.categories as string[]) : [],
    raw, allKeys: strict !== null && WIDE_KEYS.every((k) => k in strict!), directionValid: directionIsValid(raw),
    hinted: (first?.prompt ?? '').includes(HINT_MARKER), resident: await residentNames(),
  };
  if (record) calls.push(call);
  return call;
}

/** Unload `model`, then wait up to 15 s for /api/ps to stop listing it. True when it is gone. */
async function unload(model: string): Promise<boolean> {
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

// ── Read-off ──────────────────────────────────────────────────────────────────

const titlesRight = (set: readonly Call[]): Set<string> => {
  const by = new Map<string, boolean[]>();
  for (const c of set) by.set(c.title, [...(by.get(c.title) ?? []), (c.categories[0] ?? '').toLowerCase() === c.expected.toLowerCase()]);
  return new Set([...by].filter(([, v]) => 2 * v.filter(Boolean).length > v.length).map(([t]) => t));
};

interface ASummary {
  n: number; titles: number; right: number; rightPct: number; halfFlips: number; directionPct: number; keysPct: number; pickPct: number;
  p50: number; p95: number; firstP50: number; retryShare: number; meanRetryMs: number; extraPerCallMs: number; byCategory: Record<string, number>;
}
function summariseA(model: string, all: readonly Call[]): ASummary | null {
  const set = all.filter((c) => c.model === model && c.phase === 'A');
  if (set.length === 0) return null;
  const titles = new Set(set.map((c) => c.title)).size;
  const right = titlesRight(set);
  const first = titlesRight(set.filter((c) => c.run < 3));
  const second = titlesRight(set.filter((c) => c.run >= 3));
  const halfFlips = [...new Set([...first, ...second])].filter((t) => first.has(t) !== second.has(t)).length;
  const retried = set.filter((c) => c.modelCalls > 1);
  const retryMs = retried.map((c) => c.wallMs - (c.firstMs ?? 0));
  const meanRetryMs = retryMs.length ? retryMs.reduce((a, b) => a + b, 0) / retryMs.length : 0;
  const byCategory: Record<string, number> = {};
  for (const t of right) byCategory[set.find((c) => c.title === t)!.expected] = (byCategory[set.find((c) => c.title === t)!.expected] ?? 0) + 1;
  return {
    n: set.length, titles, right: right.size, rightPct: pct(right.size, titles), halfFlips,
    directionPct: pct(set.filter((c) => c.directionValid).length, set.length), keysPct: pct(set.filter((c) => c.allKeys).length, set.length),
    pickPct: pct(set.filter((c) => c.categories.length > 0).length, set.length),
    p50: percentileOf(set.map((c) => c.wallMs), 50), p95: percentileOf(set.map((c) => c.wallMs), 95),
    firstP50: percentileOf(set.map((c) => c.firstMs ?? NaN).filter(Number.isFinite), 50),
    retryShare: pct(retried.length, set.length), meanRetryMs, extraPerCallMs: (retried.length / set.length) * meanRetryMs, byCategory,
  };
}

interface BPoint { targets: number; controls: number; keysPct: number; directionPct: number; p50: number; n: number }
function bPoint(all: readonly Call[], model: string, level: number, pass: 'curve' | 'noise'): BPoint {
  const set = all.filter((c) => c.model === model && c.phase === 'B' && c.level === level && c.pass === pass);
  return {
    targets: titlesRight(set.filter((c) => c.kind === 'target')).size, controls: titlesRight(set.filter((c) => c.kind === 'control')).size,
    keysPct: pct(set.filter((c) => c.allKeys).length, set.length), directionPct: pct(set.filter((c) => c.directionValid).length, set.length),
    p50: percentileOf(set.map((c) => c.wallMs), 50), n: set.length,
  };
}

/** Which phases a model has completed in `all` (the resume mode skips them, and discards the others). */
function phaseDone(all: readonly Call[], levels: readonly LevelRun[], model: string): Record<'A' | 'C' | 'M' | 'B', boolean> {
  const n = (p: Phase, pass?: 'curve' | 'noise'): number => all.filter((c) => c.model === model && c.phase === p && (pass === undefined || c.pass === pass)).length;
  const perLevel = (TARGETS2.length + CONTROL_ITEMS2.length) * RUNS_B;
  return {
    A: n('A') === NATURAL_ITEMS.length * RUNS_A,
    C: n('COLD') === H2H_GATES.coldTrials,
    M: n('MIX_Q') === H2H_GATES.mixCycles && n('MIX_F') === H2H_GATES.mixCycles && n('MIX_E') === H2H_GATES.mixCycles,
    B: LEVELS.every((k) => levels.some((l) => l.model === model && l.level === k)) && n('B', 'curve') === LEVELS.length * perLevel && n('B', 'noise') === perLevel,
  };
}

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE: NOISE' | 'NOT RUN';
/** Reads H1 to H6 and the rule (D1 to D4) off the calls. The lead decides; this prints what the rule says. */
function h2hReadOff(all: readonly Call[], candidate: string, reference: string) {
  const lines: string[] = [];
  const a = summariseA(candidate, all), r = summariseA(reference, all);
  const g = H2H_GATES;
  const v: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', Verdict> = { h1: 'NOT RUN', h2: 'NOT RUN', h3: 'NOT RUN', h4: 'NOT RUN', h5: 'NOT RUN', h6: 'NOT RUN' };
  if (a && r) {
    lines.push(`A natural titles (${a.titles}), right by majority: ${candidate} ${a.right} (${f1(a.rightPct)}%), ${reference} ${r.right} (${f1(r.rightPct)}%); by category ${candidate} ${JSON.stringify(a.byCategory)}, ${reference} ${JSON.stringify(r.byCategory)}`);
    lines.push(`A pick/direction/keys: ${candidate} ${f1(a.pickPct)}% / ${f1(a.directionPct)}% / ${f1(a.keysPct)}%; ${reference} ${f1(r.pickPct)}% / ${f1(r.directionPct)}% / ${f1(r.keysPct)}%`);
    lines.push(`A route wall p50/p95 ms: ${candidate} ${f1(a.p50)} / ${f1(a.p95)} (first model call p50 ${f1(a.firstP50)}); ${reference} ${f1(r.p50)} / ${f1(r.p95)} (first ${f1(r.firstP50)})`);
    lines.push(`A direction retry: ${candidate} on ${f1(a.retryShare)}% of calls, ${f1(a.meanRetryMs)} ms each, ${f1(a.extraPerCallMs)} ms per call; ${reference} on ${f1(r.retryShare)}%, ${f1(r.meanRetryMs)} ms each, ${f1(r.extraPerCallMs)} ms per call`);
    v.h1 = a.halfFlips > g.h1NoiseTitles || r.halfFlips > g.h1NoiseTitles ? 'INCONCLUSIVE: NOISE'
      : a.right >= r.right - g.h1MaxTitlesBelow ? 'PASS' : 'FAIL';
    lines.push(`H1 ACCURACY ${v.h1} (${candidate} ${a.right} of ${a.titles} against ${reference} ${r.right}, may be ${g.h1MaxTitlesBelow} below; halves moved ${a.halfFlips} and ${r.halfFlips} titles, limit ${g.h1NoiseTitles})`);
    v.h2 = a.p50 <= g.h2MaxP50Share * r.p50 && a.p95 <= r.p95 ? 'PASS' : 'FAIL';
    lines.push(`H2 SPEED ${v.h2} (p50 ${f1(a.p50)} ms against ${f1(r.p50)}, limit ${g.h2MaxP50Share} of it = ${f1(g.h2MaxP50Share * r.p50)}; p95 ${f1(a.p95)} against ${f1(r.p95)})`);
    v.h3 = a.directionPct >= r.directionPct - g.h3MaxDirectionDropPoints ? 'PASS' : 'FAIL';
    lines.push(`H3 DIRECTION ${v.h3} (${f1(a.directionPct)}% against ${f1(r.directionPct)}%, may be ${g.h3MaxDirectionDropPoints} points below)`);
  }
  // H4: learning on the second owner
  const at = (m: string, k: number, p: 'curve' | 'noise' = 'curve') => bPoint(all, m, k, p);
  const c0 = at(candidate, 0), c18 = at(candidate, TOP), cr = at(candidate, 0, 'noise'), r18 = at(reference, TOP);
  if (c0.n > 0 && c18.n > 0 && r18.n > 0) {
    const t0 = titlesRight(all.filter((c) => c.model === candidate && c.phase === 'B' && c.level === 0 && c.pass === 'curve' && c.kind === 'target'));
    const tr = titlesRight(all.filter((c) => c.model === candidate && c.phase === 'B' && c.level === 0 && c.pass === 'noise' && c.kind === 'target'));
    const flips = cr.n === 0 ? 0 : [...new Set([...t0, ...tr])].filter((t) => t0.has(t) !== tr.has(t)).length;
    const net = c18.targets - c0.targets;
    const l1 = flips > g.h4NoiseTargets ? 'INCONCLUSIVE: NOISE' : net >= g.h4MinNetTargets ? 'PASS' : 'FAIL';
    const l2 = c18.controls >= c0.controls - g.h4MaxLostControls;
    const l3 = c18.keysPct >= c0.keysPct - g.h4MaxKeysDropPoints && c18.directionPct >= c0.directionPct - g.h4MaxDirectionDropPoints;
    const total = c18.targets + c18.controls, refTotal = r18.targets + r18.controls;
    const vsRef = total >= refTotal - g.h4MaxTitlesBelowReference;
    v.h4 = l1 === 'INCONCLUSIVE: NOISE' ? 'INCONCLUSIVE: NOISE' : l1 === 'PASS' && l2 && l3 && vsRef ? 'PASS' : 'FAIL';
    for (const m of [candidate, reference]) {
      lines.push(`B ${m} curve (targets/18, controls/18, keys %, direction %, route p50 ms): ${LEVELS.map((k) => { const q = at(m, k); return q.n === 0 ? `k${k} -` : `k${k} ${q.targets}/${q.controls}/${f1(q.keysPct)}/${f1(q.directionPct)}/${f1(q.p50)}`; }).join('  ')}`);
    }
    lines.push(`H4 LEARNING ${v.h4} (targets ${c0.targets} to ${c18.targets}, net ${net} of at least ${g.h4MinNetTargets}, level 0 against its repeat moved ${flips} of at most ${g.h4NoiseTargets}; `
      + `controls ${c0.controls} to ${c18.controls}, may lose ${g.h4MaxLostControls}; keys ${f1(c0.keysPct)} to ${f1(c18.keysPct)}%, direction ${f1(c0.directionPct)} to ${f1(c18.directionPct)}%; `
      + `${total} of 36 right at level ${TOP} against the reference's ${refTotal}, may be ${g.h4MaxTitlesBelowReference} below)`);
  }
  const cold = (m: string) => all.filter((c) => c.model === m && c.phase === 'COLD');
  const cc = cold(candidate), rc = cold(reference);
  if (cc.length > 0) {
    const med = (xs: Call[]) => percentileOf(xs.map((c) => c.wallMs), 50);
    v.h5 = cc.length === g.coldTrials && cc.every((c) => c.llm === true && c.wallMs <= g.ceilingMs) && (rc.length === 0 || med(cc) <= med(rc)) ? 'PASS' : 'FAIL';
    lines.push(`H5 COLD ${v.h5} (${candidate} ${cc.map((c) => `${c.wallMs.toFixed(0)} ms${c.llm === true ? '' : ' NO OVERLAY'}`).join(', ')}, median ${f1(med(cc))}; ${reference} ${rc.map((c) => `${c.wallMs.toFixed(0)} ms`).join(', ') || 'not run'}, median ${f1(rc.length ? med(rc) : NaN)}; ceiling ${g.ceilingMs} ms)`);
  }
  const mix = all.filter((c) => c.model === candidate && c.phase === 'MIX_Q');
  if (mix.length > 0 && a) {
    const above = g.h6SlowFactor * a.p50;
    const slow = mix.filter((c) => c.wallMs > above).length;
    v.h6 = pct(slow, mix.length) <= g.h6MaxSlowPct && mix.every((c) => c.llm === true) ? 'PASS' : 'FAIL';
    const f = all.filter((c) => c.model === candidate && c.phase === 'MIX_F').map((c) => c.wallMs);
    const e = all.filter((c) => c.model === candidate && c.phase === 'MIX_E').map((c) => c.wallMs);
    lines.push(`H6 RESIDENCY ${v.h6} (${slow} of ${mix.length} MIX route calls over ${f1(above)} ms = ${g.h6SlowFactor} x the warm p50, ${f1(pct(slow, mix.length))}% of at most ${g.h6MaxSlowPct}%; fast-tier probe p50 ${f1(percentileOf(f, 50))} ms, embed p50 ${f1(percentileOf(e, 50))} ms)`);
  }
  const all6 = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).every((k) => v[k] === 'PASS');
  const failed = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).filter((k) => v[k] !== 'PASS').map((k) => `${k.toUpperCase()} ${v[k]}`);
  let decision: string;
  if (all6) decision = `D1: ${candidate} is the better quick-add model on every axis tested: recommended`;
  else if (v.h2 !== 'PASS') decision = `D3: ${candidate} is not faster by the registered margin: no reason to move`;
  else if (v.h1 !== 'PASS' || v.h4 !== 'PASS') decision = `D2: ${candidate} is faster but ${[v.h1 !== 'PASS' ? `H1 is ${v.h1}` : '', v.h4 !== 'PASS' ? `H4 is ${v.h4}` : ''].filter(Boolean).join(' and ')}: a speed-for-accuracy trade, not an improvement; ${reference} stays the default and ${candidate} is at most an opt-in`;
  else decision = `D4: ${candidate} is faster, as accurate and learns, but ${failed.join(', ')}`;
  lines.push(`D the rule says: ${decision}.`);
  return { lines, v, a, r, decision };
}

// ── The live run ──────────────────────────────────────────────────────────────

const levelsLine = (model: string, level: number): string => {
  const q = bPoint(calls, model, level, 'curve');
  return `${model} B k${level}: targets ${q.targets}/18, controls ${q.controls}/18, keys ${f1(q.keysPct)}%, direction ${f1(q.directionPct)}%, route p50 ${f1(q.p50)} ms`;
};

async function captureTitle(item: Item2): Promise<boolean> {
  rec.calls.length = 0;
  const parsed = await api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text: item.title } });
  const claim = parsed.body?.classification_claim as { text: string; categories: string[] } | undefined;
  const title = (parsed.body?.parsed?.title as string | undefined) ?? item.title;
  const created = await api(srv.url, '/api/tasks', { method: 'POST', json: { title, categories: [item.expected], ...(claim ? { classification_claim: claim } : {}) } });
  if (created.status !== 201) violate(`capture "${item.title}": POST /api/tasks answered ${created.status}`);
  return claim !== undefined;
}

async function measureB(model: string, level: number, pass: 'curve' | 'noise'): Promise<void> {
  for (const item of [...TARGETS2, ...CONTROL_ITEMS2]) {
    for (let run = 0; run < RUNS_B; run++) await routeCall(model, 'B', level, pass, { title: item.title, kind: item.kind === 'target' ? 'target' : 'control', expected: item.expected }, run);
  }
}

/** Remove a model's calls of the given phases (and its learning levels with phase B): a half-finished phase is never kept. */
function discard(model: string, phases: readonly Phase[]): void {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].model === model && phases.includes(calls[i].phase)) calls.splice(i, 1);
  if (phases.includes('B')) for (let i = levelsRun.length - 1; i >= 0; i--) if (levelsRun[i].model === model) levelsRun.splice(i, 1);
}

async function runModel(model: string): Promise<void> {
  say(`\n=== ${model} ===`);
  const done = phaseDone(calls, levelsRun, model);
  if (resumedFrom) say(`${model}: resumed from ${resumedFrom}; phases already complete: ${(['A', 'C', 'M', 'B'] as const).filter((k) => done[k]).join(', ') || 'none'}`);
  if (done.A && done.C && done.M && done.B) return;
  await warm(model);
  await resetWorldFor(model);
  // A: natural titles, no corrections.
  if (!done.A) {
    discard(model, ['A']);
    for (let run = 0; run < RUNS_A; run++) {
      for (const item of NATURAL_ITEMS) await routeCall(model, 'A', 0, 'curve', { title: item.title, kind: 'natural', expected: item.expected }, run);
      flush();
    }
  }
  const a = summariseA(model, calls)!;
  say(`${model} A: ${a.n} calls, ${a.right} of ${a.titles} titles right, direction ${f1(a.directionPct)}%, route p50 ${f1(a.p50)} / p95 ${f1(a.p95)} ms, retry on ${f1(a.retryShare)}% of calls (${f1(a.meanRetryMs)} ms each)`);
  // C: cold.
  if (!done.C) discard(model, ['COLD']);
  for (let trial = 0; trial < (done.C ? 0 : H2H_GATES.coldTrials); trial++) {
    const gone = await unload(model);
    if (!gone) violate(`${model} cold trial ${trial}: still listed by /api/ps 15 s after the unload`);
    const c = await routeCall(model, 'COLD', 0, 'curve', { title: NATURAL_ITEMS[trial * 7].title, kind: 'natural', expected: NATURAL_ITEMS[trial * 7].expected }, trial);
    say(`${model} cold ${trial}: unloaded ${gone}, first route call ${c.wallMs.toFixed(0)} ms (model ${c.firstMs?.toFixed(0)} ms), overlay ${c.llm}`);
  }
  // M: three models taking turns.
  if (!done.M) discard(model, ['MIX_Q', 'MIX_F', 'MIX_E']);
  for (let cycle = 0; cycle < (done.M ? 0 : H2H_GATES.mixCycles); cycle++) {
    const item = NATURAL_ITEMS[(cycle * 5) % NATURAL_ITEMS.length];
    await routeCall(model, 'MIX_Q', 0, 'curve', { title: item.title, kind: 'natural', expected: item.expected }, cycle);
    const probe = (phase: 'MIX_F' | 'MIX_E', wallMs: number, resident: string[] | null): Call => ({
      model, phase, level: 0, pass: 'curve', title: phase === 'MIX_F' ? 'fast-tier probe' : 'embed probe', kind: 'probe', expected: '', run: cycle, wallMs,
      firstMs: null, modelCalls: 1, llm: null, categories: [], raw: '', allKeys: false, directionValid: false, hinted: false, resident,
    });
    // A probe that fails (a timeout on a shared, loaded server) is recorded as a failed probe, not thrown.
    const t1 = performance.now();
    let fOk = true;
    try { await generateJson('Give two short subtasks for "Plan a trip". Reply with JSON {"subtasks": ["...", "..."]}.', { purpose: 'brainstorm' }); } catch { fOk = false; }
    calls.push({ ...probe('MIX_F', performance.now() - t1, await residentNames()), llm: fOk });
    const t2 = performance.now();
    let eOk = true;
    try { await embed('Plan the quarterly review', 20_000); } catch { eOk = false; }
    calls.push({ ...probe('MIX_E', performance.now() - t2, await residentNames()), llm: eOk });
  }
  flush();
  // B: learning on the second owner.
  if (done.B) return;
  discard(model, ['B']);
  await resetWorldFor(model);
  let captured = 0, claims = 0;
  for (const level of LEVELS) {
    while (captured < level) { if (await captureTitle(TRAIN2[captured])) claims++; captured++; }
    let corrections = 0, indexed = 0;
    if (level > 0) {
      const cal = await calibrateClassification(OWNER, new Date(), { embedFn: null });
      const cat = cal.fields.find((x) => x.field === 'category');
      corrections = cat?.corrections ?? 0; indexed = cat?.indexed ?? 0;
    }
    levelsRun.push({ model, level, captured, claims, corrections, indexed });
    await measureB(model, level, 'curve');
    flush();
    say(`${levelsLine(model, level)}; captured ${captured}, claims ${claims}, corrections ${corrections}, indexed ${indexed}`);
  }
  await resetWorldFor(model);
  await measureB(model, 0, 'noise');
  flush();
}

async function prepare(): Promise<void> {
  expect(MODELS).toHaveLength(2);
  const res = await fetch(`${config.ollamaUrl}/api/tags`);
  const data = (await res.json()) as { models?: { name: string; capabilities?: string[]; details?: { parameter_size?: string } }[] };
  setInstalledModels((data.models ?? []).map((m) => ({ name: m.name, capabilities: m.capabilities ?? [], paramB: parseParamB(m.details?.parameter_size) })));
  try { ollamaVersion = ((await (await fetch(`${config.ollamaUrl}/api/version`)).json()) as { version?: string }).version ?? ''; } catch { /* a note */ }
  for (const model of MODELS) {
    const picked = matchInstalled(model);
    expect(picked, `${model} is not installed`).toBeTruthy();
    expect(picked!.capabilities, `${model} is thinking-capable`).not.toContain('thinking');
  }
  const fast = await resolveModel('fast');
  expect(matchInstalled(fast)?.name, `the fast tier must be qwen2.5:0.5b (it serves the mix probe), not ${fast}`).toBe(matchInstalled('qwen2.5:0.5b')?.name);
  provenance = { command: process.argv.join(' '), node: process.version, fast, ollamaVersion, apiPsAtStart: await (async () => { try { return await (await fetch(`${config.ollamaUrl}/api/ps`)).json(); } catch { return null; } })() };
  say(`[h2h] fast tier ${fast}; candidate ${CANDIDATE}, reference ${REFERENCE}; Ollama ${ollamaVersion}`);
  expect(fixtureProblems()).toEqual([]);
  const resume = process.env.LIVE_H2H_RESUME ?? '';
  if (resume) {
    const prior = JSON.parse(readFileSync(resume, 'utf8')) as { calls: Call[]; levelsRun: LevelRun[] };
    calls.push(...prior.calls);
    levelsRun.push(...prior.levelsRun);
    resumedFrom = resume;
    say(`[h2h] resuming ${resume}: ${prior.calls.length} calls`);
  }
  srv = await startTestServer();
}

describe.skipIf(!LIVE)('quick add model head-to-head · live', () => {
  beforeAll(prepare);
  afterAll(async () => {
    await srv?.close();
    // Leave the Ollama server as found: the reference is the default and loads again on its next call.
  });

  for (const model of MODELS) {
    it(`${model}: natural titles, cold start, mix, learning on the second owner`, async () => {
      await runModel(model);
    }, 4 * 60 * 60_000);
  }

  it('the rule, read off the calls (the lead decides; nothing here is asserted but the mechanism)', () => {
    flush();
    say(`\n[h2h] ${calls.length} calls recorded${OUT ? `, artifact at ${OUT}` : ' (set LIVE_H2H_OUT to keep them)'}.`);
    for (const line of h2hReadOff(calls, CANDIDATE, REFERENCE).lines) say(line);
    expect(violations, `mechanism violations:\n${violations.join('\n')}`).toEqual([]);
  });
});

// ── The pure parts: they run in every test run, no model ─────────────────────

describe('quick add model head-to-head · pure parts', () => {
  const K = 'qwen2.5:3b', R = 'gemma3n:e4b';

  it('the fixtures are well formed against the real parser', () => {
    expect(fixtureProblems()).toEqual([]);
    expect(NATURAL_ITEMS).toHaveLength(120);
    for (const c of CATEGORIES) expect(NATURAL[c], c).toHaveLength(20);
    expect(TRAIN2).toHaveLength(18);
    expect(TARGETS2).toHaveLength(18);
    expect(CONTROL_ITEMS2).toHaveLength(18);
    // The three conventions are taken in turn, and no control's natural answer is a convention value.
    expect(TRAIN2.slice(0, 6).map((i) => i.convention)).toEqual(['reading-growth', 'volunteering-relationships', 'cooking-health', 'reading-growth', 'volunteering-relationships', 'cooking-health']);
    expect(new Set(CONTROL_ITEMS2.map((i) => i.expected))).toEqual(new Set(['career', 'finance', 'leisure']));
  });

  it('the direction check reads the owner\'s directions, case-insensitively, and nothing else', () => {
    expect(directionIsValid('{"direction":"Home"}')).toBe(true);
    expect(directionIsValid('{"direction":"health"}')).toBe(false); // a category in the direction field
    expect(directionIsValid('{"direction":null}')).toBe(false);
    expect(directionIsValid('{}')).toBe(false);
    expect(directionIsValid('not json')).toBe(false);
    expect(directionIsValid('')).toBe(false);
  });

  it('percentile is nearest-rank and empty-safe', () => {
    expect(percentileOf([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentileOf(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(Number.isNaN(percentileOf([], 50))).toBe(true);
  });

  // ── The rule on invented calls ──
  const mk = (model: string, over: Partial<Call>): Call => ({
    model, phase: 'A', level: 0, pass: 'curve', title: 't', kind: 'natural', expected: 'health', run: 0, wallMs: 1000, firstMs: 1000, modelCalls: 1, llm: true,
    categories: ['health'], raw: '{}', allKeys: true, directionValid: true, hinted: false, resident: null, ...over,
  });
  /** Phase A for a model: 120 titles x 6 runs; the first `right` titles are right on every run, the rest wrong on every run. */
  const phaseA = (model: string, right: number, over: Partial<Call> = {}, per: (i: number, run: number) => Partial<Call> = () => ({})): Call[] =>
    NATURAL_ITEMS.flatMap((it, i) => Array.from({ length: 6 }, (_, run) => mk(model, {
      title: it.title, expected: it.expected, run, categories: [i < right ? it.expected : 'wrong'], ...over, ...per(i, run),
    })));
  const cold = (model: string, ...ms: number[]): Call[] => ms.map((wallMs, run) => mk(model, { phase: 'COLD', wallMs, run }));
  const mix = (model: string, slow: number, ms = 1000): Call[] => Array.from({ length: 20 }, (_, run) => mk(model, { phase: 'MIX_Q', run, wallMs: run < slow ? ms * 4 : ms }));
  /** Phase B: 18 targets + 18 controls x 3 runs at a level; the first t targets and c controls are right. */
  const level = (model: string, k: number, t: number, c: number, over: Partial<Call> = {}, pass: 'curve' | 'noise' = 'curve'): Call[] =>
    (['target', 'control'] as const).flatMap((kind) => Array.from({ length: 18 }, (_, i) => i).flatMap((i) =>
      [0, 1, 2].map((run) => mk(model, { phase: 'B', level: k, pass, title: `${kind}-${i}`, kind, expected: 'growth', run, categories: [i < (kind === 'target' ? t : c) ? 'growth' : 'finance'], ...over }))));
  const learn = (model: string, k0: [number, number], top: [number, number], repeat?: [number, number], over: Partial<Call> = {}): Call[] => [
    ...level(model, 0, k0[0], k0[1]), ...level(model, TOP, top[0], top[1], over), ...level(model, 0, (repeat ?? k0)[0], (repeat ?? k0)[1], {}, 'noise'),
  ];
  /** A candidate and reference that pass every gate; each test spoils one thing. */
  const world = (o: { candA?: Call[]; refA?: Call[]; candB?: Call[]; refB?: Call[]; candCold?: Call[]; refCold?: Call[]; candMix?: Call[] } = {}): Call[] => [
    ...(o.candA ?? phaseA(K, 114, { wallMs: 700, firstMs: 700 })), ...(o.refA ?? phaseA(R, 118, { wallMs: 1500, firstMs: 1500 })),
    ...(o.candB ?? learn(K, [3, 15], [8, 16])), ...(o.refB ?? learn(R, [3, 18], [7, 18])),
    ...(o.candCold ?? cold(K, 3000, 3200, 3100)), ...(o.refCold ?? cold(R, 5000, 5100, 5050)), ...(o.candMix ?? mix(K, 1, 700)),
  ];
  const read = (calls_: Call[]) => h2hReadOff(calls_, K, R);

  it('D1 when the candidate is within the margin on accuracy, faster, learns and is no worse cold or in the mix', () => {
    const r = read(world());
    expect(r.v).toEqual({ h1: 'PASS', h2: 'PASS', h3: 'PASS', h4: 'PASS', h5: 'PASS', h6: 'PASS' });
    expect(r.decision).toMatch(/^D1: qwen2\.5:3b is the better quick-add model/);
  });

  it('H1 is 6 titles of 120 below the reference, no more, and inconclusive when a model\'s halves disagree by more than 8', () => {
    expect(read(world({ candA: phaseA(K, 112, { wallMs: 700 }) })).v.h1).toBe('PASS'); // 118 - 6
    expect(read(world({ candA: phaseA(K, 111, { wallMs: 700 }) })).v.h1).toBe('FAIL');
    // The first half right on 100 titles, the second half on 109: 9 titles flip.
    const noisy = phaseA(K, 0, { wallMs: 700 }, (i, run) => ({ categories: [i < (run < 3 ? 100 : 109) ? NATURAL_ITEMS[i].expected : 'wrong'] }));
    expect(read(world({ candA: noisy })).v.h1).toBe('INCONCLUSIVE: NOISE');
    const edge = phaseA(K, 0, { wallMs: 700 }, (i, run) => ({ categories: [i < (run < 3 ? 100 : 108) ? NATURAL_ITEMS[i].expected : 'wrong'] }));
    expect(read(world({ candA: edge })).v.h1).not.toBe('INCONCLUSIVE: NOISE'); // 8 flips are within the allowance
  });

  it('H2 wants p50 at 0.75 of the reference or less and p95 no higher', () => {
    expect(read(world({ candA: phaseA(K, 114, { wallMs: 1125 }) })).v.h2).toBe('PASS'); // 0.75 x 1500
    expect(read(world({ candA: phaseA(K, 114, { wallMs: 1126 }) })).v.h2).toBe('FAIL');
    // p50 fine, p95 above the reference's: a tail of slow calls.
    // 12 titles slow on every run is 10% of the calls, so the 95th percentile is slow.
    const tail = phaseA(K, 114, { wallMs: 700 }, (i) => (i < 12 ? { wallMs: 9000 } : {}));
    expect(read(world({ candA: tail })).v.h2).toBe('FAIL');
  });

  it('H3 lets the candidate\'s valid-direction share fall 10 points below the reference\'s', () => {
    const dir = (bad: number) => phaseA(K, 114, { wallMs: 700 }, (i, run) => ({ directionValid: !((i * 6 + run) < bad) }));
    // The reference is at 100%; 72 of 720 calls is 10 points, 73 is 10.1.
    expect(read(world({ candA: dir(72) })).v.h3).toBe('PASS');
    expect(read(world({ candA: dir(73) })).v.h3).toBe('FAIL');
  });

  it('H4 needs +3 of 18 targets, at most 2 controls lost, keys and direction held, and the reference matched within 3', () => {
    expect(read(world({ candB: learn(K, [3, 15], [6, 16]) })).v.h4).toBe('PASS');
    expect(read(world({ candB: learn(K, [3, 15], [5, 16]) })).v.h4).toBe('FAIL'); // +2
    expect(read(world({ candB: learn(K, [3, 15], [8, 13]) })).v.h4).toBe('FAIL'); // lost 2 controls (allowed), but 21 against the reference's 25 is 4 below
    expect(read(world({ candB: learn(K, [3, 15], [8, 13]), refB: learn(R, [3, 18], [7, 16]) })).v.h4).toBe('PASS'); // 21 against 23: within 3
    expect(read(world({ candB: learn(K, [3, 15], [8, 12]) })).v.h4).toBe('FAIL'); // lost 3 controls
    expect(read(world({ candB: learn(K, [3, 15], [8, 16], undefined, { allKeys: false }) })).v.h4).toBe('FAIL');
    expect(read(world({ candB: learn(K, [3, 15], [8, 16], undefined, { directionValid: false }) })).v.h4).toBe('FAIL');
    // Level 0 against its repeat moving 4 target titles: inconclusive, not a pass.
    expect(read(world({ candB: learn(K, [3, 15], [9, 16], [7, 15]) })).v.h4).toBe('INCONCLUSIVE: NOISE');
    expect(read(world({ candB: learn(K, [3, 15], [9, 16], [6, 15]) })).v.h4).toBe('PASS'); // 3 flips: allowed
  });

  it('H4 against the reference: matched within 3 titles of 36, no more', () => {
    // Reference at 18 corrections: 7 + 18 = 25. Candidate 8 + 14 = 22 is 3 below (and lost only 1 control).
    expect(read(world({ candB: learn(K, [3, 15], [8, 14]) })).v.h4).toBe('PASS');
    expect(read(world({ candB: learn(K, [3, 15], [7, 14]) })).v.h4).toBe('FAIL'); // 21: 4 below
  });

  it('H5: all three cold calls ran the overlay inside the ceiling and the median is no slower than the reference\'s', () => {
    expect(read(world({ candCold: cold(K, 5050, 5050, 5050) })).v.h5).toBe('PASS'); // equal medians
    expect(read(world({ candCold: cold(K, 5100, 5100, 5100) })).v.h5).toBe('FAIL');
    expect(read(world({ candCold: cold(K, 3000, 3000) })).v.h5).toBe('FAIL'); // two trials
    expect(read(world({ candCold: cold(K, 3000, 3000, 15_001) })).v.h5).toBe('FAIL');
    const noOverlay = cold(K, 3000, 3000, 3000).map((c, i) => (i === 2 ? { ...c, llm: false } : c));
    expect(read(world({ candCold: noOverlay })).v.h5).toBe('FAIL');
  });

  it('H6: at most 10% of the candidate\'s MIX route calls over 3 warm medians, every one with the overlay', () => {
    expect(read(world({ candMix: mix(K, 2, 700) })).v.h6).toBe('PASS'); // 4 x 700 = 2800 > 2100; 2 of 20 = 10%
    expect(read(world({ candMix: mix(K, 3, 700) })).v.h6).toBe('FAIL');
    expect(read(world({ candMix: mix(K, 0, 700).map((c, i) => (i === 0 ? { ...c, llm: false } : c)) })).v.h6).toBe('FAIL');
  });

  it('D2 when it is faster but less accurate or a worse learner; D3 when it is not faster; D4 when only a side gate fails', () => {
    expect(read(world({ candA: phaseA(K, 100, { wallMs: 700 }) })).decision).toMatch(/^D2: qwen2\.5:3b is faster but H1 is FAIL/);
    expect(read(world({ candB: learn(K, [3, 15], [4, 16]) })).decision).toMatch(/^D2: qwen2\.5:3b is faster but H4 is FAIL/);
    expect(read(world({ candA: phaseA(K, 114, { wallMs: 1400 }) })).decision).toMatch(/^D3:/);
    expect(read(world({ candMix: mix(K, 5, 700) })).decision).toMatch(/^D4: qwen2\.5:3b is faster, as accurate and learns, but H6 FAIL/);
    expect(read(world({ candCold: cold(K, 9000, 9000, 9000) })).decision).toMatch(/^D4: .*H5 FAIL/);
  });

  it('reports the retry cost and the accuracy by category without gating on them', () => {
    // 10% of the candidate's calls made two model calls, the retry costing 400 ms.
    const retried = phaseA(K, 114, { wallMs: 700, firstMs: 700 }, (i, run) => ((i * 6 + run) % 10 === 0 ? { modelCalls: 2, wallMs: 1100 } : {}));
    const r = read(world({ candA: retried }));
    expect(r.a!.retryShare).toBeCloseTo(10, 5);
    expect(r.a!.meanRetryMs).toBeCloseTo(400, 5);
    expect(r.a!.extraPerCallMs).toBeCloseTo(40, 5);
    expect(r.lines.some((l) => l.startsWith('A direction retry:'))).toBe(true);
    expect(Object.keys(r.a!.byCategory).sort()).toEqual([...CATEGORIES].sort());
    expect(r.v.h2).toBe('PASS'); // p50 is still 700
  });

  it('knows which phases a model has completed, so a resume re-runs only the rest', () => {
    const levels = (m: string, ks: readonly number[]): LevelRun[] => ks.map((k) => ({ model: m, level: k, captured: k, claims: k, corrections: k, indexed: k }));
    const mixAll = (m: string, cycles = 20): Call[] => (['MIX_Q', 'MIX_F', 'MIX_E'] as const).flatMap((phase) => Array.from({ length: cycles }, (_, run) => mk(m, { phase, run })));
    const bAll = (m: string): Call[] => [...LEVELS.flatMap((k) => level(m, k, 3, 15)), ...level(m, 0, 3, 15, {}, 'noise')];
    const complete = (m: string): Call[] => [...phaseA(m, 100), ...cold(m, 1000, 2000, 3000), ...mixAll(m), ...bAll(m)];
    expect(phaseDone(complete(K), levels(K, LEVELS), K)).toEqual({ A: true, C: true, M: true, B: true });
    // What the first live run left for the candidate: A and COLD done, MIX dead after 4 cycles, B never run.
    const partial = [...phaseA(K, 83), ...cold(K, 3000, 3100, 3050), ...mixAll(K, 4), ...complete(R)];
    expect(phaseDone(partial, levels(R, LEVELS), K)).toEqual({ A: true, C: true, M: false, B: false });
    expect(phaseDone(partial, levels(R, LEVELS), R)).toEqual({ A: true, C: true, M: true, B: true }); // the reference needs nothing
    // A level missing from the levels run, a missing noise pass, or a missing cold trial is not complete.
    expect(phaseDone(complete(K), levels(K, [0, 3, 6, 9, 12]), K).B).toBe(false);
    expect(phaseDone(complete(K).filter((c) => !(c.phase === 'B' && c.pass === 'noise')), levels(K, LEVELS), K).B).toBe(false);
    expect(phaseDone(complete(K).filter((c) => !(c.phase === 'COLD' && c.run === 2)), levels(K, LEVELS), K).C).toBe(false);
    // Another model's calls do not count for this one.
    expect(phaseDone(complete(R), levels(R, LEVELS), K)).toEqual({ A: false, C: false, M: false, B: false });
  });

  it('says NOT RUN for a gate with no calls, and cannot reach D1', () => {
    const r = read([...phaseA(K, 114, { wallMs: 700 }), ...phaseA(R, 118, { wallMs: 1500 })]);
    expect(r.v.h4).toBe('NOT RUN');
    expect(r.v.h5).toBe('NOT RUN');
    expect(r.decision).not.toMatch(/^D1/);
  });
});
