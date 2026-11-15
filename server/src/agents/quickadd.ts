import { generateJson, type ModelTier } from '../mcp/ollama.js';
import { resolveModel } from '../lib/models.js';
import type { ParsedQuick } from '../engine/quickadd.js';
import {
  directionGuide, isTimeOfDay, titleSuggestsComplex, isMotivation,
  PRIORITY_RUBRIC, DURATION_RUBRIC, TIME_OF_DAY_RUBRIC, COMPLEXITY_RUBRIC, MOTIVATION_RUBRIC,
} from './rubric.js';
import { constrainToVocabulary, constrainOne, type EnrichOut } from './constrain.js';
import type { TimeBlockDurationBounds, TimeBlockDurationEvidence } from '../services/timeblock-duration.js';

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
 *
 * 2026-11-02: the overlay is also handed the owner's OWN past corrections for the two
 * fields they correct, `categories` and `motivation` (`hints`, rendered by
 * services/classification-learning.ts; the caller fetches them, so this agent stays free of
 * services). The blocks sit LAST, after the "never invent" rule and just before the entry
 * (motivation's, then categories'), and not beside the fields they teach: next to their
 * fields they made a small model (gemma3:1b) mostly stop its JSON after three keys, keeping
 * direction, categories and tags and dropping the other six (isComplex, priority,
 * estimatedMinutes, timeOfDay, timeOfDayReason, motivation), while with the same blocks last
 * it answered every key. Measured 2026-11-02 with the live
 * harness, server/test/classification-hint-live.test.ts (the dated note under its gates has
 * the figures). An owner with no corrections gets today's prompt byte for byte. The
 * direction retry gets no hint, because direction is not something the owner's corrections
 * teach.
 */

/**
 * The tier quick add's classification runs on (the overlay call and its direction retry).
 *
 * QUALITY, not the fast tier every other `classify` caller uses (explicit `tier` beats the purpose's,
 * see `resolveCall`). Measured 2026-11-02 (docs/quickadd-quality-tier-2026-11.md): the fast default,
 * qwen2.5:0.5b, returned a category that was right on 20 of 60 answers for obvious titles and three of
 * the nine requested keys, while gemma3n:e4b, the quality default every default install already pulls,
 * was right on 60 of 60 and returned all nine. A pick that is mostly wrong is worse than none: the
 * owner has to correct it. The cost is a slower Describe-it preview: through the real route a call took
 * a median 1.4 to 1.8 s against 0.09 s, and the first one after the model was unloaded about 5.1 s
 * (this box, the model warm or unloaded; Ollama unloads an idle model after 5 minutes unless
 * OLLAMA_KEEP_ALIVE says otherwise). Only this agent moves: the fast tier stays what it was for every other caller, so planning's
 * generator (fast) is still not its own judge (quality).
 */
const QUICK_ADD_TIER: ModelTier = 'quality';

/**
 * The model quick add will ask for this owner: the same resolution `generateJson` does for the tier
 * (the owner's Settings choice, an env pin, the built-in default if installed, else auto-selected). The
 * route needs the name to decide whether the model is one the hint was measured on
 * (agents/quickadd-hint-models.ts); this is where the tier is known.
 */
export async function quickAddModel(owner?: string): Promise<string> {
  return resolveModel(QUICK_ADD_TIER, owner);
}

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

/**
 * What the model answered for `"categories"`, as the list `constrainToVocabulary` reads. The prompt
 * asks for a list, and the built-in fast model (qwen2.5:0.5b) answers one bare name instead
 * (`"categories": "leisure"`); gemma3:1b does on four calls in five. Measured 2026-11-02
 * (docs/classification-shape-fix-2026-11.md). `constrainToVocabulary` returns [] for a non-array,
 * so those installs got no category pick, no preview claim and nothing to learn from. A bare string
 * is read as ONE name and matched whole against the owner's categories: it is not split on commas
 * (a category name may contain one), so "health, leisure" still names nothing. It then goes through
 * the same never-invent rule as any list element. Anything else is handed on as it came.
 *
 * Why a parse and not a reworded prompt line: asking for a JSON array did make both models answer
 * arrays, and cost gemma3:1b keys (all nine on 93% of its calls, 57% and 71% with the two wordings
 * tried), where the parse changes nothing the model is shown. The prompt
 * is therefore unchanged, byte for byte, for every owner.
 *
 * Local to quick-add on purpose: the memory fill-in, the Monday scorer, the tag suggester and the
 * claim check still call `constrainToVocabulary` directly and still accept lists only, and a bare
 * string there is still no pick. They were not measured with this reading.
 */
