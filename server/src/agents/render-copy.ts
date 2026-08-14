import { store } from '../db/store.js';
import { generate } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { currentOwnerId } from '../lib/context.js';
import {
  gateCopy,
  computeSignature,
  isRepetitive,
  BANNED_PHRASES_PROMPT,
  type Signature,
} from './voice-gate.js';

/**
 * Phase Z · Z7 (Time-Sense) — the Voice loop (spec §2V).
 *
 * `renderCopy(surface, payload)` is the ONE path every human-facing line goes
 * through, so the voice is consistent and — the point of the whole thing — never
 * repeats itself. The pipeline (§2V.2):
 *
 *   deterministic payload  →  small-model draft  →  deterministic gate (voice-gate.ts)
 *   →  fail: regenerate once  →  still failing / Ollama down: rotation-pool fallback
 *   with datum-slotting  →  emit + record the phrasing signature (copy_history).
 *
 * Two guarantees: the loop is bounded (latency + cost capped at a couple of small-
 * model calls) and it degrades to a template pool that STILL doesn't repeat, because
 * the fallback picks a template whose signature isn't in the recent window and slots
 * the unique datum in. The gate is a separate, model-free module (generator ≠
 * evaluator). This service never throws on an Ollama outage — it always returns a line.
 *
 * The service itself is voice infrastructure and does not gate on time_sense_enabled;
 * its callers (all Time-Sense surfaces) are the ones behind the flag.
 */

export type Surface =
  | 'timing_note'
  | 't4_whats_next'
  | 'departure_prompt'
  | 'calibration_chip'
  | 'nudge'
  | 'daily_brief'
  | 'eod_alignment'
  | 'weekly_review'
  | 'plan_week_followup'
  | 'plan_week_option';

/** A surface's payload — a flat bag of the deterministic facts the line must carry. */
export type Payload = Record<string, string | number | boolean | null | undefined>;

interface SurfaceConfig {
  /** Small for frequent microcopy; medium for the longer narratives (§2V.1). */
  tier: 'fast' | 'quality';
  /** Length budget in characters (§2V.4 "brief"). */
  maxLen: number;
  /** Rolling-window size for the anti-repetition memory (§2V.3, per-surface K). */
  historyK: number;
  /** Shape/length guidance for the model prompt (microcopy line vs. short paragraph). */
  lengthHint: string;
  /** The datum strings that MUST appear in the line (grounding, §2V.4). */
  required: (p: Payload) => string[];
  /** The deterministic fact block handed to the model. */
  facts: (p: Payload) => string;
  /**
   * Rotation pool for the offline / gate-failed path (§2V.2 step 5). Each template
   * slots the unique datum so even when the structure repeats, the content differs.
   * 4–6 per surface is enough with datum-slotting.
   */
  fallbacks: ((p: Payload) => string)[];
}

const str = (v: Payload[string]): string => (v == null ? '' : String(v));

// ── The surface catalog (§2V.6) ──────────────────────────────────────────────────
// K per §2V.3: high-frequency (daily+) ≈30, medium ≈14, low ≈4.

const LINE_HINT = 'one short line, verb-first';
const PARA_HINT = '3-5 sentences, no bullet lists, no preamble';

