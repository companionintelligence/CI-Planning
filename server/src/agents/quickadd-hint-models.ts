/**
 * Which models quick add shows the owner's own corrections to (the "hint").
 *
 * Measured 2026-11-02 (docs/quick-add-hint-learning-curve-2026-11.md): of six models, three used the
 * hint (gemma3n:e4b, qwen2.5:3b, gemma3:4b gained three of twelve held-out titles by the third
 * correction and lost none), and three answered WORSE with it (qwen2.5:0.5b answered a number for the
 * category, gemma3:1b lost its valid direction, llama3.2:3b answered null). Size did not tell them
 * apart: llama3.2:3b (3.2B) broke where qwen2.5:3b (3.1B) worked. So the hint goes only to a model that
 * was measured, and every other model gets the stock prompt, byte for byte.
 *
 * `QUICK_ADD_HINT_MODELS` (comma separated model names) adds models, for an owner who has measured their
 * own. There is no wildcard on purpose: "every model" is the state that was measured to hurt half of them.
 *
 * Pure: no store, no Ollama. The route resolves which model quick add will ask (`quickAddModel`) and
 * passes the name here.
 */

/** Models the hint was measured on and helped. Exact names, as Ollama reports them. */
export const HINT_MODELS: readonly string[] = ['gemma3n:e4b', 'qwen2.5:3b', 'gemma3:4b'];

/** Case-insensitive, and a name with no tag is its `:latest`, as Ollama treats it. */
function normalise(name: string): string {
  const n = name.trim().toLowerCase();
  return n.includes(':') ? n : `${n}:latest`;
}

/** The measured models plus whatever `QUICK_ADD_HINT_MODELS` names, normalised, deduped, blanks dropped. */
export function hintModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.QUICK_ADD_HINT_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  return [...new Set([...HINT_MODELS, ...extra].map(normalise))];
}

/** Whether quick add should show the hint to `model`. A missing or empty name is no. */
export function modelUsesHint(model: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!model?.trim()) return false;
  return hintModels(env).includes(normalise(model));
}
