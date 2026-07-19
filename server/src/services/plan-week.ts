import { renderCopy } from '../agents/render-copy.js';

/**
 * FTUE · T7 (#343) — the Plan-Week hybrid follow-up layer.
 *
 * Sits ON TOP OF a branch's own fixed deterministic question + top-3 options (the
 * caller — T3/T4/T5 — supplies both as `fallbackQuestion`/`fallbackOptions`). This
 * service never authors that fallback and never invents a fourth option; it only
 * asks `renderCopy` to phrase the question and, when that succeeds, each option in
 * turn. Every human-facing line routes through `renderCopy` — no `generate()` /
 * `generateJson()`, no tools, no websearch (local-first invariant).
 *
 * Never throws: `renderCopy` is Ollama-down-safe, so the worst case is `source:
 * 'fallback'` with the caller's own deterministic text echoed back verbatim.
 */

export interface PlanWeekNextStepInput {
  /** The active T1 entry_branch (or any string discriminator) — grounds the model, not validated against an enum here. */
  branch: string;
  /** Flat deterministic facts the caller wants reflected in the phrasing. */
  context?: Record<string, unknown>;
  fallbackQuestion: string;
  /** Exactly 3 — enforced by the route before this is called. */
  fallbackOptions: string[];
}

export interface PlanWeekNextStepResult {
  question: string;
  options: string[];
  source: 'model' | 'fallback';
}

const MAX_FACTS_LEN = 2000;

function serializeFacts(input: PlanWeekNextStepInput): string {
  const raw = JSON.stringify({ branch: input.branch, ...(input.context ?? {}) });
  return raw.length > MAX_FACTS_LEN ? raw.slice(0, MAX_FACTS_LEN) : raw;
}

/**
 * 1. Render the question. If the model is unusable (Ollama down or every draft
 *    gate-rejected), `renderCopy` already returns `source: 'fallback'` — short-circuit
 *    there with zero option-level calls, since we already know the model can't be used.
 * 2. Otherwise render each of the 3 options SEQUENTIALLY (not `Promise.all`): sequential
 *    calls let `plan_week_option`'s per-surface anti-repetition window make the three
 *    chips distinct, and avoid concurrent `copy_history` writes racing each other.
 * 3. `source` reflects the QUESTION render only — an option that individually degrades
 *    to its own fallback text does not flip the step back to 'fallback'.
 */
export async function planWeekNextStep(input: PlanWeekNextStepInput): Promise<PlanWeekNextStepResult> {
  const facts = serializeFacts(input);

  const questionRendered = await renderCopy('plan_week_followup', {
    facts,
    fallback: input.fallbackQuestion,
  });

  if (questionRendered.source === 'fallback') {
    return { question: input.fallbackQuestion, options: input.fallbackOptions, source: 'fallback' };
  }

  const options: string[] = [];
  for (const seed of input.fallbackOptions) {
    const rendered = await renderCopy('plan_week_option', {
      facts: `${facts}, seed="${seed}"`,
      fallback: seed,
    });
    options.push(rendered.text);
  }

  return { question: questionRendered.text, options, source: 'model' };
}
