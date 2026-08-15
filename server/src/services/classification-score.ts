import { generateJson, llmOrNull, ollama } from '../mcp/ollama.js';
import { constrainToVocabulary } from '../agents/constrain.js';
import { MOTIVATION_RUBRIC, isMotivation } from '../agents/rubric.js';
import { suggestibleVocabulary } from './tags.js';
import { canonicalValue, type ScoreFn } from './classification-learning.js';

/**
 * The grader `calibrate_classification` measures itself with (Phase 8, plan point 4:
 * "better" is measured, not vibes).
 *
 * It asks the model the SAME question the enrichment path asks, with the same rubric
 * text and the same exemplar hint, and nothing else — no memory graph, no description
 * task. That isolation is deliberate: an old held-out task's knowledge-graph context is
 * long gone and unreproducible, so scoring the full enrichment prompt would measure
 * drift in the graph rather than in the thing learning actually changes. What varies
 * between runs here is the exemplar set, which is exactly what the trend should track.
 *
 * Returns `undefined` when Ollama cannot answer at all, which the calibration reads as
 * "not measured" and records as a null accuracy — a gap in the trend, never a zero.
 */

/** Categories a scored answer may name, matching the enrichment path's cap. */
const MAX_CATEGORIES = 3;

export async function ollamaScorer(owner: string): Promise<ScoreFn | undefined> {
  if (!(await ollama.isReady())) return undefined;
  const vocab = await suggestibleVocabulary(owner);

  return async ({ field, inputText, hint }) => {
    if (field === 'category') {
      // No category vocabulary ⇒ there is no right answer to grade against, so decline
      // rather than score every example wrong.
      if (vocab.categories.length === 0) return null;
      const out = await llmOrNull('classification-score:category', () =>
        generateJson<{ categories?: unknown }>(
          `Classify this task into the user's life-balance categories.\n` +
            `Reply with JSON {"categories": <1-${MAX_CATEGORIES} from ${JSON.stringify(vocab.categories)}, best fit first>}. ` +
            `Choose ONLY from the given list — never invent; [] when none fit.` +
            hint +
            `\nTask: "${inputText}"`,
          { purpose: 'classify' },
        ),
      );
      if (!out) return null;
      const picked = constrainToVocabulary(out.categories, vocab.categories, MAX_CATEGORIES);
      return picked.length ? canonicalValue(picked) : null;
    }

    const out = await llmOrNull('classification-score:motivation', () =>
      generateJson<{ motivation?: unknown }>(
        `Who is this task for? Reply with JSON {"motivation": <"me" | "us" | "them" | null>}. ` +
          MOTIVATION_RUBRIC +
          hint +
          `\nTask: "${inputText}"`,
        { purpose: 'classify' },
      ),
    );
    const v = out?.motivation;
    return isMotivation(v) ? v : null;
  };
}
