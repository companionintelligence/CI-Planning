/**
 * The qualifiers every classifier prompt shares — ONE source of truth.
 *
 * Each of these exists because a bare label under-specifies the axis for a small local
 * model. `"priority 1-5, 1 is highest"` is not a rubric: the model has no way to know what
 * earns a 1, so it guesses high and the priority axis degrades into noise. `"Work | Home |
 * Community"` without definitions force-fits "Dad's birthday" to Work. In both cases the
 * fix is the same — say what the bucket MEANS and what the default is.
 *
 * Kept in one module (rather than inline in each agent) so the quick-add classifier, the
 * Auto-tag sweep, and the memory enrichment pass cannot drift into three different
 * definitions of the same word. Every string here is prompt text; changing one changes
 * model behaviour, so treat edits as behaviour changes and re-test against a live model.
 *
 * ⚠️ Test any prompt change against a REAL model: a `thinking`-capable model returns an
 * empty string under `format:"json"`, which reads exactly like "the model had nothing to
 * say" (see lib/models.ts — selection excludes them, but the failure is silent).
 */

// ── Direction (Work / Home / Community) ──────────────────────────────────────
// Fixed by provisioning (lib/owners.ts). The three names are stable; only their
// meanings need spelling out.

const DIRECTION_HINTS: Record<string, string> = {
  work: 'Work — job/professional obligations (meetings, deliverables, career tasks).',
  home: 'Home — personal, household, and family life (errands, chores, family events like birthdays, self-care).',
  community: 'Community — social and civic life outside work/family (friends, volunteering, group events).',
};

/**
 * Definitions for whichever directions the owner actually has, as a prompt fragment.
 * Returns '' when none of the names are recognised, so a renamed/custom direction set
 * degrades to the ungrounded prompt rather than emitting a misleading definition.
 */
export function directionGuide(directions: string[]): string {
  const lines = directions
    .map((d) => DIRECTION_HINTS[d.toLowerCase()])
    .filter((h): h is string => Boolean(h));
  return lines.length ? ` Direction meanings — ${lines.join(' ')}` : '';
}

// ── Motivation (design §3b) — who the work is for ─────────────────────────────
// The rule names the null default and bans the middle as a shrug: 'us' is a
// POSITIVE claim of shared benefit, and a lazy classifier that drifts to the
// middle would quietly destroy the axis's signal (the me↔them poles are what the
// dot product reads; a wrong 'us' is merely inert, but a habitual 'us' is blind).
export const MOTIVATION_VALUES = ['me', 'us', 'them'] as const;
export type Motivation = (typeof MOTIVATION_VALUES)[number];
export function isMotivation(v: unknown): v is Motivation {
  return typeof v === 'string' && (MOTIVATION_VALUES as readonly string[]).includes(v);
}
export const MOTIVATION_RUBRIC =
  `"me" = the user's own goals, growth, legacy, or personal success. ` +
  `"them" = primarily for other people (helping, caregiving, volunteering, obligations to family/friends/colleagues). ` +
  `"us" = genuinely BOTH at once — answer "us" only when the shared benefit is explicit, never as a middle-ground guess. ` +
  `null when the entry does not say who it is for. When unsure, answer null — never guess.`;

// ── Priority (1-5; the UI exposes four buckets) ───────────────────────────────
// P1/P2/P3/Later per TaskCard.tsx. The "when unsure → 3" rule is load-bearing: without
// it small models cluster on 1-2 and every task looks urgent.

// Measured 2026-07-27 against llama3.2: an earlier wording ended "do NOT guess high",
// and the model obediently collapsed almost everything to 4 — "Dad's birthday dinner"
// came back optional-someday. Both tails are failure modes, so the rule now names 3 as
// the default and rules out BOTH extremes, with 4 explicitly reserved for things the
// user would not mind never happening.
export const PRIORITY_RUBRIC =
  'Priority means: ' +
  '1 = urgent AND important — a hard deadline within about 48 hours, or someone else is ' +
  'blocked until it is done; there is a real consequence if it slips today. ' +
  '2 = important but not urgent — it matters and has real consequences, but no imminent deadline. ' +
  '3 = normal — it should happen, and nothing breaks if it slips a few days. ' +
  '4 = optional — only for things the user would not mind never happening at all. ' +
  'THE DEFAULT IS 3. Most tasks are 3. Anything the user clearly intends to do is at ' +
  'least 3, even if it is small or personal. Use 1 only with a real deadline or someone ' +
  'blocked; use 4 only for genuine maybes ("someday", "if I get around to it"). ' +
  'When in doubt, answer 3.';

// ── Duration ─────────────────────────────────────────────────────────────────
// The engine already substitutes 30m for a null estimate (autoplan.ts DEFAULT_EST_MIN),
// so a confident wrong guess is worse than an honest null — say so explicitly.

export const DURATION_RUBRIC =
  'For estimatedMinutes, judge how long the task actually takes as a multiple of 5. ' +
  'Rough anchors: a phone call or quick message ≈ 15; an errand ≈ 30 including travel; ' +
  'a meeting ≈ 30-60; focused writing, study, or deep work ≈ 60-90. ' +
  'If the entry does not give you enough to tell, answer null rather than guessing.';

// ── Best time of day ─────────────────────────────────────────────────────────
// D3: a BAND by default; a clock time only when the user's own words imply one. The band
// feeds the client's gap-finder (propose-slot.ts), which picks a real open slot inside it,
// so this composes with direction windows and busy blocks instead of overriding them.
// Writing task_time from a band would hard-pin the task via the AD1 pin pass.

