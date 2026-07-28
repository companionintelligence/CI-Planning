import { generateJson } from '../mcp/ollama.js';

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
 * Returns `[]` on any failure — Ollama down, bad JSON, or a model that answers with
 * something other than an array of strings. The caller shows no chips and says nothing.
 */

/** Upper bound on suggestions — more than this is a wall of text, not a plan. */
const MAX_SUBTASKS = 6;

export async function suggestSubtasks(title: string, context = ''): Promise<string[]> {
  if (!title.trim()) return [];
  try {
    const out = await generateJson<{ subtasks?: unknown }>(
      `Break this task into the steps someone would actually do, in order. ` +
        `Reply with JSON {"subtasks": ["...", "..."]}. ` +
        `Give 3 to ${MAX_SUBTASKS} steps. Each step must be a short imperative phrase ` +
        `(start with a verb), be doable on its own, and be a real part of finishing the ` +
        `task — do not pad the list, and do not restate the task itself as a step. ` +
        // Asked for, but do NOT rely on it: measured against llama3.2, "Call the dentist"
        // still came back as "Dial the phone number" / "Leave a message". A 3B model wants
        // to be helpful more than it wants to decline. The REAL protection against
        // brainstorming a one-step task is the `isComplex` gate on the caller — this line
        // only helps on stronger models and costs nothing when ignored.
        `If the task is a single action one person finishes in one sitting, or you cannot ` +
        `break it into meaningful steps, reply with {"subtasks": []} instead. ` +
        (context ? `Background that may help: "${context.slice(0, 600)}". ` : '') +
        `Task: "${title.trim()}"`,
      { tier: 'small', temperature: 0.3, timeoutMs: 20_000 },
    );
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
  } catch {
    return []; // Ollama down / unparseable → no suggestions, never throws
  }
}