export const SURFACES: Record<Surface, SurfaceConfig> = {
  timing_note: {
    tier: 'fast', maxLen: 140, historyK: 30, lengthHint: LINE_HINT,
    required: (p) => [str(p.planned_departure)],
    facts: (p) =>
      `planned_departure=${str(p.planned_departure)}${p.next ? `, next="${str(p.next)}"` : ''}` +
      `${p.block_overrun ? ', the current block is about to overrun' : ''}`,
    fallbacks: [
      (p) => `You planned to leave by ${str(p.planned_departure)}${p.next ? ` for ${str(p.next)}` : ''}.`,
      (p) => `${str(p.planned_departure)} was your leave-by${p.next ? ` — ${str(p.next)} is next` : ''}.`,
      (p) => `Heads up: you wanted to be out by ${str(p.planned_departure)}${p.next ? `, ${str(p.next)} after` : ''}.`,
      (p) => `Leave-by is ${str(p.planned_departure)}. This block is close to it.`,
      (p) => `${p.next ? `${str(p.next)} at ` : 'Next up around '}${str(p.planned_departure)} — worth wrapping soon.`,
    ],
  },

  t4_whats_next: {
    tier: 'fast', maxLen: 140, historyK: 30, lengthHint: LINE_HINT,
    required: (p) => (p.next_time ? [str(p.next_time)] : []),
    facts: (p) =>
      p.next ? `block ended, next="${str(p.next)}" at ${str(p.next_time)}` : 'block ended, nothing scheduled after it',
    fallbacks: [
      (p) => (p.next ? `Time's up. Next: ${str(p.next)} at ${str(p.next_time)}.` : `Time's up. Nothing after this one.`),
      (p) => (p.next ? `That's the block. ${str(p.next)} at ${str(p.next_time)}.` : `That's the block. Your afternoon's open.`),
      (p) => (p.next ? `Done here — ${str(p.next)} is at ${str(p.next_time)}.` : `Done here. Clear runway after this.`),
      (p) => (p.next ? `Block's over. Up next: ${str(p.next)}, ${str(p.next_time)}.` : `Block's over. Nothing queued next.`),
    ],
  },

  departure_prompt: {
    tier: 'fast', maxLen: 160, historyK: 30, lengthHint: LINE_HINT,
    required: (p) => [str(p.minutes_over)],
    facts: (p) =>
      `keeping this block ${str(p.minutes_over)} more minutes${p.next ? ` runs into "${str(p.next)}" at ${str(p.next_time)}` : ''}`,
    fallbacks: [
      (p) => `${str(p.minutes_over)} more minutes here runs into ${p.next ? str(p.next) : 'your next block'}.`,
      (p) => `That's ${str(p.minutes_over)} min past${p.next ? ` — ${str(p.next)} moves` : ''}. Push it?`,
      (p) => `Adding ${str(p.minutes_over)} min eats into ${p.next ? str(p.next) : 'what follows'}. Move it?`,
      (p) => `${p.next ? `${str(p.next)} is next; ` : ''}another ${str(p.minutes_over)} min shifts it.`,
    ],
  },

  calibration_chip: {
    tier: 'fast', maxLen: 120, historyK: 30, lengthHint: LINE_HINT,
    required: (p) => [str(p.suggested)],
    facts: (p) =>
      `${p.scope ? `"${str(p.scope)}" ` : ''}work tends to run ${p.direction === 'under' ? 'shorter' : 'longer'} than estimated; ` +
      `suggested=${str(p.suggested)} minutes${p.current != null ? `, current estimate=${str(p.current)}` : ''}`,
    fallbacks: [
      // Direction-aware: a scope can bias short OR long, so never hardcode "longer".
      (p) => `Similar work ran ${p.direction === 'under' ? 'shorter' : 'longer'} — try ${str(p.suggested)}m.`,
      (p) => `Your history points ${p.direction === 'under' ? 'below' : 'above'} this — nearer ${str(p.suggested)}m.`,
      (p) => `Past runs put this closer to ${str(p.suggested)}m.`,
      (p) => `Going by similar work, more like ${str(p.suggested)}m.`,
    ],
  },

  nudge: {
    tier: 'fast', maxLen: 160, historyK: 30, lengthHint: LINE_HINT,
    required: (p) => (p.datum != null ? [str(p.datum)] : []),
    facts: (p) => `${str(p.fact)}${p.datum != null ? ` (datum=${str(p.datum)})` : ''}`,
    fallbacks: [
      (p) => `${str(p.fact)}${p.datum != null ? ` — ${str(p.datum)}.` : '.'}`,
      (p) => `${p.datum != null ? `${str(p.datum)}: ` : ''}${str(p.fact)}.`,
      (p) => `A note: ${str(p.fact)}.`,
      (p) => `Worth a look — ${str(p.fact)}.`,
    ],
  },

  // Medium-tier narratives (§2V.1). These are short paragraphs, not one-liners, so
  // maxLen is a generous guardrail (not the brevity control — the prompt is). The
  // caller owns the deterministic fallback: it passes its rich `facts` for the model
  // AND a ready-to-show `fallback` paragraph (summarize.ts's fallbackProse /
  // fallbackEveningProse). The offline template emits that paragraph verbatim — a
  // hand-authored opener pool would be strictly worse than the real deterministic prose.
  daily_brief: {
    tier: 'quality', maxLen: 800, historyK: 14, lengthHint: PARA_HINT,
    required: () => [],
    facts: (p) => str(p.facts),
    fallbacks: [(p) => str(p.fallback) || str(p.facts)],
  },

  eod_alignment: {
    tier: 'quality', maxLen: 800, historyK: 14, lengthHint: PARA_HINT,
    required: () => [],
    facts: (p) => str(p.facts),
    fallbacks: [(p) => str(p.fallback) || str(p.facts)],
  },

  weekly_review: {
    tier: 'quality', maxLen: 900, historyK: 4, lengthHint: PARA_HINT,
    required: () => [],
    facts: (p) => str(p.facts),
    fallbacks: [(p) => str(p.fallback) || str(p.facts)],
  },

  // FTUE · T7 (#343) — the Plan-Week hybrid layer. Both surfaces follow the same
  // caller-supplies-facts-and-fallback shape as the narrative surfaces above: the
  // branch's own fixed deterministic question/option IS the fallback, verbatim.
  plan_week_followup: {
    tier: 'fast', maxLen: 160, historyK: 8,
    lengthHint: 'one short question, warm and specific, ending with a question mark',
    required: () => [],
    facts: (p) => str(p.facts),
    fallbacks: [(p) => str(p.fallback) || str(p.facts)],
  },
  plan_week_option: {
    tier: 'fast', maxLen: 48, historyK: 12,
    lengthHint: 'a terse answer chip, 2-5 words, no trailing period',
    required: () => [],
    facts: (p) => str(p.facts),
    fallbacks: [(p) => str(p.fallback) || str(p.facts)],
  },
};

