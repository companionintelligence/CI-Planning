import { generateJson } from '../mcp/ollama.js';
import type { ParsedQuick } from '../engine/quickadd.js';

/**
 * Optional best-effort overlay on the deterministic parse: a small local model
 * fills ONLY metadata the parser couldn't. It never overrides a field the parser
 * set (title/dates/explicit #tags stay authoritative), and any failure (Ollama
 * down, bad JSON) must be caught by the caller, which then keeps the
 * deterministic result. This keeps quick-add reproducible.
 *
 * 2026-07-20 (owner request): the overlay now also CLASSIFIES the task —
 *  - `direction`: exactly one of the owner's direction tags (Work/Home/Community),
 *    added only when the entry didn't name one itself;
 *  - `tags`: up to two of the owner's EXISTING other tags (never invented —
 *    same constrained-vocabulary rule as agents/tags.ts suggestTags).
 * Dates stay deterministic on purpose: chrono owns them; a small model inventing
 * "next Tuesday" from "call mom" would be a lie, not an enrichment.
 */

export interface QuickVocab {
  /** The owner's direction-tag names (kind='direction'): Work / Home / Community. */
  directions: string[];
  /** The owner's category names (kind='category') — the six Balance dimensions
   *  (Phase B). A separate axis so a category pick can never leak into the
   *  intention tags (and vice versa). */
  categories?: string[];
  /** Every other existing tag name the owner has (intentions, …). */
  others: string[];
}

interface EnrichOut {
  estimatedMinutes?: number | null;
  priority?: number | null;
  direction?: string | null;
  tags?: unknown;
  categories?: unknown;
}

/**
 * Pure merge of the model's suggestion onto the deterministic parse — exported
 * for unit tests. Constrained: `direction` must name an existing direction tag
 * (case-insensitive) and is skipped when the entry already carries one; `tags`
 * must name existing non-direction tags, capped at two, deduped against the
 * parse. Explicit parsed fields always win.
 */
export function mergeEnrichment(parsed: ParsedQuick, out: EnrichOut, vocab: QuickVocab): ParsedQuick {
  const estimatedMinutes =
    parsed.estimatedMinutes ?? (typeof out.estimatedMinutes === 'number' ? out.estimatedMinutes : undefined);
  const priority =
    parsed.priority ?? (out.priority && out.priority >= 1 && out.priority <= 5 ? out.priority : undefined);

  const have = new Set(parsed.tags.map((t) => t.toLowerCase()));
  const tags = [...parsed.tags];

  // Direction: only when the entry didn't already name one of the owner's
  // direction tags; the model's pick must match an existing direction (canonical
  // casing comes from the vocabulary, not the model).
  const dirByLower = new Map(vocab.directions.map((d) => [d.toLowerCase(), d]));
  const hasDirection = parsed.tags.some((t) => dirByLower.has(t.toLowerCase()));
  if (!hasDirection && typeof out.direction === 'string') {
    const canonical = dirByLower.get(out.direction.trim().toLowerCase());
    if (canonical && !have.has(canonical.toLowerCase())) {
      tags.push(canonical);
      have.add(canonical.toLowerCase());
    }
  }

  // Secondary tags: existing non-direction tags only, max two, deduped.
  const otherByLower = new Map(vocab.others.map((t) => [t.toLowerCase(), t]));
  if (Array.isArray(out.tags)) {
    let added = 0;
    for (const raw of out.tags) {
      if (added >= 2) break;
      if (typeof raw !== 'string') continue;
      const canonical = otherByLower.get(raw.trim().toLowerCase());
      if (canonical && !have.has(canonical.toLowerCase())) {
        tags.push(canonical);
        have.add(canonical.toLowerCase());
        added++;
      }
    }
  }

  // Categories (Phase B): 1–3 of the owner's category names — its OWN axis, never
  // mixed into `tags` (a model pick of "finance" must become a category, not an
  // intention). Same constrained-vocabulary rule: canonical casing from the vocab,
  // unknown names dropped, deduped, capped at 3. A parse that already carries
  // categories (future syntax) wins.
  let categories = parsed.categories;
  if (!categories?.length && Array.isArray(out.categories)) {
    const catByLower = new Map((vocab.categories ?? []).map((c) => [c.toLowerCase(), c]));
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const raw of out.categories) {
      if (picked.length >= 3) break;
      if (typeof raw !== 'string') continue;
      const canonical = catByLower.get(raw.trim().toLowerCase());
      if (canonical && !seen.has(canonical.toLowerCase())) {
        picked.push(canonical);
        seen.add(canonical.toLowerCase());
      }
    }
    if (picked.length) categories = picked;
  }

  return { ...parsed, estimatedMinutes, priority, tags, ...(categories !== undefined ? { categories } : {}) };
}

