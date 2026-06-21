import { generateJson } from '../mcp/ollama.js';

/**
 * Best-effort LLM tag suggestion for the New Task wizard, CONSTRAINED to the
 * user's existing tag vocabulary — it never invents new tags. Returns `[]` on any
 * failure (Ollama unavailable, bad JSON, empty input), so the wizard degrades to
 * its deterministic heuristic with no error surfaced. Keeps task creation
 * reproducible: this only ever *adds* suggestions the user can toggle off.
 */
export async function suggestTags(title: string, vocabulary: string[]): Promise<string[]> {
  if (!title.trim() || vocabulary.length === 0) return [];
  try {
    const out = await generateJson<{ tags?: unknown }>(
      `Choose the tags from this list that best describe the task. ONLY choose from ` +
        `the list — never invent a tag. Reply with JSON {"tags": ["..."]}. ` +
        `List: ${JSON.stringify(vocabulary)}. Task: "${title.trim()}"`,
      { tier: 'small', temperature: 0.1, timeoutMs: 15_000 },
    );
    const allow = new Set(vocabulary);
    return Array.isArray(out.tags)
      ? out.tags.filter((t): t is string => typeof t === 'string' && allow.has(t))
      : [];
  } catch {
    return []; // Ollama down / unparseable → no suggestions, never throws
  }
}