/** The Voice rules card, embedded in every prompt (§2V.4). Shape/length is per-surface
 *  (see lengthHint) so the same voice covers a one-line nudge and a short paragraph.
 *
 *  The banned list is INTERPOLATED from voice-gate.ts, never retyped: it used to be a
 *  second hand-written copy, and it had already drifted — `seamlessly` and `lets` were
 *  enforced by the gate but never disclosed here, so a model obeying this card could
 *  still be rejected, burn its one regeneration (MODEL_ATTEMPTS), and push the surface
 *  onto the template pool. Exported so the test suite can assert the invariant that the
 *  drift can never come back: every BANNED_PHRASES entry appears in this card. */
export const VOICE_RULES = `You write app copy for a calm planning tool. Voice: warm, plain, brief.
Sentence case, contractions, verb-first. State the fact, then at most one light
forward nudge. No praise, no confetti, no exclamation marks, no emoji.
Never use: ${BANNED_PHRASES_PROMPT}. Reference the real numbers
and names given; never invent. Output ONLY the copy — no preamble, no quotes.`;

const MODEL_ATTEMPTS = 2; // initial draft + one regeneration (§2V.2: "regenerate once"; ceiling is ≤2 retries)

export interface RenderedCopy {
  text: string;
  source: 'model' | 'fallback';
  surface: Surface;
}

function buildPrompt(cfg: SurfaceConfig, p: Payload, recent: Signature[], failure?: string): string {
  const avoid = recent
    .map((s) => s.opener)
    .filter(Boolean)
    .slice(0, 8);
  return [
    VOICE_RULES,
    ``,
    `Facts: ${cfg.facts(p)}`,
    `Length: ${cfg.lengthHint} (hard cap ${cfg.maxLen} characters).`,
    avoid.length ? `Avoid opening like any of these recent lines: ${avoid.map((a) => `"${a}"`).join(', ')}.` : ``,
    `Vary the opener and structure from anything recent.`,
    failure ? `Your previous attempt was rejected (${failure}); fix that and try a different shape.` : ``,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Clean a model completion. For a one-line surface, take the first non-empty line
 * (a stray preamble line is dropped; VOICE_RULES already asks for no preamble). For a
 * paragraph surface, keep the whole thing — collapsing to one line would shear a 3-5
 * sentence brief. Surrounding quotes/backticks are stripped either way.
 */
function cleanLine(raw: string, multiline: boolean): string {
  const stripQuotes = (s: string) => s.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (multiline) {
    return stripQuotes(raw.trim().replace(/\n{3,}/g, '\n\n'));
  }
  const first = raw.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return stripQuotes(first);
}

async function readRecent(ownerId: string, surface: Surface, k: number): Promise<Signature[]> {
  const rows = await store()
    .prepare(`SELECT signature FROM copy_history WHERE owner_id = ? AND surface = ? ORDER BY id DESC LIMIT ?`)
    .all<{ signature: string }>(ownerId, surface, k);
  const out: Signature[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.signature) as Signature);
    } catch {
      /* a malformed row never blocks generation — skip it */
    }
  }
  return out;
}

