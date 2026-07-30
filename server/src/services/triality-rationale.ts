import { DEFAULT_WEIGHTS, type ScoredPick, type Slot } from './triality.js';
import { DIM_REGISTRY, type DimName, type SituationVector } from './triality-vector.js';
import { generateJson, status } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';

/**
 * Triality T9 — the optional rationale GARNISH (design §8: "labeled as AI,
 * template fallback, never blocking").
 *
 * The two-clocks doctrine (§2) is the whole architecture of this file: the
 * deterministic engine defends the day, the LLM only garnishes. Consequences,
 * each of them load-bearing:
 *
 *  - This module is attached AFTER `trialityNext` has returned. It imports FROM
 *    services/triality.ts (the pick shape and the default weights) and nothing in
 *    the scoring path imports it back — so picks, slots, ordering and every score
 *    number are byte-identical whether this runs, fails, or is disabled.
 *  - **The deterministic template is the spec.** It is computed first, always,
 *    for every pick, from the score breakdown plus the situation vector's fired
 *    dims. The model can only ever REPLACE a template line; it never authors the
 *    only line, so a pick is never left unexplained.
 *  - At most ONE model call per request covers all three picks in one constrained
 *    JSON round trip, inside a hard total budget. Unreachable, slow, or garbage
 *    Ollama ⇒ templates, no throw, no stall past the budget.
 *  - Ollama only (the local-first invariant) — there is no other provider seam
 *    here, by construction.
 */

export type RationaleSource = 'ai' | 'template';

export interface Rationale {
  text: string;
  /** Honest labelling (§9 "AI Briefing" vs "Day Overview"): never unlabeled, and
   *  never 'ai' for a line the template produced. */
  source: RationaleSource;
}

/** Total wall-clock budget for the garnish, probe INCLUDED — a suggestion banner
 *  that waits on inference is a broken banner, so the deadline is the contract. */
const BUDGET_MS = 5_000;
/** Below this much remaining budget, skip the call rather than start one that
 *  will almost certainly abort mid-flight. */
const MIN_CALL_MS = 500;
/** One line, and short enough to sit under a pill without reflowing it. */
const MAX_CHARS = 140;
/** What the model is asked for — deliberately under MAX_CHARS so a slightly
 *  over-eager answer still survives sanitization instead of being truncated. */
const ASK_CHARS = 110;

export interface RationaleOpts {
  /**
   * Injectable one-shot generator (the possibles.ts embedFn idiom). `null`
   * disables the AI attempt entirely — the "disabled" arm of the invariance
   * contract, and what tests use to prove the templates stand alone.
   */
  generateFn?: ((prompt: string, timeoutMs: number) => Promise<unknown>) | null;
  /** Cheap availability gate. Default: Ollama's own `ready` (reachable AND the
   *  models that would actually be used are pulled — `available` alone was the
   *  green light that lied, see mcp/ollama.ts). */
  availableFn?: () => Promise<boolean>;
  /** Monotonic-ish millisecond clock for the BUDGET only (never a date — the
   *  no-wall-clock rule is about testable time, and the budget is testable). */
  clockMs?: () => number;
  budgetMs?: number;
}

// ── The deterministic template (THE spec) ─────────────────────────────────────

/**
 * Component wording. Keyed by the component letters the engine already
 * persists, so adding a component to §5 fails loudly here rather than silently
 * producing an unexplained pick.
 */
const COMPONENT_CLAUSE: Record<keyof ScoredPick['scores'] & string, string> = {
  F: 'Fits your current situation',
  H: 'Something you do often',
  Q: 'Usually follows what you just finished',
  N: 'Unlike your usual pattern',
  C: 'Comfortably fits the time you have',
  total: '', // never selected — `total` is the ranking, not a component
};

/** Fixed component order: the tie-break when two components score identically. */
const COMPONENT_ORDER = ['F', 'H', 'Q', 'N', 'C'] as const;