function categoryAnswer(raw: unknown): unknown {
  return typeof raw === 'string' ? [raw] : raw;
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
  // casing comes from the vocabulary, not the model — agents/constrain.ts).
  const hasDirection = parsed.tags.some((t) => constrainOne(t, vocab.directions) !== null);
  if (!hasDirection) {
    const canonical = constrainOne(out.direction, vocab.directions);
    if (canonical && !have.has(canonical.toLowerCase())) {
      tags.push(canonical);
      have.add(canonical.toLowerCase());
    }
  }

  // Secondary tags: existing non-direction tags only, max two, deduped. Tags the parse
  // already carries are withdrawn from the OFFERED vocabulary rather than filtered out
  // afterwards, so a name the model merely echoes back can never spend one of the two
  // slots — the cap counts tags actually ADDED, as it always has.
  const offered = vocab.others.filter((t) => !have.has(t.toLowerCase()));
  for (const canonical of constrainToVocabulary(out.tags, offered, 2)) {
    tags.push(canonical);
    have.add(canonical.toLowerCase());
  }

  // Categories (Phase B): 1–3 of the owner's category names — its OWN axis, never
  // mixed into `tags` (a model pick of "finance" must become a category, not an
  // intention). Same constrained-vocabulary rule, same function, with a bare string read
  // as one name first (categoryAnswer). A parse that already carries categories (future
  // syntax) wins.
  let categories = parsed.categories;
  if (!categories?.length) {
    const picked = constrainToVocabulary(categoryAnswer(out.categories), vocab.categories ?? [], 3);
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

  // Motivation (0141, §3b): vocabulary-constrained like everything else here — an
  // answer outside me/us/them (incl. the model "explaining" instead) is dropped,
  // never coerced. A parse that already carries one (future syntax) wins.
  const motivation = parsed.motivation ?? (isMotivation(out.motivation) ? out.motivation : undefined);

  return {
    ...parsed,
    estimatedMinutes,
    priority,
    tags,
    ...(categories !== undefined ? { categories } : {}),
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(reason ? { timeOfDayReason: reason } : {}),
    ...(isComplex ? { isComplex } : {}),
    ...(motivation ? { motivation } : {}),
  };
}

// The direction definitions moved to agents/rubric.ts (2026-07-27) so the Auto-tag sweep
// and the memory pass classify the axis identically — three copies of "what Home means"
// is exactly how a classifier starts contradicting itself between surfaces.

/**
 * The owner's own past corrections, one rendered block per field
 * (`exemplarPrompt` output, which opens and closes with a newline). The caller fetches them
 * (routes/tasks.ts `enrichEntry`); this agent only places them, last: after the "never
 * invent" rule, just before the entry, motivation's block first. Not beside their fields,
 * see the header.
 */
export interface QuickHints {
  /** For `categories`. '' or absent adds nothing. Ignored when the owner has no
   *  categories: that line is not asked then, and a lesson about it would have no field. */
  category?: string;
  /** For `motivation`. '' or absent adds nothing. */
  motivation?: string;
}

export async function enrichQuick(
  text: string,
  parsed: ParsedQuick,
  vocab: QuickVocab = { directions: [], others: [] },
  hints: QuickHints = {},
  durationContext?: { bounds: TimeBlockDurationBounds; evidence: TimeBlockDurationEvidence | null },
): Promise<ParsedQuick> {
  const hasCats = (vocab.categories?.length ?? 0) > 0;
  // Layout matters as much as wording here. Measured 2026-07-27 against llama3.2: with
  // the schema up front and all four rubrics stacked at the end, the LAST rule
  // (complexity) was reliably ignored — "Plan a week-long trip to Japan" came back
  // isComplex:false, while the same rule in a short prompt answered true. So each rule
  // now sits IMMEDIATELY AFTER the field it governs. A 3B model follows adjacent
  // instructions far better than a rulebook it has to cross-reference.
  //
  // The owner's corrections are the exception: they go LAST, directly before the entry, as
  // the memory pass puts them last too (services/task-enrich.ts). Beside their fields they
  // cost gemma3:1b most of its JSON (header). Each block brings its own newline at both
  // ends, so one blank line precedes the block and the entry follows it directly; nothing
  // is added here. '' or absent adds no bytes, so an owner with no corrections gets the
  // stock prompt byte for byte. The categories block goes with its line when that is not
  // asked.
  const lessons = (hints.motivation || '') + (hasCats ? hints.category || '' : '');
  const out = await generateJson<EnrichOut>(
    `Classify this quick task entry. Reply with JSON with exactly these keys.\n` +
      `"direction": REQUIRED — exactly one of ${JSON.stringify(vocab.directions)}. ` +
      `Every task has a direction, always choose one.${directionGuide(vocab.directions)}\n` +
      `"isComplex": true or false. ${COMPLEXITY_RUBRIC}\n` +
      `"priority": 1-4. ${PRIORITY_RUBRIC}\n` +
      `"estimatedMinutes": a number or null. ${durationContext
        ? `For this scheduled time block, quickly assess the amount of work implied by the title and make an educated duration estimate. Choose a multiple of 5 between ${durationContext.bounds.minMinutes} and ${durationContext.bounds.maxMinutes} minutes, inclusive; do not return null. Use roughly 15m for a brief call/message, 30m for a small errand or task, 30–60m for a meeting, and 60–90m for focused work; scale for the number of steps and scope in the title. ${durationContext.evidence
          ? `Prior owner history is available: ${durationContext.evidence.samples} completed ${durationContext.evidence.basis} item(s) took a median of ${durationContext.evidence.minutes} minutes. Use that as the strongest signal when it fits this block; otherwise assess the title itself. `
          : ''}`
        : DURATION_RUBRIC}\n` +
      `"timeOfDay": one of "morning","afternoon","evening","any". ${TIME_OF_DAY_RUBRIC}\n` +
      `"timeOfDayReason": a few words on why, or null.\n` +
      `"motivation": one of "me","us","them", or null. ${MOTIVATION_RUBRIC}\n` +
      (hasCats ? `"categories": 1-3 life areas from ${JSON.stringify(vocab.categories)}, best fit first.\n` : '') +
      `"tags": up to 2 from ${JSON.stringify(vocab.others.slice(0, 60))}, else [].\n` +
      `Choose direction/categories/tags ONLY from the given lists — never invent.\n` +
      lessons +
      `Entry: "${text}"`,
    { purpose: 'classify', tier: QUICK_ADD_TIER }
  );

  let merged = mergeEnrichment(parsed, out, vocab);

  // Second chance (owner request: ALWAYS attempt a direction): when the first pass
  // yielded none, ask once more with a single-field prompt — small models answer a
  // narrow question far more reliably than a wide one. Still constrained: an
  // invalid answer is dropped by the same merge, never invented.
  const hasDirection = merged.tags.some((t) => constrainOne(t, vocab.directions) !== null);
  if (!hasDirection && vocab.directions.length > 0) {
    const retry = await generateJson<{ direction?: string | null }>(
      `Which area of life does this task belong to? Answer with JSON ` +
        `{"direction": <exactly one of ${JSON.stringify(vocab.directions)}>}.${directionGuide(vocab.directions)} ` +
        `Task: "${text}"`,
      { purpose: 'classify', tier: QUICK_ADD_TIER }
    );
    merged = mergeEnrichment(merged, { direction: retry.direction }, vocab);
  }

  return merged;
}

/**
 * Estimate a newly created objective task without inheriting the source task's
 * start time or duration. This is deliberately narrow: the parent's other settings
 * are copied by the objective route, while the model only returns minutes.
 */
export async function estimateObjectiveTaskMinutes(title: string, parentTitle?: string | null): Promise<number> {
  const context = parentTitle?.trim()
    ? `It belongs to the same objective as the related task "${parentTitle.trim()}". Use this only to understand context; estimate this task on its own.`
    : 'There is no related task context.';
  const out = await generateJson<{ estimatedMinutes?: unknown }>(
    `Estimate how long this task will take one person to perform. Reply only as JSON: {"estimatedMinutes": number}. ` +
      `Always choose a useful estimate; do not return null. Use a multiple of 5 from 5 to 240 minutes. ` +
      `Use 15 for a brief message or call, around 30 for a small errand or focused task, 30–60 for a meeting, ` +
      `and 60–90 for substantial focused work. Increase the estimate for multiple steps or larger scope. ` +
      `Do not reuse another task's duration. ${context}\nTask: "${title.trim()}"`,
    { purpose: 'classify' },
  );
  const value = Number(out.estimatedMinutes);
  if (!Number.isFinite(value)) throw new Error('The model returned no task duration estimate');
  return Math.min(240, Math.max(5, Math.round(value / 5) * 5));
}
