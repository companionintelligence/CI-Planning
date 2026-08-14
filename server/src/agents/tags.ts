import { generateJson } from '../mcp/ollama.js';
import { directionGuide } from './rubric.js';
import { constrainToVocabulary } from './constrain.js';

/**
 * Best-effort LLM tag suggestion for the New Task wizard and the Tasks Auto-tag sweep,
 * CONSTRAINED to the user's existing tag vocabulary — it never invents new tags. Returns
 * `[]` on any failure (Ollama unavailable, bad JSON, empty input), so callers degrade to
 * the deterministic heuristic with no error surfaced. Keeps task creation reproducible:
 * this only ever *adds* suggestions the user can toggle off.
 *
 * The prompt is GROUNDED (2026-07-27): it used to hand the model a bare list of names and
 * ask which "best describe" the task, which reduces to fuzzy string similarity — "Call
 * dad" would sooner match a tag literally named "call" than be recognised as Home. Naming
 * the direction axis and defining Work/Home/Community turns it into a semantic judgement,
 * which is the whole point of asking a model rather than running the substring heuristic
 * that already backs this call.
 *
 * `directions` is optional so the wizard's plain "suggest some tags" path is unchanged
 * when the caller has no direction vocabulary to offer.
 */
export async function suggestTags(
  title: string,
  vocabulary: string[],
  directions: string[] = [],
): Promise<string[]> {
  if (!title.trim() || vocabulary.length === 0) return [];
  // Only ground the axis when the offered vocabulary actually contains those directions —
  // defining Work/Home/Community while none are pickable would invite the model to answer
  // with a name that the allowlist below then silently drops.
  const pickable = directions.filter((d) => vocabulary.some((v) => v.toLowerCase() === d.toLowerCase()));
  const guide = pickable.length
    ? ` One of these is the task's life area — choose the single best fit for it, plus any other tags that genuinely apply.${directionGuide(pickable)}`
    : '';
  try {
    const out = await generateJson<{ tags?: unknown }>(
      `Choose the tags from this list that best describe the task. ONLY choose from ` +
        `the list — never invent a tag. Reply with JSON {"tags": ["..."]}.${guide} ` +
        `List: ${JSON.stringify(vocabulary)}. Task: "${title.trim()}"`,
      { purpose: 'classify' },
    );
    // The allow-list IS the shared never-invent rule (agents/constrain.ts) — same
    // function the quick-add overlay and the memory pass use, so "what stops the model
    // inventing a tag" has exactly one answer. This surface caps nothing of its own:
    // after the case-insensitive dedupe an answer cannot exceed the vocabulary's own
    // size, so `vocabulary.length` is the no-op ceiling it has always had.
    return constrainToVocabulary(out.tags, vocabulary, vocabulary.length);
  } catch {
    return []; // Ollama down / unparseable → no suggestions, never throws
  }
}