const DIM_WORDS: Partial<Record<DimName, { pos: string; neg: string }>> = {
  in_work_hours: { pos: "you're inside work hours", neg: "you're outside work hours" },
  day_energy: { pos: 'your last check-in was upbeat', neg: 'your last check-in was rough' },
  free_gap: { pos: 'you have a clear stretch ahead', neg: 'your next fixed block is close' },
  day_type: { pos: 'today is a work day', neg: 'today is a rest day' },
  momentum: { pos: "you're already moving", neg: "you've been idle a while" },
  memory_context: { pos: 'something related is coming up', neg: 'nothing related is coming up' },
  motivation_balance: {
    pos: "lately you've been working mostly for others",
    neg: "lately you've been working mostly for yourself",
  },
};

function dimWords(name: DimName): { pos: string; neg: string } | null {
  const known = DIM_WORDS[name];
  if (known) return known;
  if (name.startsWith('cat_deficit_')) {
    const cat = name.slice('cat_deficit_'.length);
    return { pos: `${cat} is under-served`, neg: `${cat} is over-served` };
  }
  return null;
}

/**
 * The component this pick was chosen ON: the highest raw score among the
 * components the SLOT actually weights.
 *
 * Restricting to non-zero DEFAULT weights (never the learned ones) is what keeps
 * the wording stable under §6b learning: the clamps are multiplicative
 * (0.5×…2× of the default), so a zero default stays zero forever — the SET of
 * components a slot uses is learning-invariant even though the magnitudes are
 * not. Naming Q as the reason for a Contextual pick, which weights Q at 0, would
 * be a lie the arithmetic never told.
 */
function dominantComponent(pick: ScoredPick): (typeof COMPONENT_ORDER)[number] | null {
  const weights = DEFAULT_WEIGHTS[pick.slot];
  let best: (typeof COMPONENT_ORDER)[number] | null = null;
  for (const k of COMPONENT_ORDER) {
    if (!(weights[k] > 0)) continue;
    const v = pick.scores[k];
    if (!(v > 0)) continue; // an all-zero pool must not get a confident reason
    if (best === null || v > pick.scores[best]) best = k;
  }
  return best;
}

/**
 * The situation dim to cite: the first non-zero dim, in the dim registry's own
 * declared order, that was also ACTIVE (its source present/enabled).
 *
 * Registry order is the tie-break because in a balanced-ternary space every
 * fired dim has the same magnitude — there is no "strongest" to measure, so the
 * only honest ordering is the one the registry already fixes. Requiring
 * `meta.active` too keeps the honest zero honest: a dim whose source is off
 * never gets quoted as a reason.
 */
function firedDimClause(vector: SituationVector): string | null {
  const active = new Set(vector.meta.active);
  for (const dim of DIM_REGISTRY) {
    if (!active.has(dim.name)) continue;
    const v = vector.dims[dim.name];
    if (v === 0) continue;
    const words = dimWords(dim.name);
    if (!words) continue;
    return v > 0 ? words.pos : words.neg;
  }
  return null;
}

/**
 * WORDING RULE (the spec, one sentence):
 *
 *   "<dominant component clause>, and <fired dim clause>."
 *
 * The dim half is dropped — sentence ending after the component — when nothing
 * in the situation fired. When no weighted component scored above zero the
 * component half becomes "No single component stood out", because the Metrics
 * tab's founding rule applies to prose too: where there is no signal, say so
 * rather than inventing a confident reason.
 */
export function templateRationale(pick: ScoredPick, vector: SituationVector): string {
  const comp = dominantComponent(pick);
  const head = comp ? COMPONENT_CLAUSE[comp] : 'No single component stood out';
  const dim = firedDimClause(vector);
  return dim ? `${head}, and ${dim}.` : `${head}.`;
}

// ── The garnish (one call, hard budget, never throws) ─────────────────────────

/** One line, trimmed, unquoted, ≤ MAX_CHARS — or null when unusable (which
 *  means: keep the template). The plan.ts sanitizeRationale posture. */