// The three directions are fixed by provisioning (owners.ts) — Work/Home/Community —
// but bare labels alone under-specify the axis for a small model (e.g. "Dad's
// birthday" reads as ambiguous and gets force-fit to "Work" without grounding).
// Definitions give it the semantic split the owner actually means by each name.
const DIRECTION_HINTS: Record<string, string> = {
  work: 'Work — job/professional obligations (meetings, deliverables, career tasks).',
  home: 'Home — personal, household, and family life (errands, chores, family events like birthdays, self-care).',
  community: 'Community — social and civic life outside work/family (friends, volunteering, group events).',
};

function directionGuide(directions: string[]): string {
  const lines = directions
    .map((d) => DIRECTION_HINTS[d.toLowerCase()])
    .filter((h): h is string => Boolean(h));
  return lines.length ? ` Direction meanings — ${lines.join(' ')}` : '';
}

export async function enrichQuick(
  text: string,
  parsed: ParsedQuick,
  vocab: QuickVocab = { directions: [], others: [] },
): Promise<ParsedQuick> {
  const hasCats = (vocab.categories?.length ?? 0) > 0;
  const out = await generateJson<EnrichOut>(
    `Classify this quick task entry. Reply with JSON ` +
      `{"estimatedMinutes": <minutes or null>, "priority": <1-5 or null>, ` +
      `"direction": <REQUIRED — exactly one of ${JSON.stringify(vocab.directions)}, pick the closest fit>, ` +
      (hasCats ? `"categories": <1-3 life areas from ${JSON.stringify(vocab.categories)}, best fit first>, ` : '') +
      `"tags": <up to 2 from ${JSON.stringify(vocab.others.slice(0, 60))}, else []>}. ` +
      `1 is highest priority. Every task has a direction — always choose one.${directionGuide(vocab.directions)} ` +
      `Choose direction/categories/tags ONLY from the given lists — never invent. ` +
      `Entry: "${text}"`,
    { tier: 'small', temperature: 0.1, timeoutMs: 15_000 }
  );

  let merged = mergeEnrichment(parsed, out, vocab);

  // Second chance (owner request: ALWAYS attempt a direction): when the first pass
  // yielded none, ask once more with a single-field prompt — small models answer a
  // narrow question far more reliably than a wide one. Still constrained: an
  // invalid answer is dropped by the same merge, never invented.
  const dirLower = new Set(vocab.directions.map((d) => d.toLowerCase()));
  const hasDirection = merged.tags.some((t) => dirLower.has(t.toLowerCase()));
  if (!hasDirection && vocab.directions.length > 0) {
    const retry = await generateJson<{ direction?: string | null }>(
      `Which area of life does this task belong to? Answer with JSON ` +
        `{"direction": <exactly one of ${JSON.stringify(vocab.directions)}>}.${directionGuide(vocab.directions)} ` +
        `Task: "${text}"`,
      { tier: 'small', temperature: 0.1, timeoutMs: 15_000 }
    );
    merged = mergeEnrichment(merged, { direction: retry.direction }, vocab);
  }

  return merged;
}