async function record(ownerId: string, surface: Surface, sig: Signature, k: number): Promise<void> {
  await store()
    .prepare(`INSERT INTO copy_history (id, owner_id, surface, signature) VALUES (uuid7(), ?, ?, ?)`)
    .run(ownerId, surface, JSON.stringify(sig));
  // Prune the window back to K (newest kept; id is uuid7 → time-ordered).
  await store()
    .prepare(
      `DELETE FROM copy_history
        WHERE owner_id = ? AND surface = ? AND id NOT IN (
          SELECT id FROM copy_history WHERE owner_id = ? AND surface = ? ORDER BY id DESC LIMIT ?
        )`,
    )
    .run(ownerId, surface, ownerId, surface, k);
}

/**
 * Pick a fallback template whose signature isn't in the recent window; if every
 * template would repeat, rotate by window size so the choice still moves. This is
 * the escape hatch that keeps the offline path from ever feeling robotic (§2V.2).
 */
function pickFallback(cfg: SurfaceConfig, p: Payload, recent: Signature[]): { text: string; sig: Signature } {
  const rendered = cfg.fallbacks.map((f, i) => {
    const text = f(p);
    return { text, sig: computeSignature(text, i) };
  });
  const fresh = rendered.find((r) => !isRepetitive(r.sig, recent));
  if (fresh) return fresh;
  return rendered[recent.length % rendered.length];
}

/**
 * Render one human-facing line for `surface` from its deterministic `payload`.
 * Bounded, gate-checked, anti-repetitive, and Ollama-down-safe (never throws).
 */
export async function renderCopy(
  surface: Surface,
  payload: Payload,
  opts: { ownerId?: string } = {},
): Promise<RenderedCopy> {
  const cfg = SURFACES[surface];
  const ownerId = opts.ownerId ?? currentOwnerId();
  const required = cfg.required(payload);
  const recent = await readRecent(ownerId, surface, cfg.historyK);

  let failure: string | undefined;
  for (let attempt = 0; attempt < MODEL_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await generate(buildPrompt(cfg, payload, recent, failure), {
        // `voice` carries the temperature (microcopy wants variety; the gate enforces the
        // floor) and the fast-tier timeout. Tier is per-surface, and a quality-tier surface
        // needs a longer ceiling than the policy's — an explicit value overrides it.
        purpose: 'voice',
        tier: cfg.tier,
        ...(cfg.tier === 'quality' ? { timeoutMs: 45_000 } : {}),
      });
    } catch (err) {
      logger.warn('renderCopy: model unavailable, using fallback pool', { surface, err: (err as Error).message });
      break; // Ollama down → straight to the rotation pool
    }
    const text = cleanLine(raw, cfg.tier === 'quality');
    const g = gateCopy(text, { required, recent, maxLen: cfg.maxLen });
    if (g.ok) {
      await record(ownerId, surface, g.signature, cfg.historyK);
      return { text, source: 'model', surface };
    }
    failure = g.reason;
  }

  // The model produced text but the gate rejected every attempt (distinct from the
  // Ollama-down break above, which already logged). Surface the reason so a too-strict
  // rule / bad temperature that silently forces fallbacks is observable, not invisible.
  if (failure) logger.warn('renderCopy: gate rejected all model drafts, using fallback pool', { surface, reason: failure });

  // Escape hatch: deterministic rotation pool with datum-slotting.
  const fb = pickFallback(cfg, payload, recent);
  await record(ownerId, surface, fb.sig, cfg.historyK);
  return { text: fb.text, source: 'fallback', surface };
}