function sanitize(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const oneLine = v
    .replace(/\s+/g, ' ')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .trim();
  if (!oneLine) return null;
  return oneLine.length > MAX_CHARS ? `${oneLine.slice(0, MAX_CHARS - 1)}…` : oneLine;
}

/**
 * Prompt layout is measured, not stylistic (HANDOFF-2026-07-27 §5 and
 * agents/quickadd.ts): the OUTPUT SHAPE goes first, every rule sits immediately
 * after the thing it governs, and nothing load-bearing trails the data — a 3B
 * model reliably ignores the last rule in a stacked rulebook. There is also no
 * refusal clause: an unusable answer is dropped by `sanitize`, never negotiated.
 */
function buildPrompt(items: { slot: Slot; title: string; facts: string }[]): string {
  const shape = `{${items.map((i) => `"${i.slot}":"<sentence>"`).join(',')}}`;
  return (
    `Reply with JSON only, exactly these keys: ${shape}\n` +
    `Each value: ONE plain sentence, at most ${ASK_CHARS} characters, addressed to the reader, ` +
    `no numbers, no scores, no markdown, no quotes.\n` +
    `Each value must REPHRASE ONLY the facts listed for that key — never add a reason that is not listed.\n` +
    items.map((i) => `${i.slot}: action ${JSON.stringify(i.title)} — facts: ${i.facts}`).join('\n')
  );
}

/**
 * Compute a rationale for every pick, parallel to `picks` (null where the slot
 * is honestly empty). Templates first and always; then AT MOST ONE model call
 * replaces the lines it answers usably.
 *
 * Never throws — a garnish that can break the suggestion surface is not a
 * garnish. `vector` is the one the engine actually used, so the cited dim is the
 * dim that actually fired.
 */
export async function attachRationales(
  picks: (ScoredPick | null)[],
  vector: SituationVector,
  opts: RationaleOpts = {},
): Promise<(Rationale | null)[]> {
  const out: (Rationale | null)[] = picks.map((p) =>
    p ? { text: templateRationale(p, vector), source: 'template' as const } : null,
  );
  if (opts.generateFn === null) return out;

  // NOTHING TO GARNISH ⇒ RETURN BEFORE THE PROBE. The default availability gate
  // is a network fetch with a multi-second abort, so ordering is not cosmetic:
  // probing first made three empty slots cost up to the whole BUDGET_MS to
  // produce three nulls. No picks ⇒ no prompt is constructible ⇒ nothing the
  // probe's answer could change.
  const items = picks.flatMap((p, i) =>
    p ? [{ slot: p.slot, title: p.title, facts: out[i]!.text, index: i }] : [],
  );
  if (items.length === 0) return out;

  const clock = opts.clockMs ?? Date.now;
  const budget = opts.budgetMs ?? BUDGET_MS;
  const startedAt = clock();
  const remaining = () => budget - (clock() - startedAt);

  try {
    // Cheap gate before paying for inference: `ready`, not `available` — a
    // reachable Ollama whose model isn't pulled fails every call.
    const available = opts.availableFn ?? (async () => (await status()).ready);
    if (!(await available())) return out;
    const callBudget = remaining();
    if (callBudget < MIN_CALL_MS) {
      logger.info('triality: rationale budget spent on the availability probe — templates only');
      return out;
    }

    const generate =
      opts.generateFn ??
      ((prompt: string, timeoutMs: number) =>
        generateJson<unknown>(prompt, { tier: 'small', temperature: 0.3, timeoutMs }));

    const raw = await generate(buildPrompt(items), callBudget);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const bySlot = raw as Record<string, unknown>;
    for (const item of items) {
      const text = sanitize(bySlot[item.slot]);
      if (text) out[item.index] = { text, source: 'ai' };
    }
  } catch (err) {
    // Unreachable, timed out, unparseable — the templates are already in `out`.
    logger.info('triality: rationale garnish unavailable — templates stand', {
      err: (err as Error).message,
    });
  }
  return out;
}
