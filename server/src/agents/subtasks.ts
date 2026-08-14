import { generateJson, llmOrNull } from '../mcp/ollama.js';
import { COMPLEXITY_DEFINITION } from './rubric.js';

/**
 * Brainstorm subtasks for a task the classifier flagged complex (handoff D5).
 *
 * ⚠️ SUGGEST-ONLY, and that is a hard rule, not a default. Nothing in this module or its
 * callers may create a subtask: the strings come back, the wizard renders them as pickable
 * chips, and only an explicit user pick goes through the normal `parent_id` create path.
 * A task silently sprouting five children the user never asked for is worse than no
 * feature at all — it turns their list into someone else's guesses.
 *
 * A SECOND call on purpose (gated on `isComplex` from the main classifier) so a simple
 * "call the dentist" never pays for a round-trip it cannot use.
 *
 * Returns `[]` on the degradable failures — Ollama down, bad JSON, or a model that
 * answers with something other than an array of strings. The caller shows no chips and
 * says nothing; the degrade itself is logged once (`llmOrNull`).
 */

/** Upper bound on suggestions — more than this is a wall of text, not a plan. */
const MAX_SUBTASKS = 6;

export async function suggestSubtasks(title: string, context = ''): Promise<string[]> {
  if (!title.trim()) return [];
  // Refusal is a BOOLEAN FIELD, not an instruction. Measured 2026-07-28: "reply with
  // {"subtasks": []} for single-action tasks" was ignored by llama3.2-3B AND llama3.1-8B
  // alike — under format:json with an array in the schema, a model fills the array. Give
  // it a boolean that licenses saying no and it uses it: with `isBreakdownUseful` +
  // worked examples, the 3B refuses "Call the dentist" and still breaks down the real
  // projects. The caller's isComplex gate stays the FIRST protection.
  //
  // The definition after the field name is COMPLEXITY_DEFINITION — the SAME string
  // quick-add's `isComplex` rubric is built from, so a retune moves both at once instead
  // of leaving two copies to drift (they already had: this prompt used to carry its own
  // reworded restatement with four of the five worked examples). The FIELD NAME stays
  // here on purpose: llama3.2-3B ignores instructions no schema field backs, so a
  // borrowed "Set isComplex true when…" sentence would disarm the refusal gate above.
  // Adopting the richer shared list fixed the residual "Pay the electricity bill" false
  // positive; measured before/after in docs/complexity-rubric-measurement-2026-08.md.
  const out = await llmOrNull('suggestSubtasks', () =>
    generateJson<{ isBreakdownUseful?: unknown; subtasks?: unknown }>(
      `Break this task into the steps someone would actually do, in order. ` +
        `Reply with JSON {"isBreakdownUseful": <true|false>, "subtasks": ["...", "..."]}. ` +
        `isBreakdownUseful is true when ${COMPLEXITY_DEFINITION} ` +
        `When true, subtasks has 3 to ${MAX_SUBTASKS} steps. Each step must be a short ` +
        `imperative phrase (start with a verb), be doable on its own, and be a real part ` +
        `of finishing the task — do not pad the list, and do not restate the task itself ` +
        `as a step. When false, subtasks is []. ` +
        (context ? `Background that may help: "${context.slice(0, 600)}". ` : '') +
        `Task: "${title.trim()}"`,
      // `brainstorm` is a fast-tier policy: the boolean-gate refusal works at 3B (measured),
      // and the 3B's steps for genuinely complex tasks were as good as the 8B's — no reason
      // to pay 8B latency.
      { purpose: 'brainstorm' },
    ),
  );
  if (out === null) return []; // Ollama down / unparseable → no chips, one warn logged
  // The model judged a breakdown unhelpful — honor it. (Explicit !== true: a missing or
  // junk field from an older/looser model falls through to the array, which older
  // prompts still fill; the cleanup below then applies as before.)
  if (out.isBreakdownUseful === false) return [];
  if (!Array.isArray(out.subtasks)) return [];
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const raw of out.subtasks) {
    if (picked.length >= MAX_SUBTASKS) break;
    if (typeof raw !== 'string') continue;
    // Models like to number their own list ("1. Book the flight") — the UI numbers the
    // chips itself, so strip any leading ordinal/bullet rather than double-numbering.
    const s = raw.trim().replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim().slice(0, 120);
    const key = s.toLowerCase();
    // Drop a "step" that merely echoes the parent title — pure padding.
    if (!s || seen.has(key) || key === title.trim().toLowerCase()) continue;
    seen.add(key);
    picked.push(s);
  }
  // Fewer than two "steps" is not a breakdown; suppress rather than show a lone chip.
  return picked.length >= 2 ? picked : [];
}
