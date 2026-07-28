import { generateJson } from '../mcp/ollama.js';
import type { ParsedQuick } from '../engine/quickadd.js';
import {
  directionGuide, isTimeOfDay, titleSuggestsComplex,
  PRIORITY_RUBRIC, DURATION_RUBRIC, TIME_OF_DAY_RUBRIC, COMPLEXITY_RUBRIC,
} from './rubric.js';

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
 *
 * 2026-07-27: the classification is now RUBRIC-GROUNDED (agents/rubric.ts) and returns
 * three more fields —
 *  - `priority` against explicit P1–Later qualifiers with an explicit "unsure ⇒ 3"
 *    default (the old prompt said only "1 is highest", so the model guessed high and
 *    the priority axis carried no signal);
 *  - `timeOfDay`: a BAND (never a clock time — D3), dropped when the entry already
 *    stated a time and when the answer is the contentless "any";
 *  - `isComplex`: gates the separate suggest-only subtask call (agents/subtasks.ts).
 * All three remain preview-only: /api/tasks/quick/parse writes nothing, so the wizard
 * shows them for approval before anything is created.
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
  timeOfDay?: unknown;
  timeOfDayReason?: unknown;
  isComplex?: unknown;
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

  // D3 — band only, and only when the parser found no explicit clock time. An entry that
  // said "standup at 9" already has taskTime; a band on top of it would be noise at best
  // and a contradictory hint at worst. 'any' is dropped: it carries no information and a
  // stored 'any' would render as a suggestion the user has to dismiss.
  const band = isTimeOfDay(out.timeOfDay) && out.timeOfDay !== 'any' ? out.timeOfDay : undefined;
  const timeOfDay = parsed.timeOfDay ?? (parsed.taskTime ? undefined : band);
  const reason =
    timeOfDay && typeof out.timeOfDayReason === 'string' && out.timeOfDayReason.trim()
      ? out.timeOfDayReason.trim().slice(0, 120)
      : undefined;

  // Complexity only gates the separate subtask call — it is never written to the task.
  // Model OR deterministic verb signal: llama3.2 applies its own verb rule ~4/6, so the
  // mechanical half of the rubric is enforced in code (titleSuggestsComplex) and the
  // model can only ADD verdicts the verb list misses, never lose the obvious ones.
  const isComplex =
    parsed.isComplex ?? (out.isComplex === true || titleSuggestsComplex(parsed.title) ? true : undefined);

  return {
    ...parsed,
    estimatedMinutes,
    priority,
    tags,
    ...(categories !== undefined ? { categories } : {}),
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(reason ? { timeOfDayReason: reason } : {}),
    ...(isComplex ? { isComplex } : {}),
  };
}

// The direction definitions moved to agents/rubric.ts (2026-07-27) so the Auto-tag sweep
// and the memory pass classify the axis identically — three copies of "what Home means"
// is exactly how a classifier starts contradicting itself between surfaces.

export async function enrichQuick(
  text: string,
  parsed: ParsedQuick,
  vocab: QuickVocab = { directions: [], others: [] },
): Promise<ParsedQuick> {
  const hasCats = (vocab.categories?.length ?? 0) > 0;
  // Layout matters as much as wording here. Measured 2026-07-27 against llama3.2: with
  // the schema up front and all four rubrics stacked at the end, the LAST rule
  // (complexity) was reliably ignored — "Plan a week-long trip to Japan" came back
  // isComplex:false, while the same rule in a short prompt answered true. So each rule
  // now sits IMMEDIATELY AFTER the field it governs. A 3B model follows adjacent
  // instructions far better than a rulebook it has to cross-reference.
  const out = await generateJson<EnrichOut>(
    `Classify this quick task entry. Reply with JSON with exactly these keys.\n` +
      `"direction": REQUIRED — exactly one of ${JSON.stringify(vocab.directions)}. ` +
      `Every task has a direction, always choose one.${directionGuide(vocab.directions)}\n` +
      `"isComplex": true or false. ${COMPLEXITY_RUBRIC}\n` +
      `"priority": 1-4. ${PRIORITY_RUBRIC}\n` +
      `"estimatedMinutes": a number or null. ${DURATION_RUBRIC}\n` +
      `"timeOfDay": one of "morning","afternoon","evening","any". ${TIME_OF_DAY_RUBRIC}\n` +
      `"timeOfDayReason": a few words on why, or null.\n` +
      (hasCats ? `"categories": 1-3 life areas from ${JSON.stringify(vocab.categories)}, best fit first.\n` : '') +
      `"tags": up to 2 from ${JSON.stringify(vocab.others.slice(0, 60))}, else [].\n` +
      `Choose direction/categories/tags ONLY from the given lists — never invent.\n` +
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
