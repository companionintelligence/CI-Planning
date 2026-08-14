/**
 * The never-invent rule every classifier applies — ONE implementation.
 *
 * The rule: take the model's answer, keep only names that exist in the OWNER's
 * vocabulary, use the casing from the vocabulary (never the model's), dedupe, cap.
 * Anything the model made up is dropped silently — a suggester that can mint new
 * directions, categories, or tags is not a suggester, it is a second author of the
 * user's taxonomy.
 *
 * Kept in one module (rather than inline in each agent) for the same reason as
 * `rubric.ts` next door: quick-add's overlay, the Auto-tag sweep, and the memory
 * enrichment pass were each carrying their own copy, and the copies had already drifted
 * (one deduped on the canonical name, one on its lowercase — equivalent only while
 * canonical names stay unique case-insensitively). One rule, one place, no drift.
 *
 * The dedupe key is `toLowerCase()` everywhere: strictly the safer of the two, because a
 * vocabulary that ever gains "Finance" and "finance" must still yield one pick, not two.
 *
 * This is model-FACING behaviour: it decides which of the model's answers survive, so a
 * change here changes what every classifier writes. Treat edits as behaviour changes.
 *
 * The vocabulary itself is NOT derived here — `suggestibleVocabulary`
 * (services/tags.ts) is the single source for what the owner actually has, muted
 * excluded. This module only constrains an answer TO a vocabulary it is handed.
 */

/**
 * Canonical names from `vocabulary` that the model actually picked. Unknown names
 * dropped, casing from the vocabulary, deduped case-insensitively, capped at `max`.
 * Order follows the MODEL's answer (best fit first is the model's job, not ours).
 * A non-array answer, a non-string element, or an empty vocabulary yields `[]` — never
 * a throw, because every caller here is a best-effort overlay.
 */
export function constrainToVocabulary(raw: unknown, vocabulary: string[], max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const byLower = new Map(vocabulary.map((v) => [v.toLowerCase(), v]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= max) break;
    if (typeof v !== 'string') continue;
    const canonical = byLower.get(v.trim().toLowerCase());
    if (canonical && !seen.has(canonical.toLowerCase())) {
      seen.add(canonical.toLowerCase());
      out.push(canonical);
    }
  }
  return out;
}

/**
 * The single vocabulary name the model picked, canonical-cased, or null. Defined as
 * the one-slot case of `constrainToVocabulary` on purpose — "is this name real" must
 * not be able to answer differently depending on which helper the caller reached for.
 */
export function constrainOne(raw: unknown, vocabulary: string[]): string | null {
  return constrainToVocabulary([raw], vocabulary, 1)[0] ?? null;
}

/**
 * What a classifier's JSON answer may contain, across every enrichment surface — the
 * union of the fields quick-add's overlay and the memory pass each ask for. Deliberately
 * `unknown` for anything a model could get wrong: these are the fields the constraining
 * above (and the `rubric.ts` guards) exist to validate, so typing them as `string` here
 * would be asserting exactly what is not yet known. Nothing constructs this type — it is
 * only ever the shape a `generateJson` reply is READ through.
 */
export interface EnrichOut {
  description?: unknown;
  estimatedMinutes?: number | null;
  priority?: number | null;
  direction?: unknown;
  tags?: unknown;
  categories?: unknown;
  timeOfDay?: unknown;
  timeOfDayReason?: unknown;
  isComplex?: unknown;
  motivation?: unknown;
}
