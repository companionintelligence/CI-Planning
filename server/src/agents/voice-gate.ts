/**
 * Phase Z · Z7 (Time-Sense) — the Voice loop's deterministic gate (spec §2V.2 step 4).
 *
 * This is the EVALUATOR, and it is deliberately code, never a model: length cap,
 * banned-phrase list, required-datum presence, and a repetition check against the
 * recent-history window. Keeping it pure and model-free is the "generator ≠
 * evaluator" guarantee from [feedback_ai_in_the_loop] — the thing that drafts a line
 * can never also be the thing that judges it. Everything here is synchronous and
 * import-free of the Ollama seam so it stays trivially testable.
 */

/**
 * Words/phrases banned from system copy (§2V.4). Motivational-poster tone, filler,
 * and hype. Matched case-insensitively on word boundaries so "adjust" isn't caught
 * by "just". Multi-word entries match as phrases.
 */
export const BANNED_PHRASES = [
  'successfully', 'simply', 'just', 'unlock', 'leverage', 'seamless', 'seamlessly',
  'empower', 'great job', 'keep it up', "you've got this", "let's", 'lets',
] as const;

/**
 * The banned list as prompt text, so the model is TOLD exactly what the gate ENFORCES.
 * Derived from `BANNED_PHRASES` — there is no second, hand-typed list to drift from it,
 * and adding a word above changes the prompt with no second edit.
 *
 * It lives HERE rather than beside the prompt because the gate is the enforcer and the
 * enforcer must be the source: generator ≠ evaluator (see the module note above) means
 * this module may never import from render-copy.ts, so the shared string comes this way.
 *
 * Multi-word entries and the apostrophe forms are quoted, so the run-on reads as discrete
 * items rather than one clause. This is PROMPT TEXT: editing it — or the array it derives
 * from — changes model behaviour, so treat edits as behaviour changes and re-test against
 * a live model (same rule as agents/rubric.ts:13-17).
 */
export const BANNED_PHRASES_PROMPT: string = BANNED_PHRASES.map((p) =>
  /[\s']/.test(p) ? `"${p}"` : p,
).join(', ');

const BANNED_RE = new RegExp(
  `\\b(?:${BANNED_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

// Emoji / pictographic symbols — banned on system copy (§2V.4). Covers the common
// emoji blocks without needing the /u flag's property escapes on older targets.
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F0FF}]/u;

/** A phrasing fingerprint stored per owner×surface (§2V.3). */
export interface Signature {
  /** Normalized first-three-words opener. */
  opener: string;
  /** Word-trigram set (sorted, de-duped) — the shape of the sentence. */
  trigrams: string[];
  /** Fallback-pool template index, when the line came from the rotation pool. */
  template?: number;
}

/** Repetition thresholds (§2V.2). A same opener OR a high trigram overlap = a repeat. */
export const REPEAT_JACCARD = 0.6;

/** lowercase, strip punctuation, collapse whitespace → comparable tokens. */
export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The phrasing signature of a line: opener + word-trigrams (§2V.3). */
export function computeSignature(text: string, template?: number): Signature {
  const toks = normalizeTokens(text);
  const opener = toks.slice(0, 3).join(' ');
  const trigrams = new Set<string>();
  if (toks.length < 3) {
    if (toks.length) trigrams.add(toks.join(' ')); // short line: the whole thing is its gram
  } else {
    for (let i = 0; i + 3 <= toks.length; i++) trigrams.add(toks.slice(i, i + 3).join(' '));
  }
  return { opener, trigrams: [...trigrams].sort(), ...(template != null ? { template } : {}) };
}

/** Jaccard overlap of two trigram sets (1 = identical, 0 = disjoint). */
export function trigramSimilarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sb = new Set(b);
  let inter = 0;
  for (const t of a) if (sb.has(t)) inter++;
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/** True if `sig` repeats any signature in the recent window (same opener or high overlap). */
export function isRepetitive(sig: Signature, recent: Signature[]): boolean {
  for (const r of recent) {
    if (r.opener && r.opener === sig.opener) return true;
    if (trigramSimilarity(sig.trigrams, r.trigrams) >= REPEAT_JACCARD) return true;
  }
  return false;
}

export interface GateInput {
  /** Payload datum strings that MUST appear verbatim in the line (e.g. the actual time). */
  required: readonly string[];
  /** The recent signatures for this owner×surface. */
  recent: readonly Signature[];
  /** Length budget for the surface (characters). */
  maxLen: number;
}

export interface GateResult {
  ok: boolean;
  /** Machine reason on failure — fed back into the regeneration prompt. */
  reason?: 'empty' | 'too_long' | 'banned' | 'missing_datum' | 'repetitive';
  signature: Signature;
}

/**
 * Run the deterministic gate over a candidate line. Pure: same inputs → same result,
 * no model, no clock, no I/O. Order matters only for which reason surfaces first;
 * any failure means regenerate-or-fall-back.
 */
export function gateCopy(text: string, input: GateInput): GateResult {
  const trimmed = text.trim();
  const signature = computeSignature(trimmed);
  if (!trimmed) return { ok: false, reason: 'empty', signature };
  if (trimmed.length > input.maxLen) return { ok: false, reason: 'too_long', signature };
  if (BANNED_RE.test(trimmed) || EMOJI_RE.test(trimmed)) return { ok: false, reason: 'banned', signature };
  for (const datum of input.required) {
    if (datum && !trimmed.includes(datum)) return { ok: false, reason: 'missing_datum', signature };
  }
  if (isRepetitive(signature, [...input.recent])) return { ok: false, reason: 'repetitive', signature };
  return { ok: true, signature };
}