export const TIME_OF_DAY_RUBRIC =
  'For timeOfDay, choose when the task is best done: ' +
  '"morning" for focus-heavy or energy-demanding work and anything that must happen early; ' +
  '"afternoon" for meetings, errands, and collaborative work; ' +
  '"evening" for personal, family, and wind-down tasks; ' +
  '"any" when nothing about the task suggests a time. ' +
  'This is a BAND, not a clock time — never invent a specific hour.';

/** The four bands the model may return. Anything else is dropped by the merge. */
export const TIME_OF_DAY_VALUES = ['morning', 'afternoon', 'evening', 'any'] as const;
export type TimeOfDay = (typeof TIME_OF_DAY_VALUES)[number];

/** Narrowing guard for a model-supplied band (used by the merge paths). */
export function isTimeOfDay(v: unknown): v is TimeOfDay {
  return typeof v === 'string' && (TIME_OF_DAY_VALUES as readonly string[]).includes(v);
}

// ── Complexity (gates the suggest-only subtask call) ──────────────────────────
// Deliberately narrow: the subtask pass costs a second round-trip, so "complex" has to
// mean multi-step, not merely important.

// Measured 2026-07-27 against llama3.2: the abstract phrasing alone returned false even
// for "Plan a week-long trip to Japan" — the canonical complex task — which would have
// left the subtask feature permanently dark. Concrete rules helped; worked EXAMPLES help
// more (a 3B model imitates far better than it deduces), so both are here. The rubric is
// still only half the protection — see titleSuggestsComplex below.
/**
 * The complexity DEFINITION, deliberately FIELD-NEUTRAL: it never names the JSON key, so
 * each caller supplies its own leading sentence naming the field it actually asks for.
 *
 * That split is not cosmetic. `agents/subtasks.ts` asks for `isBreakdownUseful`, not
 * `isComplex`, and (measured, see `subtasks.ts:25-31`) llama3.2-3B ignores an instruction
 * that no schema field backs — so pasting an "isComplex" sentence into that prompt would
 * quietly disarm the boolean gate that makes the model refuse to pad "Call the dentist"
 * into fake steps. Everything after the field sentence is shared, because the definition
 * and its worked examples are the same question at both sites; the "Set it false…"
 * sentence reads back to whichever field the caller just named.
 *
 * ⚠️ Changing this text changes model behaviour at BOTH call sites at once — that is the
 * point of it being one string, and the reason a change here needs the live before/after
 * protocol in `docs/complexity-rubric-measurement-2026-08.md`, not a code review.
 */
export const COMPLEXITY_DEFINITION =
  'finishing the task takes several distinct steps that a person ' +
  'would want written out — planning a trip, organising an event, moving house, running ' +
  'a project, anything spanning days or involving several people. Verbs like plan, ' +
  'organise, launch, prepare, research, or build usually mean true. ' +
  'Set it false for anything done in one sitting: a call, an email, an errand, a payment, ' +
  'a single chore. ' +
  'Examples: "Plan a trip to Japan" → true; "Organize the team offsite" → true; ' +
  '"Research and launch the pricing page" → true; "Call the dentist" → false; ' +
  '"Pay the electricity bill" → false.';

/** Quick-add's field sentence + the shared definition. Byte-identical to the pre-split
 *  constant — `test/enrichment-rubric.test.ts` pins the old literal so it stays that way. */
export const COMPLEXITY_RUBRIC = `Set isComplex true when ${COMPLEXITY_DEFINITION}`;

// The rubric's verb rule, enforced in code. Measured: llama3.2 applies its own verb rule
// about 4 times in 6 — it missed "Organize the team offsite" and "Research and launch the
// new pricing page" even with the rule in the prompt. Since the rule is mechanical
// (leading verb + a real object), there is no reason to leave it to a 3B model at all:
// the caller ORs this with the model's answer, so the model can only ADD complex verdicts
// the verb list misses ("Move house", "Team offsite prep"), never lose these.
// Kept to STRONG planning verbs on purpose — a false positive costs a background LLM call
// and possibly silly chips; a broad list ("make", "get", "do") would fire constantly.
// Every verb COMPLEXITY_DEFINITION names must be here — the code twin drifting from the
// prompt's own list is how "Prepare the annual budget review" got missed on first
// measurement. The verb sentence now reaches BOTH prompts via the shared definition, so
// this invariant covers the subtask suggester too; it is asserted in
// test/enrichment-rubric.test.ts rather than left to a reader.
const COMPLEX_LEAD_VERBS = new Set([
  'plan', 'organize', 'organise', 'launch', 'prepare', 'research', 'build',
  'coordinate', 'arrange', 'develop', 'migrate', 'renovate', 'host',
]);

// The rubric's "moving house" example, as lead phrases. Deliberately NOT a bare 'move'
// verb — "Move the couch to the garage" is one action, and a generic 'move' would fire
// on every such errand.
const COMPLEX_LEAD_PHRASES = ['move house', 'move out', 'move into', 'move to a new'];

/**
 * Deterministic complexity signal from the title alone: a strong planning verb in lead
 * position and enough words to name a real undertaking ("Plan a week-long trip to
 * Japan"), not a bare verb-object pair ("plan dinner"). OR this with the model's
 * `isComplex` — never use it to overrule a model's `true`.
 */
export function titleSuggestsComplex(title: string): boolean {
  const lower = title.toLowerCase().trim();
  const words = lower.split(/[^a-z0-9-]+/).filter(Boolean);
  if (words.length >= 4 && COMPLEX_LEAD_VERBS.has(words[0])) return true;
  return COMPLEX_LEAD_PHRASES.some((p) => lower.startsWith(p));
}
